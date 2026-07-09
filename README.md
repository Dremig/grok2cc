# grok2cc

Run **Grok** with **Claude Code** in two ways:

| Mode | What | Harness | Entry |
|------|------|---------|-------|
| **B (recommended)** | Grok is the *model*; Claude Code is the agent | **Claude Code** | `harness-proxy.mjs` + `claude-with-grok.sh` |
| **A** | Claude Code *delegates* to Grok Build CLI | Grok Build (nested) | `server.mjs` (MCP) |

Mode B is a thin local proxy in front of xAI’s native Anthropic-compatible `POST /v1/messages` API (tools + streaming). It does **not** start the Grok Build CLI harness.

---

## Mode B — Claude Code harness + Grok model

### Why a proxy?

1. xAI expects `Authorization: Bearer`; Claude Code’s `ANTHROPIC_API_KEY` is sent as `x-api-key`
2. xAI tool JSON Schema requires `required` to be an **array** (`[]` if empty); Claude often omits it
3. Auth can reuse `~/.grok/auth.json` from `grok login` (or `XAI_API_KEY`)

### Prerequisites

- Node.js 18+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude`)
- Grok auth: `grok login` **or** `export XAI_API_KEY=...`

### Quick start

```bash
git clone https://github.com/Dremig/grok2cc.git
cd grok2cc
npm install   # only needed for Mode A (MCP); Mode B is zero-deps

# Interactive Claude Code, model = Grok
./claude-with-grok.sh

# Headless
./claude-with-grok.sh -p "hello" --dangerously-skip-permissions

# Coding model
GROK_HARNESS_DEFAULT_MODEL=grok-build-0.1 ./claude-with-grok.sh
```

The launcher starts `harness-proxy.mjs` on `127.0.0.1:8790` if it is not already up.

Manual proxy:

```bash
node harness-proxy.mjs
# or: npm run proxy
```

Health: `curl http://127.0.0.1:8790/health`

### VS Code official Claude Code extension

**Yes — same Mode B path works.** The [official VS Code extension](https://code.claude.com/docs/en/vs-code) spawns Claude Code and reads gateway credentials from VS Code’s own settings (not only from `~/.claude/settings.json`).

1. Keep the local proxy running (`node harness-proxy.mjs` or `./claude-with-grok.sh` once so it starts).
2. Open **Preferences: Open User Settings (JSON)** and add (see also [`vscode-settings.example.json`](./vscode-settings.example.json)):

```json
{
  "claudeCode.environmentVariables": [
    { "name": "ANTHROPIC_BASE_URL", "value": "http://127.0.0.1:8790" },
    { "name": "ANTHROPIC_API_KEY", "value": "grok-harness" },
    { "name": "ANTHROPIC_MODEL", "value": "grok-4.5" },
    { "name": "ANTHROPIC_DEFAULT_SONNET_MODEL", "value": "grok-4.5" },
    { "name": "ANTHROPIC_DEFAULT_OPUS_MODEL", "value": "grok-4.5" },
    { "name": "ANTHROPIC_DEFAULT_HAIKU_MODEL", "value": "grok-4.5" },
    { "name": "ANTHROPIC_SMALL_FAST_MODEL", "value": "grok-4.5" },
    { "name": "ANTHROPIC_REASONING_MODEL", "value": "grok-4.5" },
    { "name": "NO_PROXY", "value": "127.0.0.1,localhost" },
    { "name": "no_proxy", "value": "127.0.0.1,localhost" },
    { "name": "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "value": "1" }
  ]
}
```

3. Reload the VS Code window, open the Claude Code panel.

Notes:

- Use `ANTHROPIC_API_KEY` (any non-empty string). Our proxy accepts `x-api-key` and rewrites to xAI `Bearer` from `~/.grok/auth.json`.
- Official docs put gateway env on `claudeCode.environmentVariables` so the extension’s login check also sees them ([LLM gateway connect](https://code.claude.com/docs/en/llm-gateway-connect)).
- If you use a system HTTP proxy (e.g. Clash on `:7890`), keep `NO_PROXY` for loopback or the extension may never hit `127.0.0.1:8790`.
- This still uses **Claude Code’s harness** (tools/permissions/UI). Only the model is Grok.
- To go back to normal Claude, remove or comment out that settings block and reload.

### Verified

- Plain text reply via Claude Code → Grok
- Full tool loop (e.g. Bash) inside Claude Code harness with model `grok-4.5`

### Environment (Mode B)

| Variable | Meaning |
|----------|---------|
| `GROK_HARNESS_PORT` | Proxy port (default `8790`) |
| `GROK_HARNESS_HOST` | Bind host (default `127.0.0.1`) |
| `GROK_HARNESS_DEFAULT_MODEL` | Default model (default `grok-4.5`) |
| `GROK_HARNESS_UPSTREAM` | Upstream base (default `https://api.x.ai`) |
| `GROK_AUTH_JSON` | Path to Grok auth file |
| `XAI_API_KEY` / `GROK_HARNESS_TOKEN` | Override token instead of auth.json |
| `GROK_HARNESS_LOG=1` | Log each proxied request |

---

## Mode A — MCP nested agent

Exposes `grok_delegate` / `grok_ask` / `grok_review` by wrapping `grok -p`.

```bash
npm install

claude mcp add --scope user grok \
  --env GROK_BIN="$HOME/.grok/bin/grok" \
  -- node "$(pwd)/server.mjs"

claude mcp list   # should show grok ✓ Connected
```

Optional reverse direction (Grok Build → Claude tools):

```toml
# ~/.grok/config.toml
[mcp_servers.claude-code]
command = "claude"
args = ["mcp", "serve"]
enabled = true
```

Set `[compat.claude] mcps = false` on the Grok side if Claude’s user config also registers this MCP (avoids recursion).

### MCP tools

| Tool | Purpose |
|------|---------|
| `grok_delegate` | Agentic coding (`--always-approve`) |
| `grok_ask` | Consult / second opinion (plan mode) |
| `grok_review` | Code review focus |

### Env (Mode A)

| Variable | Meaning |
|----------|---------|
| `GROK_BIN` | Path to `grok` |
| `GROK_DEFAULT_MODEL` | Default `-m` |
| `GROK_DEFAULT_CWD` | Default working directory |
| `GROK_TIMEOUT_MS` | Subprocess timeout (default `600000`) |

---

## Layout

```
grok2cc/
  harness-proxy.mjs    # Mode B: Anthropic→xAI local proxy
  claude-with-grok.sh  # Mode B: launch Claude Code through the proxy
  server.mjs           # Mode A: MCP server wrapping grok CLI
  scripts/probe.mjs    # list MCP tools
```

## License

MIT
