#!/bin/bash
# ============================================================================
# Mailcow Backup Agent — Vollbackup -> Borg-Repo (verschlüsselt) + Dashboard-Report
# Konfiguration in /etc/mailcow-backup.conf
# ============================================================================
set -euo pipefail

CONF=/etc/mailcow-backup.conf
[ -f "$CONF" ] || { echo "FEHLER: $CONF fehlt (siehe docs/INSTALL.md)"; exit 1; }
# shellcheck source=/dev/null
. "$CONF"

: "${MAILCOW_DIR:=/opt/mailcow-dockerized}"
: "${BACKUP_LOCATION:=/opt/mailcow-backups}"
: "${BORG_REPO:?BORG_REPO fehlt in $CONF}"
: "${BORG_PASSPHRASE_FILE:=/root/.borg-passphrase}"
: "${BORG_SSH_PORT:=23}"
: "${KEEP_DAILY:=7}"
: "${THREADS:=4}"
: "${DASH_URL:=}"
: "${DASH_TOKEN:=}"

LOG=/var/log/mailcow-backup.log
START_TS=$(date +%s)

report() { # report <ok|error> [message]
  [ -n "$DASH_URL" ] || return 0
  local STATUS="$1" MESSAGE="${2:-}" DUR ARCHIVES REPO_KB REPO_GB LAST_GB
  DUR=$(( $(date +%s) - START_TS ))
  ARCHIVES=$(borg list --short "$BORG_REPO" 2>/dev/null | wc -l || echo 0)
  REPO_KB=$(ssh -p"$BORG_SSH_PORT" "${BORG_REPO%%:*}" du -s "${BORG_REPO#*:}" 2>/dev/null | awk '{print $1}' || echo 0)
  REPO_GB=$(awk -v k="${REPO_KB:-0}" 'BEGIN{printf "%.1f", k/1048576}')
  LAST_GB=$(borg info "$BORG_REPO" --last 1 2>/dev/null | awk '/This archive/{print $3}' || echo 0)
  curl -s -m 30 -X POST "$DASH_URL/api/report" \
    -H "Authorization: Bearer $DASH_TOKEN" -H 'Content-Type: application/json' \
    -d "{\"server\":\"$(hostname -f)\",\"status\":\"$STATUS\",\"duration_s\":$DUR,\"backup_gb\":${LAST_GB:-0},\"repo_gb\":$REPO_GB,\"archives\":$ARCHIVES,\"message\":\"$MESSAGE\"}" \
    >/dev/null 2>&1 || true
}

on_exit() {
  RC=$?
  if [ $RC -eq 0 ]; then report ok; else report error "Exit-Code $RC, siehe $LOG"; fi
}
trap on_exit EXIT

exec >>"$LOG" 2>&1
echo "=== Backup-Start: $(date) ==="

export BORG_PASSPHRASE; BORG_PASSPHRASE=$(cat "$BORG_PASSPHRASE_FILE")
export BORG_RSH="ssh -p$BORG_SSH_PORT"
export MAILCOW_BACKUP_LOCATION="$BACKUP_LOCATION"
mkdir -p "$BACKUP_LOCATION"

# 1) Konsistentes mailcow-Vollbackup (alle Komponenten) lokal erzeugen
THREADS=$THREADS "$MAILCOW_DIR/helper-scripts/backup_and_restore.sh" backup all

LATEST=$(ls -1d "${BACKUP_LOCATION}"/mailcow-* 2>/dev/null | sort | tail -1)
[ -n "$LATEST" ] || { echo "FEHLER: kein Backup-Verzeichnis erzeugt"; exit 1; }
echo "Archiviere: $LATEST"

# 2) Verschlüsselt + dedupliziert ins Borg-Repo
borg create --stats --compression zstd,3 "$BORG_REPO::mailcow-{now:%Y-%m-%d_%H%M}" "$LATEST"

# 3) Aufbewahrung
borg prune --list --keep-daily "$KEEP_DAILY" "$BORG_REPO"
borg compact "$BORG_REPO" 2>/dev/null || true

# 4) Lokal aufräumen
rm -rf "${BACKUP_LOCATION:?}"/mailcow-*

echo "=== Backup-Ende OK: $(date) ==="
