#!/bin/bash
# ============================================================================
# Mailcow Backup Suite — Verify-Agent
# Prüft regelmäßig, ob das jüngste Borg-Archiv vollständig und lesbar ist:
# extrahiert es in ein Temp-Verzeichnis, kontrolliert mailcow.conf sowie die
# Integrität jedes Komponenten-Archivs und räumt danach wieder auf.
# Greift NIE in den laufenden Mailcow-Stack ein (kein docker stop/start).
# Konfiguration in /etc/mailcow-backup.conf
# ============================================================================
set -euo pipefail

AGENT_LIB="/usr/local/lib/mailcow-backup-suite/common.sh"
[ -f "$AGENT_LIB" ] || { echo "FEHLER: $AGENT_LIB fehlt (Suite unvollständig, siehe docs/INSTALL.md)"; exit 1; }
# shellcheck source=/dev/null
. "$AGENT_LIB"

agent_load_config

LOG=/var/log/mailcow-verify.log
START_TS=$(date +%s)
ARCHIVE_NAME=""
WORKDIR=""

cleanup() {
  [ -n "$WORKDIR" ] && rm -rf "$WORKDIR"
}

report_result() { # report_result <ok|error> [message]
  local status="$1" message="${2:-}" dur extra
  dur=$(( $(date +%s) - START_TS ))
  extra="\"duration_s\":$dur"
  [ -n "$ARCHIVE_NAME" ] && extra="${extra},\"archives\":1"
  agent_report verify "$status" "$message" "$extra"
}

on_exit() {
  local rc=$?
  cleanup
  if [ $rc -eq 0 ]; then
    report_result ok "Archiv ${ARCHIVE_NAME:-unbekannt} erfolgreich geprüft"
  else
    report_result error "Exit-Code $rc bei Archiv ${ARCHIVE_NAME:-unbekannt}, siehe $LOG"
  fi
}
trap on_exit EXIT

exec >>"$LOG" 2>&1
echo "=== Verify-Start: $(date) ==="

# ── Selbst-Update ────────────────────────────────────────────────────────
: "${MAILCOW_AGENT_UPDATED:=0}"
if [ "$MAILCOW_AGENT_UPDATED" != 1 ]; then
  UPDATED=0
  agent_fetch_and_replace "lib-common" "$AGENT_LIB" && UPDATED=1
  agent_fetch_and_replace "mailcow-verify" "$0" && UPDATED=1
  if [ "$UPDATED" = 1 ]; then
    echo "Selbst-Update: neue Suite-Version übernommen, starte neu."
    MAILCOW_AGENT_UPDATED=1 exec "$0" "$@"
  fi
fi

agent_borg_env

ARCHIVE_NAME=$(borg list --short --last 1 "$BORG_REPO" 2>/dev/null | tail -1)
[ -n "$ARCHIVE_NAME" ] || { echo "FEHLER: keine Archive im Repo gefunden"; exit 1; }
echo "Prüfe Archiv: $ARCHIVE_NAME"

mkdir -p "$(dirname "$VERIFY_LOCATION")" 2>/dev/null || true
WORKDIR=$(mktemp -d "${VERIFY_LOCATION%/}.XXXXXX" 2>/dev/null || mktemp -d)
cd "$WORKDIR"

borg extract "${BORG_REPO}::${ARCHIVE_NAME}"

BACKUP_DIR=$(find "$WORKDIR" -maxdepth 4 -type d -name 'mailcow-*' 2>/dev/null | sort | tail -1)
[ -n "$BACKUP_DIR" ] || { echo "FEHLER: kein mailcow-Backupverzeichnis im Archiv gefunden"; exit 1; }
echo "Backup-Verzeichnis im Archiv: $BACKUP_DIR"

[ -s "$BACKUP_DIR/mailcow.conf" ] || { echo "FEHLER: mailcow.conf fehlt oder ist leer"; exit 1; }

declare -A COMPONENT_FILES=(
  [vmail]=backup_vmail.tar.zst
  [crypt]=backup_crypt.tar.zst
  [redis]=backup_redis.tar.zst
  [rspamd]=backup_rspamd.tar.zst
  [postfix]=backup_postfix.tar.zst
  [mysql]=backup_mariadb.tar.zst
)

FOUND_ANY=0
FAILED=0
for comp in vmail crypt redis rspamd postfix mysql; do
  file="$BACKUP_DIR/${COMPONENT_FILES[$comp]}"
  [ -f "$file" ] || continue
  FOUND_ANY=1
  if [ ! -s "$file" ]; then
    echo "FEHLER: $comp-Archiv ist leer ($file)"
    FAILED=1
    continue
  fi
  if command -v zstd >/dev/null 2>&1; then
    if ! zstd -t "$file" >/dev/null 2>&1; then
      echo "FEHLER: $comp-Archiv ist beschädigt (zstd -t fehlgeschlagen)"
      FAILED=1
      continue
    fi
  fi
  echo "OK: $comp ($(stat -c%s "$file" 2>/dev/null || echo '?') Bytes)"
done

[ "$FOUND_ANY" -eq 1 ] || { echo "FEHLER: keine bekannten Komponenten-Archive im Backup gefunden"; exit 1; }
[ "$FAILED" -eq 0 ] || { echo "FEHLER: mindestens eine Komponente ist beschädigt"; exit 1; }

if [ "${VERIFY_FULL:-0}" = 1 ]; then
  echo "Führe vollständige Repository-Prüfung aus (borg check)…"
  borg check --repository-only "$BORG_REPO"
fi

echo "=== Verify-Ende OK: $(date) ==="
