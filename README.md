# Crush Codex Bridge

Give [Crush](https://github.com/charmbracelet/crush) a tiny local bridge to Codex through your ChatGPT account.

No API key juggling. No mystery daemon listening on the network. The bridge signs in with the Codex OAuth flow, stores the credential on your machine, and forwards Crush's OpenAI Responses API requests to the Codex backend.

```text
Crush  ->  http://127.0.0.1:8787/v1  ->  Codex
             tiny local bridge
```

> [!IMPORTANT]
> This project uses an unofficial ChatGPT backend endpoint. OpenAI may change it without notice. Keep the bridge local, and do not expose it to a network.

## What you get

- Browser-based ChatGPT/Codex login with PKCE
- Automatic OAuth token refresh
- Streaming Responses API forwarding
- Model discovery for Crush
- A generated Crush provider configuration
- Optional systemd user service on Linux
- No runtime dependencies

## Requirements

- Node.js 20 or newer
- A current Crush build with OpenAI Responses API support
- A ChatGPT account with Codex access

## Quick start

Clone the repository and link the CLI:

```bash
git clone <your-repository-url>
cd crush-codex-bridge
npm link
```

Pick a private key that Crush will use when talking to the local bridge:

```bash
export BRIDGE_API_KEY="$(openssl rand -hex 24)"
```

Sign in, check the session, and start the bridge:

```bash
crush-codex-bridge login
crush-codex-bridge status
crush-codex-bridge start
```

The bridge listens on `127.0.0.1:8787`. It never binds to other interfaces.

## Connect Crush

Generate a provider snippet:

```bash
crush-codex-bridge config > /tmp/crush-codex.json
```

Merge the generated `providers.openai-codex` and `models` entries into your Crush configuration, usually at `~/.config/crush/crush.json`.

The provider looks like this:

```json
{
  "providers": {
    "openai-codex": {
      "id": "openai-codex",
      "name": "OpenAI Codex (ChatGPT OAuth)",
      "type": "openai",
      "base_url": "http://127.0.0.1:8787/v1",
      "api_key": "$BRIDGE_API_KEY",
      "flat_rate": true,
      "discover_models": false
    }
  }
}
```

Use `"type": "openai"`. Crush's native OpenAI provider sends Responses API requests. The bridge rejects `/v1/chat/completions` because Chat Completions and Responses use different schemas.

## Keep it running on Linux

Install an always-on systemd user service:

```bash
crush-codex-bridge install
```

The service starts at once, restarts after failures, and stores its current settings in `~/.local/share/crush-codex-bridge/service.env`. Run `install` again after changing environment settings.

Useful controls:

```bash
crush-codex-bridge restart
crush-codex-bridge logs
crush-codex-bridge uninstall
```

To keep user services running after logout:

```bash
loginctl enable-linger "$USER"
```

On other platforms, keep `crush-codex-bridge start` running in a terminal or use your preferred process manager.

## Commands

| Command | Purpose |
| --- | --- |
| `crush-codex-bridge login` | Open the OAuth login flow |
| `crush-codex-bridge logout` | Remove the stored credential |
| `crush-codex-bridge status` | Show authentication and bridge status |
| `crush-codex-bridge config` | Print a Crush configuration snippet |
| `crush-codex-bridge start` | Run the local bridge |
| `crush-codex-bridge install` | Install and start the Linux user service |
| `crush-codex-bridge restart` | Restart the Linux user service |
| `crush-codex-bridge logs` | Follow service logs |
| `crush-codex-bridge uninstall` | Remove the Linux user service |

## Configuration

Copy `.env.example` if you want a reference. The CLI reads environment variables directly; it does not load `.env` files itself.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRIDGE_API_KEY` | `local` | Secret shared by Crush and the bridge |
| `BRIDGE_PORT` | `8787` | Local Responses API port |
| `OAUTH_PORT` | `1455` | OAuth callback port |
| `CRUSH_CODEX_HOME` | `~/.local/share/crush-codex-bridge` | Credential and service data directory |
| `CODEX_MODELS` | Built-in model list | Comma-separated models exposed to Crush |
| `CODEX_API_ENDPOINT` | ChatGPT Codex endpoint | Upstream endpoint override for testing |
| `CODEX_REQUEST_TIMEOUT_MS` | `120000` | Upstream request timeout |

If you change `BRIDGE_PORT`, regenerate the Crush configuration:

```bash
export BRIDGE_PORT=8788
crush-codex-bridge config > /tmp/crush-codex.json
```

## Check the bridge

```bash
curl http://127.0.0.1:8787/healthz
curl -H "Authorization: Bearer $BRIDGE_API_KEY" \
  http://127.0.0.1:8787/v1/models
```

## Security notes

- Set a long, random `BRIDGE_API_KEY`; the default `local` value only suits quick local testing.
- Keep the bridge on loopback. It has no TLS or public-network hardening.
- Never commit `auth.json`, `.env`, `.crush/`, or other local session data.
- Never copy `~/.codex/auth.json` into `OPENAI_API_KEY`.
- The credential lives at `~/.local/share/crush-codex-bridge/auth.json` with restrictive permissions unless you set `CRUSH_CODEX_HOME`.
- A failed token refresh requires a fresh `crush-codex-bridge login`.

## Current limits

The bridge forwards Responses API requests and streaming responses. It removes Crush's `max_output_tokens` field because the ChatGPT Codex endpoint rejects it.

It does not translate Chat Completions, implement device-code login, or provide WebSocket transport. The OAuth callback uses `http://localhost:1455/auth/callback`, matching the Codex OAuth client flow.

## Development

```bash
npm test
```

The test suite uses Node's built-in test runner and needs no package install.

## License

[MIT](LICENSE)
