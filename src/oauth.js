import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { mkdir, readFile, chmod, rename, unlink, writeFile } from "node:fs/promises"
import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { spawn } from "node:child_process"
import { URL } from "node:url"

const CALLBACK_PATH = "/auth/callback"
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000
const EXPIRY_SKEW_MS = 60 * 1000

function base64Url(value) {
  return Buffer.from(value).toString("base64url")
}

function randomState() {
  return base64Url(randomBytes(32))
}

function createPkce() {
  const verifier = base64Url(randomBytes(32))
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

function parseJwtClaims(token) {
  if (typeof token !== "string") return undefined
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
  } catch {
    return undefined
  }
}

export function extractAccountId(tokens) {
  const candidates = [tokens?.id_token, tokens?.access_token]
  for (const token of candidates) {
    const claims = parseJwtClaims(token)
    if (!claims) continue
    const accountId =
      claims.chatgpt_account_id ??
      claims["https://api.openai.com/auth"]?.chatgpt_account_id ??
      claims.organizations?.[0]?.id
    if (accountId) return accountId
  }
  return undefined
}

export function parseAuthorizationInput(value) {
  const input = String(value ?? "").trim()
  if (!input) return { code: "", state: "" }

  if (/^https?:\/\//i.test(input)) {
    try {
      const url = new URL(input)
      return { code: url.searchParams.get("code") ?? "", state: url.searchParams.get("state") ?? "" }
    } catch {
      return { code: "", state: "" }
    }
  }

  if (input.includes("code=")) {
    const params = new URLSearchParams(input.replace(/^.*\?/, ""))
    return { code: params.get("code") ?? "", state: params.get("state") ?? "" }
  }

  if (input.includes("#")) {
    const [code, state] = input.split("#", 2)
    return { code, state }
  }

  return { code: input, state: "" }
}

export function createAuthorizationFlow(config) {
  const pkce = createPkce()
  const state = randomState()
  const redirectUri = `http://localhost:${config.oauthPort}${CALLBACK_PATH}`
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: config.originator,
  })

  return {
    url: `${config.issuer}/oauth/authorize?${params.toString()}`,
    redirectUri,
    state,
    verifier: pkce.verifier,
  }
}

async function requestToken(config, values, fetchImpl) {
  const response = await fetchImpl(`${config.issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  })

  if (!response.ok) {
    const message = (await response.text()).slice(0, 500)
    throw new Error(`OAuth token request failed (${response.status}): ${message}`)
  }

  return response.json()
}

function normalizeToken(payload, previous) {
  const access = payload.access_token
  const refresh = payload.refresh_token ?? previous?.refresh
  if (!access || !refresh) throw new Error("OAuth response did not contain access and refresh tokens")

  const expiresIn = Number(payload.expires_in ?? 3600)
  return {
    access,
    refresh,
    expires: Date.now() + Math.max(expiresIn, 60) * 1000,
    accountId: extractAccountId(payload) ?? previous?.accountId,
  }
}

export async function exchangeAuthorizationCode(config, code, verifier, fetchImpl = fetch) {
  const payload = await requestToken(config, {
    grant_type: "authorization_code",
    client_id: config.clientId,
    code,
    code_verifier: verifier,
    redirect_uri: `http://localhost:${config.oauthPort}${CALLBACK_PATH}`,
  }, fetchImpl)
  return normalizeToken(payload)
}

export async function refreshAccessToken(config, token, fetchImpl = fetch) {
  const payload = await requestToken(config, {
    grant_type: "refresh_token",
    refresh_token: token.refresh,
    client_id: config.clientId,
  }, fetchImpl)
  return normalizeToken(payload, token)
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character])
}

function callbackPage(title, message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`
}

function startCallbackServer(config, state) {
  let resolveCode
  let rejectCode
  let timeout
  let isListening = false
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
    timeout = setTimeout(() => reject(new Error("OAuth callback timed out")), CALLBACK_TIMEOUT_MS)
  })

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://localhost:${config.oauthPort}`)
    if (url.pathname !== CALLBACK_PATH) {
      response.writeHead(404)
      response.end("Not found")
      return
    }

    const oauthError = url.searchParams.get("error")
    if (oauthError) {
      const description = url.searchParams.get("error_description") ?? oauthError
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
      response.end(callbackPage("ChatGPT login failed", description))
      rejectCode(new Error(description))
      return
    }

    const code = url.searchParams.get("code")
    const returnedState = url.searchParams.get("state")
    if (!code) {
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
      response.end(callbackPage("ChatGPT login failed", "No authorization code was returned."))
      rejectCode(new Error("OAuth callback did not contain an authorization code"))
      return
    }
    if (returnedState !== state) {
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
      response.end(callbackPage("ChatGPT login failed", "OAuth state did not match."))
      rejectCode(new Error("OAuth state mismatch"))
      return
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    response.end(callbackPage("ChatGPT login complete", "You can close this window and return to the terminal."))
    resolveCode(code)
  })

  const listening = new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.off("error", onError)
      isListening = true
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(config.oauthPort, "127.0.0.1")
  })

  return {
    server,
    codePromise,
    listening,
    close: async () => {
      clearTimeout(timeout)
      if (!isListening) return
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" })
    child.on("error", () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

async function readLine(prompt) {
  const readline = createInterface({ input, output })
  try {
    return await readline.question(prompt)
  } finally {
    readline.close()
  }
}

export class AuthManager {
  constructor(config, { fetchImpl = fetch } = {}) {
    this.config = config
    this.fetchImpl = fetchImpl
    this.token = undefined
    this.refreshPromise = undefined
  }

  async load() {
    if (this.token) return this.token
    try {
      const raw = await readFile(this.config.authPath, "utf8")
      const parsed = JSON.parse(raw)
      if (!parsed.access || !parsed.refresh || !Number.isFinite(parsed.expires)) {
        throw new Error("stored OAuth credential is malformed")
      }
      this.token = parsed
      return parsed
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.token = null
        return null
      }
      throw new Error(`Unable to read ${this.config.authPath}: ${error.message}`)
    }
  }

  async save(token) {
    await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 })
    await chmod(this.config.dataDir, 0o700)
    const temporaryPath = `${this.config.authPath}.${process.pid}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, this.config.authPath)
    this.token = token
  }

  async clear() {
    this.token = null
    try {
      await unlink(this.config.authPath)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
  }

  async login() {
    const flow = createAuthorizationFlow(this.config)
    let callback
    let callbackListening = false
    let code
    try {
      callback = startCallbackServer(this.config, flow.state)
      await callback.listening
      callbackListening = true
      console.log(`Opening ChatGPT login in your browser...`)
      console.log(`If it does not open, visit:\n${flow.url}`)
      openBrowser(flow.url)
      code = await callback.codePromise
    } catch (error) {
      if (callbackListening) throw error
      console.warn(`Could not use localhost:${this.config.oauthPort} (${error.message}).`)
      console.log(`Open this URL manually:\n${flow.url}`)
      const inputValue = await readLine("Paste the full redirect URL (or authorization code): ")
      const parsed = parseAuthorizationInput(inputValue)
      if (!parsed.code) throw new Error("No authorization code was provided")
      if (parsed.state && parsed.state !== flow.state) throw new Error("OAuth state mismatch")
      code = parsed.code
    } finally {
      if (callback) await callback.close().catch(() => {})
    }

    const token = await exchangeAuthorizationCode(this.config, code, flow.verifier, this.fetchImpl)
    await this.save(token)
    return token
  }

  async refresh() {
    const current = await this.load()
    if (!current) throw new Error("Not logged in. Run: crush-codex-bridge login")
    if (!this.refreshPromise) {
      this.refreshPromise = refreshAccessToken(this.config, current, this.fetchImpl)
        .then(async (token) => {
          await this.save(token)
          return token
        })
        .finally(() => {
          this.refreshPromise = undefined
        })
    }
    return this.refreshPromise
  }

  async ensureValid() {
    const current = await this.load()
    if (!current) throw new Error("Not logged in. Run: crush-codex-bridge login")
    if (current.expires > Date.now() + EXPIRY_SKEW_MS) return current
    return this.refresh()
  }

  async forceRefresh() {
    return this.refresh()
  }

  async status() {
    const token = await this.load()
    return {
      loggedIn: Boolean(token),
      accountId: token?.accountId ?? null,
      expiresAt: token ? new Date(token.expires).toISOString() : null,
      authPath: this.config.authPath,
    }
  }
}
