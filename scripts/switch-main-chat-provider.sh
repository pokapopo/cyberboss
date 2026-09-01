#!/usr/bin/env bash
# Switch Cyberboss main-chat routing without exposing provider credentials.
set -Eeuo pipefail

ROOT_DIR="/root/cyberboss"
ENV_FILE="${ROOT_DIR}/.env"
CC_SWITCH_API="http://127.0.0.1:17666/api/invoke"
TARGET="${1:-}"
RESTART=0

usage() {
  cat <<'EOF'
Usage:
  scripts/switch-main-chat-provider.sh status
  scripts/switch-main-chat-provider.sh opencode-dsv4pro [--restart]
  scripts/switch-main-chat-provider.sh native-deepseek [--restart]

The script switches the main provider to deepseek-v4-pro. It never prints
credentials; --restart is explicit because the WeChat bridge keeps Claude alive.
EOF
}

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1" >&2; exit 1; }; }
invoke() { curl --fail --silent --show-error -X POST "${CC_SWITCH_API}" -H 'Content-Type: application/json' --data-binary "$1"; }

show_status() {
  local provider takeover model effort threshold
  provider="$(invoke '{"command":"get_current_provider","payload":{"app":"claude"}}' | jq -r '.result // "unknown"')"
  takeover="$(invoke '{"command":"get_proxy_takeover_status","payload":{}}' | jq -r '.result.claude // false')"
  model="$(sed -n 's/^CYBERBOSS_CLAUDE_MODEL=//p' "${ENV_FILE}" | tail -n 1)"
  effort="$(sed -n 's/^CYBERBOSS_CLAUDE_EFFORT=//p' "${ENV_FILE}" | tail -n 1)"
  threshold="$(sed -n 's/^CYBERBOSS_AUTO_COMPACT_THRESHOLD_PERCENT=//p' "${ENV_FILE}" | tail -n 1)"
  printf 'provider=%s\nproxy_takeover=%s\nmodel=%s\ndefault_effort=%s\nauto_compact_threshold=%s\n' "$provider" "$takeover" "${model:-default}" "${effort:-default}" "${threshold:-85}"
}

set_env_value() {
  local key="$1" value="$2"
  node - "${ENV_FILE}" "$key" "$value" <<'NODE'
const fs = require("fs");
const [file, key, value] = process.argv.slice(2);
const source = fs.readFileSync(file, "utf8");
const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = new RegExp(`^${escaped}=`);
let found = false;
const lines = source.split(/\r?\n/).map((line) => {
  if (!pattern.test(line)) return line;
  found = true;
  return `${key}=${value}`;
});
if (!found) lines.push(`${key}=${value}`);
const output = `${lines.filter((line, index) => line || index < lines.length - 1).join("\n")}\n`;
fs.writeFileSync(`${file}.tmp`, output, { mode: 0o600 });
fs.renameSync(`${file}.tmp`, file);
NODE
}

switch_opencode() {
  local providers payload
  providers="$(invoke '{"command":"get_providers","payload":{"app":"claude"}}')"
  printf '%s' "$providers" | jq -e '.result["opencode-go-glm52"]' >/dev/null
  payload="$(printf '%s' "$providers" | jq -c '{command:"update_provider",payload:{app:"claude",originalId:"opencode-go-glm52",provider:(.result["opencode-go-glm52"] | .name="OpenCode Go · DeepSeek V4 Pro" | .notes="Cyberboss 主聊天；OpenCode Go deepseek-v4-pro；Claude→OpenAI Chat 本地转换" | .settingsConfig.model="sonnet" | .settingsConfig.env.ANTHROPIC_MODEL="deepseek-v4-pro" | .settingsConfig.env.ANTHROPIC_DEFAULT_SONNET_MODEL="deepseek-v4-pro" | .settingsConfig.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME="DeepSeek V4 Pro" | .settingsConfig.env.ANTHROPIC_DEFAULT_HAIKU_MODEL="deepseek-v4-pro" | .settingsConfig.env.ANTHROPIC_DEFAULT_OPUS_MODEL="deepseek-v4-pro")}}')"
  invoke "$payload" >/dev/null
  invoke '{"command":"switch_provider","payload":{"id":"opencode-go-glm52","app":"claude"}}' >/dev/null
  invoke '{"command":"switch_proxy_provider","payload":{"appType":"claude","providerId":"opencode-go-glm52"}}' >/dev/null
  invoke '{"command":"set_proxy_takeover_for_app","payload":{"appType":"claude","enabled":true}}' >/dev/null
}

switch_native() {
  invoke '{"command":"switch_provider","payload":{"id":"deepseek-v4pro","app":"claude"}}' >/dev/null
  invoke '{"command":"set_proxy_takeover_for_app","payload":{"appType":"claude","enabled":false}}' >/dev/null
}

case "$TARGET" in
  status) need jq; show_status; exit 0 ;;
  opencode-dsv4pro|native-deepseek) ;;
  *) usage >&2; exit 2 ;;
esac
if [[ "${2:-}" == "--restart" && $# -eq 2 ]]; then RESTART=1; elif [[ $# -ne 1 ]]; then usage >&2; exit 2; fi

need curl; need jq
[[ -f "${ENV_FILE}" ]] || { echo "Missing ${ENV_FILE}" >&2; exit 1; }
systemctl is-active --quiet cc-switch-web.service || { echo "cc-switch-web.service is not active" >&2; exit 1; }

backup_dir="/root/.cyberboss/provider-backups/switch-$(date +%Y%m%dT%H%M%S)"
mkdir -p "$backup_dir"
cp -p /root/.claude/settings.json "$backup_dir/claude-settings-before.json"
if [[ "$TARGET" == "opencode-dsv4pro" ]]; then switch_opencode; else switch_native; fi
set_env_value "CYBERBOSS_CLAUDE_MODEL" "deepseek-v4-pro"
echo "Configured ${TARGET}."; show_status; echo "Backup: ${backup_dir}"
if [[ "$RESTART" -eq 1 ]]; then exec "${ROOT_DIR}/scripts/restart-now.sh"; fi
echo "Not restarted; run with --restart after confirming no active WeChat turn."
