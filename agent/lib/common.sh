# shellcheck shell=bash
# Mailcow Backup Suite — shared library
# Sourced by mailcow-backup.sh, mailcow-verify.sh and mailcow-watchdog.sh.
# Do not execute this file directly; it defines functions only.

# agent_load_config — reads /etc/mailcow-backup.conf and fills in defaults.
# Exits the caller with an error message if required values are missing.
agent_load_config() {
  local conf="${MAILCOW_AGENT_CONF:-/etc/mailcow-backup.conf}"
  [ -f "$conf" ] || { echo "FEHLER: $conf fehlt (siehe docs/INSTALL.md)"; exit 1; }
  # shellcheck source=/dev/null
  . "$conf"

  : "${MAILCOW_DIR:=/opt/mailcow-dockerized}"
  : "${BACKUP_LOCATION:=/opt/mailcow-backups}"
  : "${BORG_REPO:?BORG_REPO fehlt in $conf}"
  : "${BORG_PASSPHRASE_FILE:=/root/.borg-passphrase}"
  : "${BORG_SSH_PORT:=23}"
  : "${KEEP_DAILY:=7}"
  : "${THREADS:=4}"
  : "${BACKUP_COMPONENTS:=all}"
  : "${DASH_URL:=}"
  : "${DASH_TOKEN:=}"
  : "${SELF_UPDATE:=1}"
  : "${VERIFY_LOCATION:=${BACKUP_LOCATION}/.verify}"
  : "${VERIFY_FULL:=0}"
  : "${WATCHDOG_DISK_WARN_PERCENT:=85}"
  : "${WATCHDOG_DISK_ERROR_PERCENT:=95}"
  : "${WATCHDOG_STALE_HOURS:=26}"

  export MAILCOW_DIR BACKUP_LOCATION BORG_REPO BORG_PASSPHRASE_FILE BORG_SSH_PORT \
    KEEP_DAILY THREADS BACKUP_COMPONENTS DASH_URL DASH_TOKEN SELF_UPDATE \
    VERIFY_LOCATION VERIFY_FULL WATCHDOG_DISK_WARN_PERCENT WATCHDOG_DISK_ERROR_PERCENT \
    WATCHDOG_STALE_HOURS
}

agent_require_root() {
  [ "$(id -u)" = 0 ] || { echo "Bitte als root ausführen."; exit 1; }
}

# agent_borg_env — exports BORG_PASSPHRASE and BORG_RSH for the current run.
agent_borg_env() {
  export BORG_PASSPHRASE
  BORG_PASSPHRASE=$(cat "$BORG_PASSPHRASE_FILE" 2>/dev/null || true)
  export BORG_RSH="ssh -p${BORG_SSH_PORT} -o BatchMode=yes -o ConnectTimeout=10"
}

# agent_json_escape <text> — escapes a string for use as a JSON string value.
agent_json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/}
  s=${s//$'\n'/\\n}
  printf '%s' "$s"
}

# agent_report <kind> <status> <message> [extra-json-fields]
# <kind> is one of backup|verify|watchdog. <extra-json-fields> is a raw,
# already-valid JSON fragment (e.g. '"duration_s":12,"archives":3') that is
# merged into the payload; only <message> is escaped since it is free text.
agent_report() {
  local kind="$1" status="$2" message="$3" extra="${4:-}"
  [ -n "${DASH_URL:-}" ] || return 0
  [ -n "${DASH_TOKEN:-}" ] || return 0
  local escaped payload
  escaped=$(agent_json_escape "$message")
  payload="{\"server\":\"$(hostname -f)\",\"kind\":\"${kind}\",\"status\":\"${status}\""
  [ -n "$extra" ] && payload="${payload},${extra}"
  payload="${payload},\"message\":\"${escaped}\"}"
  curl -s -m 30 -X POST "${DASH_URL}/api/report" \
    -H "Authorization: Bearer ${DASH_TOKEN}" -H 'Content-Type: application/json' \
    -d "$payload" >/dev/null 2>&1 || true
}

# agent_fetch_and_replace <remote-name> <local-path>
# Downloads a suite component from the dashboard (/agent/scripts/<remote-name>)
# and installs it in place of <local-path> if it changed and passes a basic
# sanity check (valid bash syntax + suite marker present). Returns 0 when an
# update was installed, 1 otherwise. Never touches <local-path> on failure.
agent_fetch_and_replace() {
  local remote="$1" local_path="$2"
  [ "${SELF_UPDATE:-1}" = 1 ] || return 1
  [ -n "${DASH_URL:-}" ] || return 1
  [ -n "${DASH_TOKEN:-}" ] || return 1
  local tmp
  tmp=$(mktemp)
  if curl -fsS -m 30 -H "Authorization: Bearer ${DASH_TOKEN}" \
       "${DASH_URL}/agent/scripts/${remote}" -o "$tmp" 2>/dev/null \
     && grep -q "Mailcow Backup Suite" "$tmp" \
     && bash -n "$tmp" 2>/dev/null; then
    if ! cmp -s "$tmp" "$local_path"; then
      install -m 700 "$tmp" "$local_path"
      rm -f "$tmp"
      return 0
    fi
  fi
  rm -f "$tmp"
  return 1
}

# agent_disk_usage_percent <path> — prints the integer percentage of disk
# space used on the filesystem containing <path>, or nothing on failure.
agent_disk_usage_percent() {
  df -P "$1" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}'
}
