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
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "→ Pakete…"
apt-get update -qq && apt-get install -y -qq python3-venv curl git >/dev/null

echo "→ Dateien nach $APP…"
mkdir -p "$APP/data" "$APP/agent"
cp "$SCRIPT_DIR/app.py" "$SCRIPT_DIR/db.py" "$SCRIPT_DIR/auth.py" "$APP/"
install -m 644 "$SCRIPT_DIR/requirements.txt" "$APP/requirements.txt"
mkdir -p "$APP/static"
install -m 644 "$SCRIPT_DIR/static/index.html" "$APP/static/index.html"
install -m 644 "$SCRIPT_DIR/static/styles.css" "$APP/static/styles.css"
install -m 644 "$SCRIPT_DIR/static/app.js" "$APP/static/app.js"
# Agent-Suite fürs Enrollment und die Self-Update-Endpunkte mitliefern
AGENT_SRC="$SCRIPT_DIR/../agent"
if [ -d "$AGENT_SRC" ]; then
  mkdir -p "$APP/agent/lib"
  for f in mailcow-backup.sh mailcow-verify.sh mailcow-watchdog.sh; do
    [ -f "$AGENT_SRC/$f" ] && install -m 644 "$AGENT_SRC/$f" "$APP/agent/$f"
  done
  [ -f "$AGENT_SRC/lib/common.sh" ] && install -m 644 "$AGENT_SRC/lib/common.sh" "$APP/agent/lib/common.sh"
fi

echo "→ Python-Umgebung…"
python3 -m venv "$APP/venv"
"$APP/venv/bin/pip" install -q -r "$APP/requirements.txt"

if [ -f /etc/backupdash.token ]; then
  TOKEN=$(cat /etc/backupdash.token)
  echo "→ Bestehender API-Token wird weiterverwendet."
else
  TOKEN=$(openssl rand -hex 24)
  echo "$TOKEN" > /etc/backupdash.token
  chmod 600 /etc/backupdash.token
fi

# Menschliche Logins laufen über echte Benutzerkonten (Passwort + optional
# TOTP/Passkey), nicht mehr über einen geteilten Admin-Token. Ein Bootstrap-
# Konto wird beim ersten Start angelegt, sofern noch keine Benutzer existieren
# — danach ist die Variable wirkungslos und kann gefahrlos gesetzt bleiben.
echo "→ Administrator-Konto…"
read -rp "Admin-Benutzername [admin]: " BOOTSTRAP_USER
BOOTSTRAP_USER=${BOOTSTRAP_USER:-admin}
if [ -f /etc/backupdash.bootstrap.password ]; then
  BOOTSTRAP_PASSWORD=$(cat /etc/backupdash.bootstrap.password)
  echo "→ Bestehendes Bootstrap-Passwort wird weiterverwendet."
else
  BOOTSTRAP_PASSWORD=$(openssl rand -base64 18)
  echo "$BOOTSTRAP_PASSWORD" > /etc/backupdash.bootstrap.password
  chmod 600 /etc/backupdash.bootstrap.password
fi

echo "→ systemd-Service…"
cat > /etc/systemd/system/backupdash.service <<EOF
[Unit]
Description=Mailcow Backup Dashboard
After=network.target

[Service]
Environment="DASH_TOKEN=$TOKEN"
Environment="DASH_BOOTSTRAP_USER=$BOOTSTRAP_USER"
Environment="DASH_BOOTSTRAP_PASSWORD=$BOOTSTRAP_PASSWORD"
Environment="REPO_DIR=$REPO_DIR"
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
  echo "  Agent-Token (für Server-Enrollment): $TOKEN"
  echo "  Erster Login: Benutzername '$BOOTSTRAP_USER', Passwort siehe /etc/backupdash.bootstrap.password"
  echo "  ⚠ Bitte nach dem ersten Login das Passwort ändern und Zwei-Faktor-Authentifizierung"
  echo "    unter Konto einrichten. Fehlt eine Bootstrap-Konfiguration, richtet die"
  echo "    Weboberfläche das erste Konto beim ersten Aufruf selbst ein."
else
  echo "⚠ Dienst prüfen: systemctl status backupdash"
fi
