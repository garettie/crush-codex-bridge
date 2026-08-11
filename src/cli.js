#!/usr/bin/env node

import { loadConfig } from "./config.js"
import { controlService, installService, uninstallService } from "./daemon.js"
import { AuthManager } from "./oauth.js"
import { BridgeServer } from "./server.js"

function printUsage() {
  console.log(`Usage: crush-codex-bridge <command>

Commands:
  login       Sign in with ChatGPT in a browser
  logout      Remove the stored ChatGPT credential
  status      Show login status without printing tokens
  config      Print Crush provider/model commands
  start       Start the local OpenAI Responses API bridge
  install     Install and start a systemd user service
  uninstall   Stop and remove the systemd user service
  restart     Restart the systemd user service
  logs        Follow logs from the systemd user service
`)
}

function printCrushConfig(config) {
  const models = config.models.map((id) => ({
    id,
    name: `${id} (ChatGPT Codex)`,
    cost_per_1m_in: 0,
    cost_per_1m_out: 0,
    cost_per_1m_in_cached: 0,
    cost_per_1m_out_cached: 0,
    context_window: 272000,
    default_max_tokens: 128000,
    can_reason: true,
    reasoning_levels: ["low", "medium", "high"],
    default_reasoning_effort: "medium",
    supports_attachments: true,
  }))
  const provider = {
    id: "openai-codex",
    name: "OpenAI Codex (ChatGPT OAuth)",
    type: "openai",
    base_url: `http://127.0.0.1:${config.port}/v1`,
    api_key: "$BRIDGE_API_KEY",
    flat_rate: true,
    discover_models: false,
    models,
  }
  console.log(JSON.stringify({
    $schema: "https://charm.land/crush.json",
    providers: { "openai-codex": provider },
    models: {
      large: config.models[0] ? { provider: "openai-codex", model: config.models[0], reasoning_effort: "medium" } : undefined,
      small: config.models.at(-1) ? { provider: "openai-codex", model: config.models.at(-1), reasoning_effort: "medium" } : undefined,
    },
  }, null, 2))
}

async function main() {
  const command = process.argv[2] ?? "start"
  const config = loadConfig()
  const auth = new AuthManager(config)

  switch (command) {
    case "login": {
      const token = await auth.login()
      console.log(`Logged in to ChatGPT${token.accountId ? ` (${token.accountId})` : ""}.`)
      return
    }
    case "logout":
      await auth.clear()
      console.log("Stored ChatGPT credential removed.")
      return
    case "status":
      console.log(JSON.stringify(await auth.status(), null, 2))
      return
    case "config":
      printCrushConfig(config)
      return
    case "install": {
      const paths = await installService(config)
      console.log(`Installed and started ${paths.unitPath}`)
      console.log("The bridge will now start automatically when your user service manager starts.")
      return
    }
    case "uninstall": {
      const paths = await uninstallService(config, { ignoreMissing: true })
      console.log(`Stopped and removed ${paths.unitPath}`)
      return
    }
    case "restart":
      await controlService("restart")
      console.log("Crush Codex bridge restarted.")
      return
    case "logs": {
      const { spawn } = await import("node:child_process")
      const child = spawn("journalctl", ["--user", "-u", "crush-codex-bridge.service", "-f"], { stdio: "inherit" })
      const exitCode = await new Promise((resolve, reject) => {
        child.once("error", reject)
        child.once("exit", (code) => resolve(code ?? 1))
      })
      process.exitCode = exitCode
      return
    }
    case "start": {
      const status = await auth.status()
      if (!status.loggedIn) console.warn("Bridge is starting without a ChatGPT login. Run `crush-codex-bridge login` first.")
      if (config.apiKey === "local") console.warn("Using the default local bridge API key. Set BRIDGE_API_KEY for stronger local isolation.")
      const bridge = new BridgeServer(config, auth)
      const port = await bridge.listen()
      console.log(`Crush Codex bridge listening on http://127.0.0.1:${port}/v1`)
      console.log("Run `crush-codex-bridge config` to print Crush configuration commands.")
      const shutdown = async () => {
        await bridge.close()
        process.exit(0)
      }
      process.once("SIGINT", shutdown)
      process.once("SIGTERM", shutdown)
      await new Promise(() => {})
      return
    }
    default:
      printUsage()
      process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`)
  process.exitCode = 1
})
