#!/usr/bin/env bash
# Launch Claude Code using Grok as the model, Claude Code as the harness.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT="${GROK_HARNESS_PORT:-8790}"
HOST="${GROK_HARNESS_HOST:-127.0.0.1}"
MODEL="${GROK_HARNESS_DEFAULT_MODEL:-grok-4.5}"
PROXY_LOG="${GROK_HARNESS_PROXY_LOG:-/tmp/grok-harness-proxy.log}"

need_proxy=1
if curl -fsS "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
  need_proxy=0
fi

if [[ "$need_proxy" -eq 1 ]]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "node is required" >&2
    exit 1
  fi
  GROK_HARNESS_LOG="${GROK_HARNESS_LOG:-0}" \
  GROK_HARNESS_PORT="$PORT" \
  GROK_HARNESS_HOST="$HOST" \
  GROK_HARNESS_DEFAULT_MODEL="$MODEL" \
    nohup node "$ROOT/harness-proxy.mjs" >>"$PROXY_LOG" 2>&1 &
  echo $! > /tmp/grok-harness-proxy.pid
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
fi

SETTINGS="$(mktemp -t claude-grok-settings.XXXXXX.json)"
cleanup() { rm -f "$SETTINGS"; }
trap cleanup EXIT

cat >"$SETTINGS" <<JSON
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://${HOST}:${PORT}",
    "ANTHROPIC_API_KEY": "grok-harness",
    "ANTHROPIC_MODEL": "${MODEL}",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "${MODEL}",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "${MODEL}",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "${MODEL}",
    "ANTHROPIC_SMALL_FAST_MODEL": "${MODEL}",
    "ANTHROPIC_REASONING_MODEL": "${MODEL}",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
JSON

# Avoid shell HTTP proxies hijacking loopback (common Clash :7890 setup).
exec env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy \
  -u ANTHROPIC_AUTH_TOKEN \
  NO_PROXY="*" no_proxy="*" \
  claude --settings "$SETTINGS" --setting-sources "" "$@"
