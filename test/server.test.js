import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import { loadConfig } from "../src/config.js"
import { BridgeServer } from "../src/server.js"

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve(server.address().port)
    })
  })
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

test("bridge serves authenticated models and proxies Responses streaming", async (t) => {
  const received = []
  let upstreamCalls = 0
  const upstream = createServer((request, response) => {
    const chunks = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => {
      received.push({
        url: request.url,
        authorization: request.headers.authorization,
        account: request.headers["chatgpt-account-id"],
        originator: request.headers.originator,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      })
      upstreamCalls += 1
      if (upstreamCalls === 1) {
        response.writeHead(401)
        response.end("expired")
        return
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      response.end('data: {"type":"response.completed"}\n\n')
    })
  })
  const upstreamPort = await listen(upstream)
  t.after(() => close(upstream))

  const authTokens = [
    { access: "first", accountId: "acct_test" },
    { access: "refreshed", accountId: "acct_test" },
  ]
  const auth = {
    status: async () => ({ loggedIn: true }),
    ensureValid: async () => authTokens[0],
    forceRefresh: async () => authTokens[1],
  }
  const config = loadConfig({
    port: 0,
    apiKey: "bridge-secret",
    endpoint: `http://127.0.0.1:${upstreamPort}/responses`,
    models: ["gpt-test"],
  })
  const bridge = new BridgeServer(config, auth)
  const bridgePort = await bridge.listen()
  t.after(() => bridge.close())

  const unauthorized = await fetch(`http://127.0.0.1:${bridgePort}/v1/models`)
  assert.equal(unauthorized.status, 401)

  const models = await fetch(`http://127.0.0.1:${bridgePort}/v1/models`, {
    headers: { Authorization: "Bearer bridge-secret" },
  })
  assert.equal(models.status, 200)
  assert.deepEqual((await models.json()).data.map((model) => model.id), ["gpt-test"])

  const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/responses`, {
    method: "POST",
    headers: {
      Authorization: "Bearer bridge-secret",
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "session-id": "session-1",
    },
    body: JSON.stringify({ model: "gpt-test", input: "hello", max_output_tokens: 128000, stream: true }),
  })
  assert.equal(response.status, 200)
  assert.match(await response.text(), /response\.completed/)
  assert.equal(upstreamCalls, 2)
  assert.equal(received[1].authorization, "Bearer refreshed")
  assert.equal(received[1].account, "acct_test")
  assert.equal(received[1].originator, "crush-codex-bridge")
  assert.deepEqual(received[1].body, { model: "gpt-test", input: "hello", stream: true })
})

test("bridge rejects chat completions explicitly", async (t) => {
  const auth = {
    status: async () => ({ loggedIn: true }),
    ensureValid: async () => ({ access: "access" }),
    forceRefresh: async () => ({ access: "access" }),
  }
  const bridge = new BridgeServer(loadConfig({ port: 0, apiKey: "secret" }), auth)
  const port = await bridge.listen()
  t.after(() => bridge.close())

  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-test", messages: [] }),
  })
  assert.equal(response.status, 501)
})
