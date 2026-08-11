import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { loadConfig } from "../src/config.js"
import { createServiceEnvironment, createServiceUnit, installService, uninstallService } from "../src/daemon.js"

function testConfig(dataDir) {
  return loadConfig({
    dataDir,
    port: 8787,
    oauthPort: 1455,
    apiKey: "local secret",
    endpoint: "https://example.test/responses",
    issuer: "https://auth.example.test",
    clientId: "client",
    models: ["gpt-test", "gpt-small"],
    originator: "bridge",
    userAgent: "bridge/1.0",
    requestTimeoutMs: 30000,
  })
}

test("service environment preserves bridge configuration", () => {
  const environment = createServiceEnvironment(testConfig("/tmp/bridge data"))
  assert.match(environment, /^BRIDGE_API_KEY="local secret"$/m)
  assert.match(environment, /^CODEX_MODELS="gpt-test,gpt-small"$/m)
  assert.match(environment, /^CRUSH_CODEX_HOME="\/tmp\/bridge data"$/m)
})

test("service unit restarts the bridge and escapes systemd paths", () => {
  const unit = createServiceUnit({
    environmentPath: "/tmp/bridge%data/service.env",
    nodePath: "/opt/node bin/node",
    cliPath: "/opt/bridge/src/cli.js",
  })
  assert.match(unit, /EnvironmentFile="\/tmp\/bridge%%data\/service.env"/)
  assert.match(unit, /ExecStart="\/opt\/node bin\/node" "\/opt\/bridge\/src\/cli.js"/)
  assert.match(unit, /Restart=on-failure/)
  assert.match(unit, /WantedBy=default.target/)
})

test("install and uninstall manage a systemd user service", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-daemon-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dataDir = path.join(root, "data")
  const calls = []
  const runSystemctl = async (args) => {
    calls.push(args)
    return { stdout: "", stderr: "" }
  }
  const config = testConfig(dataDir)
  const options = {
    platform: "linux",
    home: root,
    nodePath: "/usr/bin/node",
    cliPath: "/opt/bridge/src/cli.js",
    runSystemctl,
  }

  const paths = await installService(config, options)
  const unit = await readFile(paths.unitPath, "utf8")
  const environment = await readFile(paths.environmentPath, "utf8")
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/opt\/bridge\/src\/cli.js"/)
  assert.match(environment, /^BRIDGE_PORT="8787"$/m)
  assert.equal((await stat(paths.environmentPath)).mode & 0o777, 0o600)
  assert.deepEqual(calls, [
    ["daemon-reload"],
    ["enable", "--now", "crush-codex-bridge.service"],
  ])

  calls.length = 0
  await uninstallService(config, options)
  await assert.rejects(readFile(paths.unitPath, "utf8"), { code: "ENOENT" })
  await assert.rejects(readFile(paths.environmentPath, "utf8"), { code: "ENOENT" })
  assert.deepEqual(calls, [
    ["disable", "--now", "crush-codex-bridge.service"],
    ["daemon-reload"],
    ["reset-failed", "crush-codex-bridge.service"],
  ])
})

test("daemon management rejects unsupported platforms", async () => {
  await assert.rejects(
    installService(testConfig("/tmp/bridge"), { platform: "darwin" }),
    /supports Linux systemd user services only/,
  )
})
