#!/bin/bash
# ============================================================================
# Updater: Mailcow Backup Dashboard
# Zieht das neueste Repo und aktualisiert die Dashboard-Installation.
# Aufruf: manuell (bash update.sh) oder automatisch via /etc/cron.d/backupdash-update
# ============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP=/opt/backupdash
LOG=/var/log/backupdash-update.log

exec >>"$LOG" 2>&1
echo "=== Update-Check: $(date) ==="

cd "$REPO_DIR"
BEFORE=$(git rev-parse HEAD)
git fetch -q origin
git reset -q --hard origin/main
AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ] && [ "${1:-}" != "--force" ]; then
  echo "Bereits aktuell ($AFTER) — nichts zu tun."
  exit 0
fi

echo "Update: $BEFORE -> $AFTER"

# Server-Dateien deployen
install -m 644 server/app.py            "$APP/app.py"
install -m 644 server/static/index.html "$APP/static/index.html"
mkdir -p "$APP/agent"
install -m 644 agent/mailcow-backup.sh  "$APP/agent/mailcow-backup.sh"

# Abhängigkeiten still nachziehen (falls neue dazukamen)
"$APP/venv/bin/pip" install -q fastapi 'uvicorn[standard]' pydantic 2>/dev/null || true

systemctl restart backupdash
sleep 2
if systemctl is-active -q backupdash; then
  echo "✔ Update erfolgreich, Dienst läuft ($(git log -1 --format='%h %s'))"
else
  echo "✖ FEHLER: Dienst startet nicht — Rollback auf $BEFORE"
  git reset -q --hard "$BEFORE"
  install -m 644 server/app.py            "$APP/app.py"
  install -m 644 server/static/index.html "$APP/static/index.html"
  install -m 644 agent/mailcow-backup.sh  "$APP/agent/mailcow-backup.sh"
  systemctl restart backupdash
  exit 1
fi
