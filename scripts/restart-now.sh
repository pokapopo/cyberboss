#!/usr/bin/env bash
# Safely restart the systemd-managed Cyberboss service and verify bootstrap.
set -Eeuo pipefail

SERVICE="cyberboss.service"
WORK_LOG="/root/.cyberboss/work-log.json"
LOCK_FILE="/run/lock/cyberboss-restart.lock"
FORCE=0

if [[ "${1:-}" == "--force" ]]; then
  FORCE=1
elif [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--force]" >&2
  exit 2
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "This script must run as root." >&2
  exit 1
fi

exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "Another Cyberboss restart is already in progress." >&2
  exit 1
fi

if ! systemctl cat "${SERVICE}" >/dev/null 2>&1; then
  echo "${SERVICE} is not installed." >&2
  exit 1
fi

active_runs="$(node - "${WORK_LOG}" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
try {
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  const count = (Array.isArray(state.records) ? state.records : [])
    .filter((item) => item?.executionStatus === "running").length;
  process.stdout.write(String(count));
} catch {
  process.stdout.write("0");
}
NODE
)"

if [[ "${active_runs}" -gt 0 && "${FORCE}" -ne 1 ]]; then
  echo "Refusing to restart: ${active_runs} Cyberboss task(s) are still running." >&2
  echo "Wait for them to finish, or use --force only after checking their state." >&2
  exit 3
fi

old_pid="$(systemctl show "${SERVICE}" -p MainPID --value)"
started_at="$(date --iso-8601=seconds)"
echo "Restarting ${SERVICE} (old PID ${old_pid:-0})..."
systemctl restart "${SERVICE}"

new_pid=""
for _ in $(seq 1 45); do
  if systemctl is-active --quiet "${SERVICE}"; then
    new_pid="$(systemctl show "${SERVICE}" -p MainPID --value)"
    if [[ -n "${new_pid}" && "${new_pid}" != "0" ]]; then
      logs="$(journalctl -u "${SERVICE}" _PID="${new_pid}" --since "${started_at}" --no-pager 2>/dev/null || true)"
      if grep -q "bootstrap ok" <<<"${logs}" \
        && grep -q "bridge loop started" <<<"${logs}" \
        && grep -q "background pollers enabled" <<<"${logs}"; then
        echo "${SERVICE} is healthy (new PID ${new_pid})."
        exit 0
      fi
    fi
  fi
  sleep 1
done

echo "${SERVICE} did not complete its bootstrap health check within 45 seconds." >&2
systemctl --no-pager --full status "${SERVICE}" >&2 || true
journalctl -u "${SERVICE}" --since "${started_at}" -n 80 --no-pager >&2 || true
exit 1
