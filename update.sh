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

# Abhängigkeiten vor dem Dateitausch installieren. Ein Paketfehler lässt damit
# den weiterhin laufenden Stand unverändert.
"$APP/venv/bin/pip" install -q -r server/requirements.txt

# Server-Dateien deployen
install -m 644 server/app.py            "$APP/app.py"
install -m 644 server/db.py             "$APP/db.py"
install -m 644 server/auth.py           "$APP/auth.py"
install -m 644 server/requirements.txt   "$APP/requirements.txt"
install -m 644 server/static/index.html "$APP/static/index.html"
install -m 644 server/static/styles.css "$APP/static/styles.css"
install -m 644 server/static/app.js     "$APP/static/app.js"
mkdir -p "$APP/agent/lib"
install -m 644 agent/mailcow-backup.sh   "$APP/agent/mailcow-backup.sh"
install -m 644 agent/mailcow-verify.sh   "$APP/agent/mailcow-verify.sh"
install -m 644 agent/mailcow-watchdog.sh "$APP/agent/mailcow-watchdog.sh"
install -m 644 agent/lib/common.sh       "$APP/agent/lib/common.sh"

# Der UI-Updater muss auch bei abweichendem Clone-Pfad das Repository finden.
mkdir -p /etc/systemd/system/backupdash.service.d
cat > /etc/systemd/system/backupdash.service.d/repository.conf <<EOF
[Service]
Environment="REPO_DIR=$REPO_DIR"
EOF
systemctl daemon-reload

systemctl restart backupdash
sleep 2
if systemctl is-active -q backupdash; then
  echo "✔ Update erfolgreich, Dienst läuft ($(git log -1 --format='%h %s'))"
else
  echo "✖ FEHLER: Dienst startet nicht — Rollback auf $BEFORE"
  git reset -q --hard "$BEFORE"
  install -m 644 server/app.py            "$APP/app.py"
  if [ -f server/db.py ]; then
    install -m 644 server/db.py   "$APP/db.py"
    install -m 644 server/auth.py "$APP/auth.py"
  else
    rm -f "$APP/db.py" "$APP/auth.py"
  fi
  install -m 644 server/static/index.html "$APP/static/index.html"
  mkdir -p "$APP/agent/lib"
  install -m 644 agent/mailcow-backup.sh   "$APP/agent/mailcow-backup.sh"
  if [ -f agent/mailcow-verify.sh ]; then
    install -m 644 agent/mailcow-verify.sh   "$APP/agent/mailcow-verify.sh"
    install -m 644 agent/mailcow-watchdog.sh "$APP/agent/mailcow-watchdog.sh"
    install -m 644 agent/lib/common.sh       "$APP/agent/lib/common.sh"
  else
    rm -f "$APP/agent/mailcow-verify.sh" "$APP/agent/mailcow-watchdog.sh" "$APP/agent/lib/common.sh"
  fi
  if [ -f server/static/styles.css ]; then
    install -m 644 server/static/styles.css "$APP/static/styles.css"
    install -m 644 server/static/app.js     "$APP/static/app.js"
  else
    rm -f "$APP/static/styles.css" "$APP/static/app.js"
  fi
  if [ -f server/requirements.txt ]; then
    install -m 644 server/requirements.txt "$APP/requirements.txt"
    "$APP/venv/bin/pip" install -q -r "$APP/requirements.txt"
  else
    rm -f "$APP/requirements.txt"
    "$APP/venv/bin/pip" install -q fastapi 'uvicorn[standard]' pydantic
  fi
  systemctl restart backupdash
  exit 1
fi
