#!/bin/bash
# ============================================================================
# Installer: Mailcow Backup Agent
# Verwendung (auf dem Mailcow-Server als root):
#   bash install-agent.sh
# Fragt alle Werte interaktiv ab und richtet Borg + Cron + Dashboard-Report ein.
# ============================================================================
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "Bitte als root ausführen."; exit 1; }

echo "── Mailcow Backup Agent — Installation ──────────────────"

read -rp "Storage-Box/Borg-Ziel (z.B. u123456@u123456.your-storagebox.de:backups/mailcow-borg): " BORG_REPO
read -rp "SSH-Port des Ziels [23]: " BORG_SSH_PORT; BORG_SSH_PORT=${BORG_SSH_PORT:-23}
read -rp "Aufbewahrung in Tagen [7]: " KEEP_DAILY; KEEP_DAILY=${KEEP_DAILY:-7}
read -rp "Dashboard-URL (leer = kein Reporting, z.B. http://<dashboard-ip>:8080): " DASH_URL
DASH_TOKEN=""
[ -n "$DASH_URL" ] && read -rp "Dashboard-Agent-Token: " DASH_TOKEN
read -rp "Backup-Uhrzeit (Stunde 0-23) [3]: " HOUR; HOUR=${HOUR:-3}
read -rp "mailcow-Verzeichnis [/opt/mailcow-dockerized]: " MAILCOW_DIR; MAILCOW_DIR=${MAILCOW_DIR:-/opt/mailcow-dockerized}

[ -f "$MAILCOW_DIR/helper-scripts/backup_and_restore.sh" ] || { echo "FEHLER: mailcow nicht unter $MAILCOW_DIR gefunden."; exit 1; }

echo "→ Pakete installieren…"
apt-get update -qq && apt-get install -y -qq borgbackup curl >/dev/null

echo "→ SSH-Key prüfen…"
[ -f /root/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N "" -f /root/.ssh/id_ed25519 -q
echo "  Öffentlicher Key (muss auf dem Backup-Ziel hinterlegt sein):"
echo "  $(cat /root/.ssh/id_ed25519.pub)"
read -rp "  Key ist auf dem Ziel hinterlegt? [j/N] " OK
[ "${OK,,}" = j ] || { echo "Bitte Key hinterlegen (Hetzner: ssh -p23 ... install-ssh-key) und erneut starten."; exit 1; }

echo "→ Borg-Passphrase erzeugen (falls nicht vorhanden)…"
if [ ! -f /root/.borg-passphrase ]; then
  openssl rand -base64 32 > /root/.borg-passphrase
  chmod 600 /root/.borg-passphrase
  echo "  NEUE PASSPHRASE: $(cat /root/.borg-passphrase)"
  echo "  ⚠ EXTERN SICHERN (Passwortmanager) — ohne sie ist das Backup unlesbar!"
fi

export BORG_PASSPHRASE; BORG_PASSPHRASE=$(cat /root/.borg-passphrase)
export BORG_RSH="ssh -p$BORG_SSH_PORT"

echo "→ Borg-Repo initialisieren (falls neu)…"
if ! borg info "$BORG_REPO" >/dev/null 2>&1; then
  ssh -p"$BORG_SSH_PORT" "${BORG_REPO%%:*}" mkdir -p "$(dirname "${BORG_REPO#*:}")" 2>/dev/null || true
  borg init --encryption=repokey-blake2 "$BORG_REPO"
  borg key export "$BORG_REPO" /root/borg-key-backup.txt && chmod 600 /root/borg-key-backup.txt
  echo "  Key-Export: /root/borg-key-backup.txt — ebenfalls extern sichern!"
fi

echo "→ Konfiguration schreiben…"
cat > /etc/mailcow-backup.conf <<EOF
MAILCOW_DIR="$MAILCOW_DIR"
BACKUP_LOCATION="/opt/mailcow-backups"
BORG_REPO="$BORG_REPO"
BORG_SSH_PORT="$BORG_SSH_PORT"
KEEP_DAILY="$KEEP_DAILY"
THREADS="4"
DASH_URL="$DASH_URL"
DASH_TOKEN="$DASH_TOKEN"
EOF
chmod 600 /etc/mailcow-backup.conf

echo "→ Backup-Skript installieren…"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install -m 700 "$SCRIPT_DIR/mailcow-backup.sh" /usr/local/sbin/mailcow-backup.sh

echo "→ Cron einrichten (täglich ${HOUR}:00)…"
echo "0 $HOUR * * * root /usr/local/sbin/mailcow-backup.sh" > /etc/cron.d/mailcow-backup
chmod 644 /etc/cron.d/mailcow-backup

echo ""
echo "✔ Fertig. Testlauf starten mit:  /usr/local/sbin/mailcow-backup.sh"
echo "  Log: /var/log/mailcow-backup.log"
