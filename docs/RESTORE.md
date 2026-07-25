# Wiederherstellung (Restore)

> **Vorab:** Du brauchst die Borg-**Passphrase** (`/root/.borg-passphrase`) —
> bei Total­verlust des Servers die extern gesicherte Kopie + Key-Export.

## Szenario A: Einzelne Daten zurückholen (Server läuft noch)

```bash
export BORG_PASSPHRASE=$(cat /root/.borg-passphrase)
export BORG_RSH="ssh -p23"
REPO="uXXXXXX@uXXXXXX.your-storagebox.de:backups/<server>-borg"

# Verfügbare Stände anzeigen
borg list "$REPO"

# Stand in Temp-Verzeichnis extrahieren
mkdir -p /tmp/restore && cd /tmp/restore
borg extract "$REPO::mailcow-2026-07-25"

# Danach mit dem mailcow-Restore-Skript einspielen:
export MAILCOW_BACKUP_LOCATION=/tmp/restore/opt/mailcow-backups
/opt/mailcow-dockerized/helper-scripts/backup_and_restore.sh restore
# → interaktiv Komponenten wählen (vmail, mysql, redis, …)
```

## Szenario B: Kompletter Server-Neuaufbau (Disaster Recovery)

1. **Neuen Server** mit Debian + Docker + docker compose aufsetzen
2. **mailcow klonen** (gleiche Version wie zuvor empfohlen):
   ```bash
   git clone https://github.com/mailcow/mailcow-dockerized /opt/mailcow-dockerized
   ```
3. **Borg installieren & Zugang wiederherstellen:**
   ```bash
   apt-get install -y borgbackup
   # Passphrase aus externem Backup wieder ablegen:
   echo '<PASSPHRASE>' > /root/.borg-passphrase && chmod 600 /root/.borg-passphrase
   # SSH-Key fürs Ziel wieder einrichten/hinterlegen
   ```
4. **Backup extrahieren:**
   ```bash
   export BORG_PASSPHRASE=$(cat /root/.borg-passphrase)
   export BORG_RSH="ssh -p23"
   borg list "u…:backups/mailcow-borg"                # Stand wählen
   mkdir -p /restore && cd /restore
   borg extract "u…:backups/mailcow-borg::mailcow-2026-07-25"
   ```
5. **mailcow.conf zurückspielen** (liegt im Backup) und Stack einmal starten:
   ```bash
   cp /restore/opt/mailcow-backups/mailcow-*/mailcow.conf /opt/mailcow-dockerized/
   cd /opt/mailcow-dockerized && docker compose pull && docker compose up -d
   ```
6. **Restore ausführen:**
   ```bash
   export MAILCOW_BACKUP_LOCATION=/restore/opt/mailcow-backups
   /opt/mailcow-dockerized/helper-scripts/backup_and_restore.sh restore
   # → "all" wählen
   ```
7. DNS/Firewall prüfen (MX, PTR, Ports 25/443/465/587/993), Mailflow testen.

## Szenario C: Nur eine Mailbox

```bash
# Stand extrahieren (wie A), dann gezielt das Maildir kopieren:
cp -a /tmp/restore/.../vmail/<domain>/<user>/Maildir \
      /var/lib/docker/volumes/mailcowdockerized_vmail-vol-1/_data/<domain>/<user>/
# Rechte: vmail hat UID/GID 5000
chown -R 5000:5000 /var/lib/docker/volumes/mailcowdockerized_vmail-vol-1/_data/<domain>/<user>
# Dovecot neu indizieren:
cd /opt/mailcow-dockerized
docker compose exec dovecot-mailcow doveadm force-resync -u <user>@<domain> '*'
```

## Restore-Test (empfohlen: quartalsweise)

Mindestens `borg list` + Probe-Extraktion einer kleinen Datei — nur ein
getestetes Backup ist ein Backup.

### Automatisierter Verify-Agent (ergänzend, kein Ersatz)

Die Agent-Suite bringt einen **Verify-Agent** mit, der wöchentlich automatisch
das jüngste Archiv extrahiert und die Integrität jeder Komponente prüft (siehe
[docs/AGENTS.md](AGENTS.md#verify-agent-mailcow-verifysh)). Das bestätigt, dass
die Archivdateien lesbar sind — **nicht**, dass eine vollständige
Wiederherstellung tatsächlich funktioniert. Die manuelle, quartalsweise
Restore-Probe aus diesem Dokument bleibt weiterhin notwendig.

```bash
# Manueller Testlauf des Verify-Agents:
/usr/local/sbin/mailcow-verify.sh
tail -f /var/log/mailcow-verify.log
```
