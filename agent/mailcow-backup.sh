#!/bin/bash
# ============================================================================
# Mailcow Backup Suite — Backup-Agent
# Erzeugt ein Mailcow-Backup der gewählten Komponenten (Standard: alle),
# archiviert es verschlüsselt via Borg und meldet Ergebnis + Komponenten-
# Aufschlüsselung an das Dashboard.
# Konfiguration in /etc/mailcow-backup.conf
# ============================================================================
set -euo pipefail

AGENT_LIB="/usr/local/lib/mailcow-backup-suite/common.sh"
[ -f "$AGENT_LIB" ] || { echo "FEHLER: $AGENT_LIB fehlt (Suite unvollständig, siehe docs/INSTALL.md)"; exit 1; }
# shellcheck source=/dev/null
. "$AGENT_LIB"

agent_load_config

LOG=/var/log/mailcow-backup.log
STATE=/var/log/mailcow-backup.state
START_TS=$(date +%s)
COMPONENTS_JSON=""

# Von mailcows helper-scripts/backup_and_restore.sh unterstützte Komponenten.
VALID_COMPONENTS="vmail crypt redis rspamd postfix mysql all"
declare -A SEEN_COMPONENTS=()
COMPONENT_ARGS=()
IFS=',' read -ra RAW_COMPONENTS <<< "$BACKUP_COMPONENTS"
for raw in "${RAW_COMPONENTS[@]}"; do
  c="$(echo "$raw" | tr -d '[:space:]')"
  [ -z "$c" ] && continue
  if [[ " $VALID_COMPONENTS " != *" $c "* ]]; then
    echo "FEHLER: unbekannte BACKUP_COMPONENTS-Komponente '$c' (erlaubt: $VALID_COMPONENTS)" >&2
    exit 1
  fi
  [ -n "${SEEN_COMPONENTS[$c]:-}" ] && continue
  SEEN_COMPONENTS[$c]=1
  COMPONENT_ARGS+=("$c")
done
[ ${#COMPONENT_ARGS[@]} -gt 0 ] || COMPONENT_ARGS=(all)

report_result() { # report_result <ok|error> [message]
  local status="$1" message="${2:-}" dur archives repo_kb repo_gb last_gb extra
  dur=$(( $(date +%s) - START_TS ))
  archives=$(borg list --short "$BORG_REPO" 2>/dev/null | wc -l || echo 0)
  repo_kb=$(ssh -p"$BORG_SSH_PORT" -o BatchMode=yes -o ConnectTimeout=10 \
    "${BORG_REPO%%:*}" du -s "${BORG_REPO#*:}" 2>/dev/null | awk '{print $1}' || echo 0)
  repo_gb=$(awk -v k="${repo_kb:-0}" 'BEGIN{printf "%.1f", k/1048576}')
  last_gb=$(borg info "$BORG_REPO" --last 1 2>/dev/null | awk '/This archive/{print $3}' || echo 0)
  extra="\"duration_s\":$dur,\"backup_gb\":${last_gb:-0},\"repo_gb\":$repo_gb,\"archives\":$archives"
  [ -n "$COMPONENTS_JSON" ] && extra="${extra},\"components\":${COMPONENTS_JSON}"
  agent_report backup "$status" "$message" "$extra"
  if [ "$status" = ok ]; then
    printf 'last_success_ts=%s\nlast_status=ok\n' "$(date +%s)" > "$STATE"
  else
    { printf 'last_status=error\n'; printf 'last_error_ts=%s\n' "$(date +%s)"; } >> "$STATE" 2>/dev/null || true
  fi
}

on_exit() {
  local rc=$?
  if [ $rc -eq 0 ]; then report_result ok; else report_result error "Exit-Code $rc, siehe $LOG"; fi
}
trap on_exit EXIT

exec >>"$LOG" 2>&1
echo "=== Backup-Start: $(date) — Komponenten: ${COMPONENT_ARGS[*]} ==="

# ── Selbst-Update: neueste Suite-Version vom Dashboard holen ────────────────
: "${MAILCOW_AGENT_UPDATED:=0}"
if [ "$MAILCOW_AGENT_UPDATED" != 1 ]; then
  UPDATED=0
  agent_fetch_and_replace "lib-common" "$AGENT_LIB" && UPDATED=1
  agent_fetch_and_replace "mailcow-backup" "$0" && UPDATED=1
  if [ "$UPDATED" = 1 ]; then
    echo "Selbst-Update: neue Suite-Version übernommen, starte neu."
    MAILCOW_AGENT_UPDATED=1 exec "$0" "$@"
  fi
fi

agent_borg_env
export MAILCOW_BACKUP_LOCATION="$BACKUP_LOCATION"
mkdir -p "$BACKUP_LOCATION"

# 1) Mailcow-Backup der gewählten Komponenten lokal erzeugen (ein einziger
#    Aufruf, damit alle Komponenten im selben Zeitstempel-Verzeichnis landen)
THREADS=$THREADS "$MAILCOW_DIR/helper-scripts/backup_and_restore.sh" backup "${COMPONENT_ARGS[@]}"

LATEST=$(ls -1d "${BACKUP_LOCATION}"/mailcow-* 2>/dev/null | sort | tail -1)
[ -n "$LATEST" ] || { echo "FEHLER: kein Backup-Verzeichnis erzeugt"; exit 1; }
echo "Archiviere: $LATEST"

# 2) Erzeugte Komponenten-Archive prüfen und für den Report protokollieren
declare -A COMPONENT_FILES=(
  [vmail]=backup_vmail.tar.zst
  [crypt]=backup_crypt.tar.zst
  [redis]=backup_redis.tar.zst
  [rspamd]=backup_rspamd.tar.zst
  [postfix]=backup_postfix.tar.zst
  [mysql]=backup_mariadb.tar.zst
)
CHECK_COMPONENTS=(vmail crypt redis rspamd postfix mysql)
for c in "${COMPONENT_ARGS[@]}"; do
  if [ "$c" != all ]; then
    CHECK_COMPONENTS=("${COMPONENT_ARGS[@]}")
  fi
done

COMPONENTS_JSON="{"
first=1
for comp in "${CHECK_COMPONENTS[@]}"; do
  file="${COMPONENT_FILES[$comp]:-}"
  [ -n "$file" ] || continue
  path="$LATEST/$file"
  if [ -f "$path" ]; then
    size=$(stat -c%s "$path" 2>/dev/null || echo 0)
    present=true
  else
    size=0
    present=false
  fi
  [ $first -eq 1 ] || COMPONENTS_JSON="${COMPONENTS_JSON},"
  COMPONENTS_JSON="${COMPONENTS_JSON}\"${comp}\":{\"present\":${present},\"bytes\":${size}}"
  first=0
done
COMPONENTS_JSON="${COMPONENTS_JSON}}"

# 3) Verschlüsselt + dedupliziert ins Borg-Repo
borg create --stats --compression zstd,3 "$BORG_REPO::mailcow-{now:%Y-%m-%d_%H%M}" "$LATEST"

# 4) Aufbewahrung
borg prune --list --keep-daily "$KEEP_DAILY" "$BORG_REPO"
borg compact "$BORG_REPO" 2>/dev/null || true

# 5) Lokal aufräumen
rm -rf "${BACKUP_LOCATION:?}"/mailcow-*

echo "=== Backup-Ende OK: $(date) ==="
