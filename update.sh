#!/bin/bash
# ============================================================================
# Updater: Mailcow Backup Dashboard
# Zieht das neueste Repo und aktualisiert die Dashboard-Installation.
# Aufruf: manuell (bash update.sh) oder über die geschützte Einstellungsseite
# ============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP=/opt/backupdash
LOG=/var/log/backupdash-update.log

exec 9>/run/lock/backupdash-update.lock
if ! flock -n 9; then
  echo "Ein Dashboard-Update läuft bereits." >&2
  exit 1
fi

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
install -m 644 server/static/styles.css "$APP/static/styles.css"
install -m 644 server/static/app.js     "$APP/static/app.js"
mkdir -p "$APP/agent"
install -m 644 agent/mailcow-backup.sh  "$APP/agent/mailcow-backup.sh"

# Der UI-Updater muss auch bei abweichendem Clone-Pfad das Repository finden.
mkdir -p /etc/systemd/system/backupdash.service.d
cat > /etc/systemd/system/backupdash.service.d/repository.conf <<EOF
[Service]
Environment="REPO_DIR=$REPO_DIR"
EOF
systemctl daemon-reload

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
  install -m 644 server/static/styles.css "$APP/static/styles.css"
  install -m 644 server/static/app.js     "$APP/static/app.js"
  install -m 644 agent/mailcow-backup.sh  "$APP/agent/mailcow-backup.sh"
  systemctl restart backupdash
  exit 1
fi
