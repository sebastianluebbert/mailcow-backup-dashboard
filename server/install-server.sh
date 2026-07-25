#!/bin/bash
# ============================================================================
# Installer: Backup Dashboard (Collector + UI)
# Auf einem Debian-LXC/VM als root ausführen.
# ============================================================================
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Bitte als root ausführen."; exit 1; }

read -rp "HTTP-Port [8080]: " PORT; PORT=${PORT:-8080}

APP=/opt/backupdash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "→ Pakete…"
apt-get update -qq && apt-get install -y -qq python3-venv curl >/dev/null

echo "→ Dateien nach $APP…"
mkdir -p "$APP/data" "$APP/agent"
cp "$SCRIPT_DIR/app.py" "$APP/"
mkdir -p "$APP/static"
cp "$SCRIPT_DIR/static/index.html" "$APP/static/"
# Agent-Skript fürs Enrollment mitliefern
if [ -f "$SCRIPT_DIR/../agent/mailcow-backup.sh" ]; then
  cp "$SCRIPT_DIR/../agent/mailcow-backup.sh" "$APP/agent/"
fi

echo "→ Python-Umgebung…"
python3 -m venv "$APP/venv"
"$APP/venv/bin/pip" install -q fastapi 'uvicorn[standard]' pydantic

if [ -f /etc/backupdash.token ]; then
  TOKEN=$(cat /etc/backupdash.token)
  echo "→ Bestehender API-Token wird weiterverwendet."
else
  TOKEN=$(openssl rand -hex 24)
  echo "$TOKEN" > /etc/backupdash.token
  chmod 600 /etc/backupdash.token
fi

echo "→ systemd-Service…"
cat > /etc/systemd/system/backupdash.service <<EOF
[Unit]
Description=Mailcow Backup Dashboard
After=network.target

[Service]
Environment=DASH_TOKEN=$TOKEN
WorkingDirectory=$APP
ExecStart=$APP/venv/bin/uvicorn app:app --host 0.0.0.0 --port $PORT
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now backupdash
sleep 2

if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 || [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/)" = 200 ]; then
  echo ""
  echo "✔ Dashboard läuft: http://$(hostname -I | awk '{print $1}'):$PORT"
  echo "  API-Token (für Agents): $TOKEN"
  echo "  Token-Datei: /etc/backupdash.token"
else
  echo "⚠ Dienst prüfen: systemctl status backupdash"
fi
