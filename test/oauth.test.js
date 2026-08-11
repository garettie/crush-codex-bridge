import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { createAuthorizationFlow, extractAccountId, parseAuthorizationInput } from "../src/oauth.js"

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "none" })}.${encode(payload)}.`
}

test("extractAccountId reads the ChatGPT auth claim", () => {
  const token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } })
  assert.equal(extractAccountId({ access_token: token }), "acct_123")
})

test("extractAccountId falls back to organization claims", () => {
  const token = jwt({ organizations: [{ id: "org_456" }] })
  assert.equal(extractAccountId({ id_token: token }), "org_456")
})

test("parseAuthorizationInput accepts redirect URLs, query strings, and codes", () => {
  assert.deepEqual(
    parseAuthorizationInput("http://localhost:1455/auth/callback?code=abc&state=xyz"),
    { code: "abc", state: "xyz" },
  )
  assert.deepEqual(parseAuthorizationInput("code=abc&state=xyz"), { code: "abc", state: "xyz" })
  assert.deepEqual(parseAuthorizationInput("abc#xyz"), { code: "abc", state: "xyz" })
  assert.deepEqual(parseAuthorizationInput("abc"), { code: "abc", state: "" })
})

test("createAuthorizationFlow generates a valid PKCE authorization URL", () => {
  const flow = createAuthorizationFlow({
    oauthPort: 1455,
    issuer: "https://auth.example.test",
    clientId: "client",
    originator: "bridge",
  })
  const url = new URL(flow.url)
  assert.equal(url.origin, "https://auth.example.test")
  assert.equal(url.searchParams.get("client_id"), "client")
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback")
  assert.equal(url.searchParams.get("state"), flow.state)
  assert.equal(url.searchParams.get("code_challenge_method"), "S256")
  const expectedChallenge = createHash("sha256").update(flow.verifier).digest("base64url")
  assert.equal(url.searchParams.get("code_challenge"), expectedChallenge)
})
