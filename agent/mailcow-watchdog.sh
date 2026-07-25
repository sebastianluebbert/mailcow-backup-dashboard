#!/bin/bash
# ============================================================================
# Mailcow Backup Suite — Watchdog-Agent
# Leichte, häufige Kontrolle zwischen den Backup-Läufen: Speicherplatz am
# Backup-Ziel, Erreichbarkeit des Borg-Repos, Alter des letzten erfolgreichen
# Backups (lokal, unabhängig vom Dashboard) und grober Zustand des Mailcow-
# Stacks. Kein 'set -e': einzelne Prüfungen dürfen fehlschlagen, ohne dass
# die übrigen Prüfungen ausfallen — erst am Ende wird der Gesamtstatus
# gemeldet.
# Konfiguration in /etc/mailcow-backup.conf
# ============================================================================
set -uo pipefail

AGENT_LIB="/usr/local/lib/mailcow-backup-suite/common.sh"
[ -f "$AGENT_LIB" ] || { echo "FEHLER: $AGENT_LIB fehlt (Suite unvollständig, siehe docs/INSTALL.md)"; exit 1; }
# shellcheck source=/dev/null
. "$AGENT_LIB"

agent_load_config

LOG=/var/log/mailcow-watchdog.log
STATE=/var/log/mailcow-backup.state
START_TS=$(date +%s)

exec >>"$LOG" 2>&1
echo "=== Watchdog-Start: $(date) ==="

# ── Selbst-Update ────────────────────────────────────────────────────────
: "${MAILCOW_AGENT_UPDATED:=0}"
if [ "$MAILCOW_AGENT_UPDATED" != 1 ]; then
  UPDATED=0
  agent_fetch_and_replace "lib-common" "$AGENT_LIB" && UPDATED=1
  agent_fetch_and_replace "mailcow-watchdog" "$0" && UPDATED=1
  if [ "$UPDATED" = 1 ]; then
    echo "Selbst-Update: neue Suite-Version übernommen, starte neu."
    MAILCOW_AGENT_UPDATED=1 exec "$0" "$@"
  fi
fi

PROBLEMS=()

# 1) Lokaler Speicherplatz am Backup-Ziel
mkdir -p "$BACKUP_LOCATION" 2>/dev/null || true
DISK_PERCENT=$(agent_disk_usage_percent "$BACKUP_LOCATION")
if [ -n "$DISK_PERCENT" ]; then
  echo "Speicherplatz $BACKUP_LOCATION: ${DISK_PERCENT}% belegt"
  if [ "$DISK_PERCENT" -ge "$WATCHDOG_DISK_ERROR_PERCENT" ]; then
    PROBLEMS+=("Speicherplatz kritisch: ${DISK_PERCENT}% belegt (Schwelle ${WATCHDOG_DISK_ERROR_PERCENT}%)")
  elif [ "$DISK_PERCENT" -ge "$WATCHDOG_DISK_WARN_PERCENT" ]; then
    PROBLEMS+=("Speicherplatz knapp: ${DISK_PERCENT}% belegt (Schwelle ${WATCHDOG_DISK_WARN_PERCENT}%)")
  fi
else
  echo "Speicherplatz konnte nicht ermittelt werden"
fi

# 2) Erreichbarkeit des Borg-Ziels
BORG_HOST="${BORG_REPO%%:*}"
if timeout 15 ssh -p "$BORG_SSH_PORT" -o BatchMode=yes -o ConnectTimeout=10 \
     -o StrictHostKeyChecking=accept-new "$BORG_HOST" true 2>/dev/null; then
  echo "Borg-Ziel erreichbar: $BORG_HOST:$BORG_SSH_PORT"
else
  PROBLEMS+=("Borg-Ziel nicht erreichbar: $BORG_HOST:$BORG_SSH_PORT")
fi

# 3) Alter des letzten erfolgreichen Backups (lokaler Zustand, unabhängig
#    vom Dashboard — funktioniert auch, wenn das Dashboard selbst offline ist)
if [ -f "$STATE" ]; then
  LAST_SUCCESS=$(awk -F= '/^last_success_ts=/{print $2; exit}' "$STATE" 2>/dev/null || true)
  if [ -n "$LAST_SUCCESS" ]; then
    AGE_HOURS=$(( (START_TS - LAST_SUCCESS) / 3600 ))
    echo "Letztes erfolgreiches Backup vor ${AGE_HOURS}h"
    if [ "$AGE_HOURS" -ge "$WATCHDOG_STALE_HOURS" ]; then
      PROBLEMS+=("Kein erfolgreiches Backup seit ${AGE_HOURS}h (Schwelle ${WATCHDOG_STALE_HOURS}h)")
    fi
  fi
else
  echo "Noch kein lokaler Backup-Status vorhanden (Zustandsdatei fehlt)"
fi

# 4) Grober Zustand des Mailcow-Stacks (best effort, bricht nie hart ab)
if command -v docker >/dev/null 2>&1; then
  if [ -n "$(docker ps -qf name=watchdog-mailcow 2>/dev/null)" ]; then
    echo "Mailcow-Stack: watchdog-mailcow läuft"
  else
    PROBLEMS+=("Mailcow-Container watchdog-mailcow läuft nicht")
  fi
fi

DUR=$(( $(date +%s) - START_TS ))
if [ ${#PROBLEMS[@]} -eq 0 ]; then
  echo "=== Watchdog-Ende OK: $(date) ==="
  agent_report watchdog ok "Alle Prüfungen unauffällig" "\"duration_s\":$DUR"
  exit 0
else
  MESSAGE=$(printf '%s; ' "${PROBLEMS[@]}")
  echo "=== Watchdog-Ende FEHLER: $(date) — $MESSAGE ==="
  agent_report watchdog error "$MESSAGE" "\"duration_s\":$DUR"
  exit 1
fi
