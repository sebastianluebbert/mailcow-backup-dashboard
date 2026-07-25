# Installation

## Voraussetzungen

| Komponente | Anforderung |
|-----------|-------------|
| Dashboard-Host | Debian 12/13 (LXC oder VM), Python 3.11+, erreichbar von allen Mailcow-Servern |
| Mailcow-Server | mailcow-dockerized unter `/opt/mailcow-dockerized` (Pfad konfigurierbar), root |
| Backup-Ziel | SSH-erreichbarer Speicher (Hetzner Storage Box, beliebiger SFTP/SSH-Host) |

## 1. Dashboard (einmalig)

```bash
git clone https://github.com/sebastianluebbert/mailcow-backup-dashboard.git
cd mailcow-backup-dashboard/server
bash install-server.sh
```

Der Installer:
1. installiert Python-venv + FastAPI/uvicorn
2. erzeugt einen **API-Token** (`/etc/backupdash.token`) — wird für alle Agents benötigt
3. richtet den systemd-Dienst `backupdash` ein (Port frei wählbar, Standard 8080)

Danach erreichbar unter `http://<host>:8080`.

### Uptime-Kuma-Anbindung (optional)

HTTP-Monitor auf `http://<host>:8080/api/health` — liefert **200** nur wenn alle
Server grün sind, sonst **503**. So alarmiert Kuma bei jedem Backup-Problem.

## 2. Backup-Ziel vorbereiten (Beispiel Hetzner Storage Box)

1. Storage Box im Robot bestellen/öffnen, **SSH-Support aktivieren**
2. SSH-Key des Mailcow-Servers hinterlegen:

```bash
# auf dem Mailcow-Server:
ssh-keygen -t ed25519 -N "" -f /root/.ssh/id_ed25519   # falls noch keiner existiert
ssh -p23 uXXXXXX@uXXXXXX.your-storagebox.de install-ssh-key < /root/.ssh/id_ed25519.pub
```

## 3. Agent auf jedem Mailcow-Server

### Weg A: Peer-Onboarding über das Dashboard (empfohlen, NetBird-Style)

1. Im Dashboard → **Peers** → „Neuen Peer anlegen" (Name, Borg-Ziel, Aufbewahrung, Uhrzeit)
   — beim ersten Aufruf wird der Admin-Token abgefragt (`/etc/backupdash.token`)
2. Den erzeugten **Enrollment-Befehl** kopieren und auf dem Mailcow-Server als root ausführen:
   ```bash
   curl -fsSL http://<dashboard>:8080/enroll/<key> | bash
   ```
3. Das Skript installiert Borg, Konfig, Agent + Cron und zeigt die restlichen Schritte an
   (SSH-Key am Ziel hinterlegen, `borg init`, Testlauf).

### Weg B: Interaktiver Installer (ohne Dashboard-Zugriff)

```bash
git clone https://github.com/sebastianluebbert/mailcow-backup-dashboard.git
cd mailcow-backup-dashboard/agent
bash install-agent.sh
```

Der Installer fragt interaktiv:

| Frage | Beispiel |
|-------|----------|
| Borg-Ziel | `uXXXXXX@uXXXXXX.your-storagebox.de:backups/<server>-borg` |
| SSH-Port | `23` (Hetzner) bzw. `22` |
| Aufbewahrung | `7` (Tagesstände) |
| Dashboard-URL | `http://<dashboard-ip>:8080` |
| Dashboard-Token | Inhalt von `/etc/backupdash.token` auf dem Dashboard-Host |
| Uhrzeit | `3` (= täglich 3:00) |

Er übernimmt dann automatisch: Borg-Installation, Passphrase-Erzeugung,
Repo-Init (verschlüsselt), Key-Export, Konfig (`/etc/mailcow-backup.conf`),
Skript (`/usr/local/sbin/mailcow-backup.sh`) und Cron (`/etc/cron.d/mailcow-backup`).

### Testlauf

```bash
/usr/local/sbin/mailcow-backup.sh
tail -f /var/log/mailcow-backup.log
```

Nach Abschluss erscheint der Server automatisch im Dashboard.

## 4. ⚠ Schlüssel sichern (PFLICHT)

Ohne diese zwei Dinge ist **kein Restore** möglich — extern sichern (Passwortmanager/Tresor):

1. **Passphrase:** `/root/.borg-passphrase`
2. **Key-Export:** `/root/borg-key-backup.txt`

## Konfiguration ändern

`/etc/mailcow-backup.conf` auf dem jeweiligen Server anpassen (Aufbewahrung,
Threads, Dashboard-URL etc.) — wirkt beim nächsten Lauf. Uhrzeit in
`/etc/cron.d/mailcow-backup`.
