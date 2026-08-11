import { createServer } from "node:http"
import { Readable } from "node:stream"

const MAX_BODY_BYTES = 10 * 1024 * 1024
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
])

function writeJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  })
  response.end(body)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    request.on("data", (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", reject)
  })
}

function bearerToken(request) {
  const header = request.headers.authorization
  if (typeof header !== "string") return ""
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1] ?? ""
}

function modelList(models) {
  return {
    object: "list",
    data: models.map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "openai",
    })),
  }
}

export class BridgeServer {
  constructor(config, auth, { fetchImpl = fetch } = {}) {
    this.config = config
    this.auth = auth
    this.fetchImpl = fetchImpl
    this.server = undefined
  }

  async listen() {
    this.server = createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        if (!response.headersSent) writeJson(response, 500, { error: { message: error.message, type: "bridge_error" } })
        else response.destroy(error)
      })
    })

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server.off("listening", onListening)
        reject(error)
      }
      const onListening = () => {
        this.server.off("error", onError)
        resolve()
      }
      this.server.once("error", onError)
      this.server.once("listening", onListening)
      this.server.listen(this.config.port, "127.0.0.1")
    })

    const address = this.server.address()
    return typeof address === "object" && address ? address.port : this.config.port
  }

  async close() {
    if (!this.server) return
    const server = this.server
    this.server = undefined
    await new Promise((resolve) => server.close(() => resolve()))
  }

  isAuthorized(request) {
    return !this.config.apiKey || bearerToken(request) === this.config.apiKey
  }

  async handle(request, response) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")

    if (request.method === "GET" && url.pathname === "/healthz") {
      let authStatus
      try {
        authStatus = await this.auth.status()
      } catch {
        authStatus = { loggedIn: false }
      }
      writeJson(response, 200, { ok: true, loggedIn: authStatus.loggedIn })
      return
    }

    if (!this.isAuthorized(request)) {
      response.setHeader("WWW-Authenticate", "Bearer")
      writeJson(response, 401, { error: { message: "Invalid bridge API key", type: "authentication_error" } })
      return
    }

    if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      writeJson(response, 200, modelList(this.config.models))
      return
    }

    if (request.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/responses")) {
      await this.proxyResponses(request, response)
      return
    }

    if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
      writeJson(response, 501, {
        error: {
          message: "This bridge exposes the Responses API. Configure Crush with provider type 'openai' so it uses /v1/responses.",
          type: "unsupported_protocol",
        },
      })
      return
    }

    writeJson(response, 404, { error: { message: "Not found", type: "invalid_request_error" } })
  }

  async proxyResponses(request, response) {
    const rawBody = await readBody(request)
    let body
    try {
      body = JSON.parse(rawBody)
    } catch {
      writeJson(response, 400, { error: { message: "Request body must be valid JSON", type: "invalid_request_error" } })
      return
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.model !== "string") {
      writeJson(response, 400, { error: { message: "Request body must contain a model", type: "invalid_request_error" } })
      return
    }

    const codexBody = { ...body }
    delete codexBody.max_output_tokens
    const serializedCodexBody = JSON.stringify(codexBody)

    let token
    try {
      token = await this.auth.ensureValid()
    } catch (error) {
      writeJson(response, 401, { error: { message: error.message, type: "authentication_error" } })
      return
    }

    let upstream
    try {
      upstream = await this.sendToCodex(token, serializedCodexBody, request)
    } catch (error) {
      writeJson(response, 502, { error: { message: `Codex request failed: ${error.message}`, type: "upstream_error" } })
      return
    }

    if (upstream.status === 401) {
      await upstream.body?.cancel().catch(() => {})
      try {
        token = await this.auth.forceRefresh()
        upstream = await this.sendToCodex(token, serializedCodexBody, request)
      } catch (error) {
        writeJson(response, 401, { error: { message: `OAuth refresh failed: ${error.message}`, type: "authentication_error" } })
        return
      }
    }

    await this.pipeResponse(upstream, response)
  }

  async sendToCodex(token, body, request) {
    const headers = new Headers({
      Authorization: `Bearer ${token.access}`,
      "Content-Type": "application/json",
      Accept: request.headers.accept ?? "text/event-stream",
      "User-Agent": this.config.userAgent,
      originator: this.config.originator,
    })
    if (token.accountId) headers.set("ChatGPT-Account-Id", token.accountId)

    const sessionId = request.headers["session-id"]
    if (typeof sessionId === "string" && sessionId) headers.set("session-id", sessionId)

    return this.fetchImpl(this.config.endpoint, {
      method: "POST",
      headers,
      body,
    })
  }

  async pipeResponse(upstream, response) {
    const headers = {}
    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) headers[key] = value
    })
    response.writeHead(upstream.status, headers)
    if (!upstream.body) {
      response.end()
      return
    }
    Readable.fromWeb(upstream.body).pipe(response)
  }
}
