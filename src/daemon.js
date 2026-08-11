import { execFile } from "node:child_process"
import { chmod, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const SERVICE_NAME = "crush-codex-bridge.service"

function unitQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`
}

function environmentQuote(value) {
  const text = String(value)
  if (/[\r\n\0]/u.test(text)) throw new Error("Service environment values cannot contain newlines or null bytes")
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

export function servicePaths(config, home = os.homedir()) {
  return {
    unitPath: path.join(home, ".config", "systemd", "user", SERVICE_NAME),
    environmentPath: path.join(config.dataDir, "service.env"),
  }
}

export function createServiceEnvironment(config) {
  const values = {
    BRIDGE_API_KEY: config.apiKey,
    BRIDGE_PORT: config.port,
    CODEX_API_ENDPOINT: config.endpoint,
    CODEX_AUTH_ISSUER: config.issuer,
    CODEX_MODELS: config.models.join(","),
    CODEX_ORIGINATOR: config.originator,
    CODEX_REQUEST_TIMEOUT_MS: config.requestTimeoutMs,
    CODEX_USER_AGENT: config.userAgent,
    CRUSH_CODEX_HOME: config.dataDir,
    OAUTH_CLIENT_ID: config.clientId,
    OAUTH_PORT: config.oauthPort,
  }
  return `${Object.entries(values).map(([key, value]) => `${key}=${environmentQuote(value)}`).join("\n")}\n`
}

export function createServiceUnit({ environmentPath, nodePath, cliPath }) {
  return `[Unit]
Description=Local OpenAI Codex OAuth bridge for Crush
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${unitQuote(environmentPath)}
ExecStart=${unitQuote(nodePath)} ${unitQuote(cliPath)} start
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`
}

async function defaultRunSystemctl(args) {
  try {
    return await execFileAsync("systemctl", ["--user", ...args], { encoding: "utf8" })
  } catch (error) {
    const detail = error.stderr?.trim() || error.stdout?.trim() || error.message
    throw new Error(`systemctl --user ${args.join(" ")} failed: ${detail}`)
  }
}

function requireLinux(platform) {
  if (platform !== "linux") throw new Error("Daemon management currently supports Linux systemd user services only")
}

export async function installService(config, options = {}) {
  requireLinux(options.platform ?? process.platform)
  const paths = servicePaths(config, options.home)
  const runSystemctl = options.runSystemctl ?? defaultRunSystemctl
  const nodePath = options.nodePath ?? process.execPath
  const cliPath = options.cliPath ?? process.argv[1]

  await mkdir(path.dirname(paths.unitPath), { recursive: true })
  await mkdir(path.dirname(paths.environmentPath), { recursive: true })
  await writeFile(paths.environmentPath, createServiceEnvironment(config), { mode: 0o600 })
  await chmod(paths.environmentPath, 0o600)
  await writeFile(paths.unitPath, createServiceUnit({ ...paths, nodePath, cliPath }), { mode: 0o600 })
  await chmod(paths.unitPath, 0o600)
  await runSystemctl(["daemon-reload"])
  await runSystemctl(["enable", "--now", SERVICE_NAME])
  return paths
}

export async function uninstallService(config, options = {}) {
  requireLinux(options.platform ?? process.platform)
  const paths = servicePaths(config, options.home)
  const runSystemctl = options.runSystemctl ?? defaultRunSystemctl

  try {
    await runSystemctl(["disable", "--now", SERVICE_NAME])
  } catch (error) {
    if (!options.ignoreMissing) throw error
  }
  await rm(paths.unitPath, { force: true })
  await rm(paths.environmentPath, { force: true })
  await runSystemctl(["daemon-reload"])
  await runSystemctl(["reset-failed", SERVICE_NAME]).catch(() => {})
  return paths
}

export async function controlService(action, options = {}) {
  requireLinux(options.platform ?? process.platform)
  const runSystemctl = options.runSystemctl ?? defaultRunSystemctl
  const args = action === "status"
    ? ["status", SERVICE_NAME, "--no-pager"]
    : [action, SERVICE_NAME]
  return runSystemctl(args)
}
