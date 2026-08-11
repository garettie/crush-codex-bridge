import os from "node:os"
import path from "node:path"

const defaultHome = path.join(os.homedir(), ".local", "share", "crush-codex-bridge")

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function loadConfig(overrides = {}) {
  const dataDir = overrides.dataDir ?? process.env.CRUSH_CODEX_HOME ?? defaultHome
  const models = overrides.models ?? (process.env.CODEX_MODELS ?? "gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,gpt-5.5,gpt-5.4,gpt-5.4-mini,gpt-5.3-codex-spark")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean)

  return {
    dataDir,
    authPath: overrides.authPath ?? path.join(dataDir, "auth.json"),
    port: overrides.port ?? positiveInt(process.env.BRIDGE_PORT, 8787),
    oauthPort: overrides.oauthPort ?? positiveInt(process.env.OAUTH_PORT, 1455),
    apiKey: overrides.apiKey ?? process.env.BRIDGE_API_KEY ?? "local",
    endpoint: overrides.endpoint ?? process.env.CODEX_API_ENDPOINT ?? "https://chatgpt.com/backend-api/codex/responses",
    issuer: overrides.issuer ?? process.env.CODEX_AUTH_ISSUER ?? "https://auth.openai.com",
    clientId: overrides.clientId ?? process.env.OAUTH_CLIENT_ID ?? "app_EMoamEEZ73f0CkXaXp7hrann",
    models,
    originator: overrides.originator ?? process.env.CODEX_ORIGINATOR ?? "crush-codex-bridge",
    userAgent: overrides.userAgent ?? process.env.CODEX_USER_AGENT ?? "crush-codex-bridge/0.1.0",
    requestTimeoutMs: overrides.requestTimeoutMs ?? positiveInt(process.env.CODEX_REQUEST_TIMEOUT_MS, 120000),
  }
}
