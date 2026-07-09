#!/usr/bin/env bash
# Configure official VS Code / Cursor Claude Code extension to use Grok via grok2cc proxy.
#
# Usage:
#   ./install-vscode.sh              # install / update config + start proxy
#   ./install-vscode.sh --uninstall  # restore previous VS Code + claude settings (best-effort)
#   ./install-vscode.sh --no-launchd # skip macOS LaunchAgent (proxy only for this session)
#   MODEL=grok-build-0.1 ./install-vscode.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT="${GROK_HARNESS_PORT:-8790}"
HOST="${GROK_HARNESS_HOST:-127.0.0.1}"
MODEL="${GROK_HARNESS_DEFAULT_MODEL:-${MODEL:-grok-4.5}}"
DO_LAUNCHD=1
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=1 ;;
    --no-launchd) DO_LAUNCHD=0 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
  esac
done

ts() { date +%Y%m%d%H%M%S; }
info() { printf '==> %s\n' "$*"; }
warn() { printf 'warn: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

resolve_node() {
  if [[ -x "${HOME}/.nvm/versions/node/v24.10.0/bin/node" ]]; then
    echo "${HOME}/.nvm/versions/node/v24.10.0/bin/node"
    return
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return
  fi
  die "node not found (need Node.js 18+)"
}

vscode_settings_candidates() {
  # macOS + Linux common locations
  local candidates=(
    "${HOME}/Library/Application Support/Code/User/settings.json"
    "${HOME}/Library/Application Support/Code - Insiders/User/settings.json"
    "${HOME}/Library/Application Support/Cursor/User/settings.json"
    "${HOME}/Library/Application Support/VSCodium/User/settings.json"
    "${HOME}/.config/Code/User/settings.json"
    "${HOME}/.config/Code - Insiders/User/settings.json"
    "${HOME}/.config/Cursor/User/settings.json"
    "${HOME}/.config/VSCodium/User/settings.json"
  )
  local p
  for p in "${candidates[@]}"; do
    [[ -f "$p" ]] && printf '%s\n' "$p"
  done
}

ensure_proxy_running() {
  if curl -fsS --max-time 2 "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
    info "proxy already healthy on http://${HOST}:${PORT}"
    return
  fi
  local node
  node="$(resolve_node)"
  [[ -f "${ROOT}/harness-proxy.mjs" ]] || die "missing ${ROOT}/harness-proxy.mjs"
  info "starting harness proxy..."
  local logdir="${HOME}/Library/Logs/grok2cc"
  mkdir -p "$logdir" 2>/dev/null || logdir="/tmp"
  GROK_HARNESS_PORT="$PORT" GROK_HARNESS_HOST="$HOST" GROK_HARNESS_DEFAULT_MODEL="$MODEL" \
    GROK_HARNESS_LOG=1 \
    nohup "$node" "${ROOT}/harness-proxy.mjs" \
    >>"${logdir}/harness-proxy.manual.log" 2>&1 &
  echo $! >/tmp/grok-harness-proxy.pid
  local i
  for i in $(seq 1 20); do
    if curl -fsS --max-time 1 "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
      info "proxy up (pid $(cat /tmp/grok-harness-proxy.pid))"
      return
    fi
    sleep 0.25
  done
  die "proxy failed to start; check logs"
}

install_launchd() {
  [[ "$(uname -s)" == "Darwin" ]] || { warn "LaunchAgent only on macOS; skipping"; return; }
  [[ "$DO_LAUNCHD" -eq 1 ]] || { info "skipping LaunchAgent (--no-launchd)"; return; }

  local node plist label logdir
  node="$(resolve_node)"
  label="com.dremig.grok2cc-harness-proxy"
  plist="${HOME}/Library/LaunchAgents/${label}.plist"
  logdir="${HOME}/Library/Logs/grok2cc"
  mkdir -p "${HOME}/Library/LaunchAgents" "$logdir"

  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${ROOT}/harness-proxy.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${HOME}/.nvm/versions/node/v24.10.0/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>GROK_HARNESS_PORT</key>
    <string>${PORT}</string>
    <key>GROK_HARNESS_HOST</key>
    <string>${HOST}</string>
    <key>GROK_HARNESS_DEFAULT_MODEL</key>
    <string>${MODEL}</string>
    <key>GROK_HARNESS_LOG</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logdir}/harness-proxy.out.log</string>
  <key>StandardErrorPath</key>
  <string>${logdir}/harness-proxy.err.log</string>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
</dict>
</plist>
EOF

  # Replace any manual proxy listeners so LaunchAgent owns the port
  ps -ax -o pid=,command= 2>/dev/null | awk '/harness-proxy\.mjs/ && !/awk/ {print $1}' | while read -r pid; do
    kill "$pid" 2>/dev/null || true
  done
  sleep 0.4
  launchctl bootout "gui/$(id -u)/${label}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || launchctl load "$plist"
  sleep 0.8
  if curl -fsS --max-time 2 "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
    info "LaunchAgent installed and proxy healthy (${plist})"
  else
    warn "LaunchAgent loaded but health check failed; see ${logdir}/harness-proxy.err.log"
  fi
}

uninstall_launchd() {
  [[ "$(uname -s)" == "Darwin" ]] || return 0
  local label="com.dremig.grok2cc-harness-proxy"
  launchctl bootout "gui/$(id -u)/${label}" 2>/dev/null || true
  rm -f "${HOME}/Library/LaunchAgents/${label}.plist"
  ps -ax -o pid=,command= 2>/dev/null | awk '/harness-proxy\.mjs/ && !/awk/ {print $1}' | while read -r pid; do
    kill "$pid" 2>/dev/null || true
  done
  info "LaunchAgent removed"
}

patch_vscode_settings() {
  local settings="$1"
  local backup="${settings}.bak.grok2cc.$(ts)"
  cp "$settings" "$backup"
  info "backup VS Code settings → ${backup}"

  HOST="$HOST" PORT="$PORT" MODEL="$MODEL" SETTINGS_PATH="$settings" python3 <<'PY'
import json, os, re
from pathlib import Path

path = Path(os.environ["SETTINGS_PATH"])
host = os.environ["HOST"]
port = os.environ["PORT"]
model = os.environ["MODEL"]
base = f"http://{host}:{port}"

raw = path.read_text(encoding="utf-8", errors="replace")


def parse_jsonc(text: str):
    """Parse VS Code settings.json (JSONC-ish). String-aware (won't break http://)."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    try:
        import json5  # type: ignore

        return json5.loads(text)
    except Exception:
        pass

    # Drop C0 controls except tab/lf/cr
    cleaned = "".join(ch if (ord(ch) >= 32 or ch in "\t\n\r") else " " for ch in text)

    # String-aware strip of // and /* */ comments + trailing commas
    out = []
    i, n = 0, len(cleaned)
    in_str = False
    escape = False
    while i < n:
        ch = cleaned[i]
        if in_str:
            out.append(ch)
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            i += 1
            continue
        if ch == '"':
            in_str = True
            out.append(ch)
            i += 1
            continue
        # line comment
        if ch == "/" and i + 1 < n and cleaned[i + 1] == "/":
            while i < n and cleaned[i] not in "\n\r":
                i += 1
            continue
        # block comment
        if ch == "/" and i + 1 < n and cleaned[i + 1] == "*":
            i += 2
            while i + 1 < n and not (cleaned[i] == "*" and cleaned[i + 1] == "/"):
                i += 1
            i = min(n, i + 2)
            continue
        out.append(ch)
        i += 1
    cleaned = "".join(out)
    prev = None
    while prev != cleaned:
        prev = cleaned
        cleaned = re.sub(r",(\s*[}\]])", r"\1", cleaned)
    return json.loads(cleaned)


data = parse_jsonc(raw)

env_list = [
    {"name": "ANTHROPIC_BASE_URL", "value": base},
    {"name": "ANTHROPIC_API_KEY", "value": "grok-harness"},
    {"name": "ANTHROPIC_AUTH_TOKEN", "value": "grok-harness"},
    {"name": "ANTHROPIC_MODEL", "value": model},
    {"name": "ANTHROPIC_DEFAULT_SONNET_MODEL", "value": model},
    {"name": "ANTHROPIC_DEFAULT_OPUS_MODEL", "value": model},
    {"name": "ANTHROPIC_DEFAULT_HAIKU_MODEL", "value": model},
    {"name": "ANTHROPIC_SMALL_FAST_MODEL", "value": model},
    {"name": "ANTHROPIC_REASONING_MODEL", "value": model},
    {"name": "NO_PROXY", "value": "127.0.0.1,localhost"},
    {"name": "no_proxy", "value": "127.0.0.1,localhost"},
    {"name": "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "value": "1"},
]

data["claudeCode.preferredLocation"] = data.get("claudeCode.preferredLocation") or "panel"
data["claudeCode.disableLoginPrompt"] = True
data["claudeCode.environmentVariables"] = env_list

path.write_text(json.dumps(data, indent=4, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"patched {path}")
PY
}

patch_claude_settings() {
  local claude_settings="${HOME}/.claude/settings.json"
  mkdir -p "${HOME}/.claude"
  if [[ -f "$claude_settings" ]]; then
    cp "$claude_settings" "${claude_settings}.bak.grok2cc.$(ts)"
    info "backup ~/.claude/settings.json"
  else
    echo '{}' >"$claude_settings"
  fi

  HOST="$HOST" PORT="$PORT" MODEL="$MODEL" python3 <<'PY'
import json, os
from pathlib import Path
p = Path.home() / ".claude" / "settings.json"
d = json.loads(p.read_text(encoding="utf-8") or "{}")
env = d.setdefault("env", {})
base = f"http://{os.environ['HOST']}:{os.environ['PORT']}"
model = os.environ["MODEL"]
env.update({
    "ANTHROPIC_BASE_URL": base,
    "ANTHROPIC_API_KEY": "grok-harness",
    "ANTHROPIC_AUTH_TOKEN": "grok-harness",
    "ANTHROPIC_MODEL": model,
    "ANTHROPIC_REASONING_MODEL": model,
    "ANTHROPIC_DEFAULT_SONNET_MODEL": model,
    "ANTHROPIC_DEFAULT_OPUS_MODEL": model,
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": model,
    "ANTHROPIC_SMALL_FAST_MODEL": model,
    "CLAUDE_CODE_SUBAGENT_MODEL": model,
    "NO_PROXY": "127.0.0.1,localhost",
    "no_proxy": "127.0.0.1,localhost",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
})
p.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"patched {p}")
PY

  # Approve dummy gateway key so Claude Code doesn't ignore it
  python3 <<'PY'
import json
from pathlib import Path
p = Path.home() / ".claude.json"
if not p.exists():
    print("no ~/.claude.json yet (ok)")
    raise SystemExit(0)
d = json.loads(p.read_text(encoding="utf-8"))
car = d.setdefault("customApiKeyResponses", {})
approved = car.setdefault("approved", [])
if "grok-harness" not in approved:
    approved.append("grok-harness")
p.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("approved API key token: grok-harness")
PY
}

restore_latest_backup() {
  local pattern="$1"
  local latest
  latest="$(ls -t $pattern 2>/dev/null | head -1 || true)"
  if [[ -n "${latest:-}" && -f "$latest" ]]; then
    local target="${latest%.bak.grok2cc.*}"
    # pattern is like settings.json.bak.grok2cc.* → restore to settings.json
    # For path/file.bak.grok2cc.TS, strip .bak.grok2cc.TS
    target="$(echo "$latest" | sed -E 's/\.bak\.grok2cc\.[0-9]+$//')"
    cp "$latest" "$target"
    info "restored $target from $latest"
  else
    warn "no backup matching $pattern"
  fi
}

do_uninstall() {
  info "uninstalling grok2cc VS Code integration..."
  uninstall_launchd
  local s
  while IFS= read -r s; do
    restore_latest_backup "${s}.bak.grok2cc.*"
  done < <(vscode_settings_candidates)
  restore_latest_backup "${HOME}/.claude/settings.json.bak.grok2cc.*"
  info "done. Reload VS Code window."
}

do_install() {
  info "installing grok2cc for VS Code Claude Code extension"
  info "proxy → http://${HOST}:${PORT}  model → ${MODEL}"

  mkdir -p "${HOME}/Library/Logs/grok2cc" 2>/dev/null || mkdir -p /tmp/grok2cc-logs

  local found=0
  local s
  while IFS= read -r s; do
    found=1
    info "patching $s"
    patch_vscode_settings "$s"
  done < <(vscode_settings_candidates)

  if [[ "$found" -eq 0 ]]; then
    # Create VS Code user settings if VS Code app exists but no settings yet
    local default_settings="${HOME}/Library/Application Support/Code/User/settings.json"
    if [[ "$(uname -s)" != "Darwin" ]]; then
      default_settings="${HOME}/.config/Code/User/settings.json"
    fi
    mkdir -p "$(dirname "$default_settings")"
    echo '{}' >"$default_settings"
    patch_vscode_settings "$default_settings"
    warn "no existing editor settings found; created ${default_settings}"
  fi

  patch_claude_settings
  install_launchd
  ensure_proxy_running

  echo
  info "health: $(curl -fsS --max-time 2 "http://${HOST}:${PORT}/health" || echo FAIL)"
  cat <<EOF

Done.

Next steps:
  1. Open VS Code (or Cursor)
  2. Command Palette → "Developer: Reload Window"
  3. Open the Claude Code panel and chat

Notes:
  - Real auth is from: grok login  (~/.grok/auth.json)  or XAI_API_KEY
  - To undo:  ./install-vscode.sh --uninstall
  - CLI helper: ./claude-with-grok.sh
EOF
}

if [[ "$UNINSTALL" -eq 1 ]]; then
  do_uninstall
else
  do_install
fi
