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
2. erzeugt einen **Agent-Token** (`/etc/backupdash.token`) für Backup-Reports
3. erzeugt einen getrennten **Admin-Token** (`/etc/backupdash.admin.token`) für
   Peer-Verwaltung und Systemupdates
4. richtet den systemd-Dienst `backupdash` ein (Port frei wählbar, Standard 8080)

Danach erreichbar unter `http://<host>:8080`.

Beim ersten Öffnen von **Peers** oder **Einstellungen** fragt die UI nach dem
Admin-Token. Standardmäßig bleibt er nur für die aktuelle Browser-Sitzung
gespeichert. Für produktiven Betrieb sollte vor dem Dashboard ein
TLS-terminierender Reverse-Proxy stehen.

### Uptime-Kuma-Anbindung (optional)

HTTP-Monitor auf `http://<host>:8080/api/health` — liefert **200** nur wenn
mindestens ein Server registriert und jeder Server grün ist, sonst **503**.
So alarmiert Kuma auch bei einer leeren oder fehlerhaften Installation.

## 2. Backup-Ziel vorbereiten (Beispiel Hetzner Storage Box)

1. Storage Box im Robot bestellen/öffnen, **SSH-Support aktivieren**
2. SSH-Key des Mailcow-Servers hinterlegen:

```bash
# auf dem Mailcow-Server:
ssh-keygen -t ed25519 -N "" -f /root/.ssh/id_ed25519   # falls noch keiner existiert
ssh -p23 uXXXXXX@uXXXXXX.your-storagebox.de install-ssh-key < /root/.ssh/id_ed25519.pub
```

## 3. Agent-Suite auf jedem Mailcow-Server

Installiert wird immer die komplette Suite: Backup-, Verify- und
Watchdog-Agent samt gemeinsamer Bibliothek. Details zu den einzelnen Agents:
[docs/AGENTS.md](AGENTS.md).

### Weg A: Peer-Onboarding über das Dashboard (empfohlen, NetBird-Style)

1. Im Dashboard → **Peers** → „Neuen Peer anlegen" (Name, Borg-Ziel, Aufbewahrung,
   Uhrzeit, Backup-Komponenten) — beim ersten Aufruf wird der Admin-Token
   abgefragt (`/etc/backupdash.admin.token`)
2. Den erzeugten **Enrollment-Befehl** kopieren und auf dem Mailcow-Server als root ausführen:
   ```bash
   curl -fsSL http://<dashboard>:8080/enroll/<key> | bash
   ```
3. Das Skript installiert Borg, Konfig, die komplette Agent-Suite + drei Cron-Einträge
   (Backup täglich, Watchdog stündlich, Verify wöchentlich) und zeigt die restlichen
   Schritte an (SSH-Key am Ziel hinterlegen, `borg init`, Testläufe).

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
| Backup-Komponenten | `all` oder z. B. `vmail,mysql,crypt` |
| Dashboard-URL | `http://<dashboard-ip>:8080` |
| Dashboard-Token | Agent-Token aus `/etc/backupdash.token` auf dem Dashboard-Host |
| Uhrzeit | `3` (= täglich 3:00, Verify folgt sonntags 2h später, Watchdog stündlich) |

Er übernimmt dann automatisch: Borg-Installation, Passphrase-Erzeugung,
Repo-Init (verschlüsselt), Key-Export, Konfig (`/etc/mailcow-backup.conf`),
die Suite unter `/usr/local/sbin/` und `/usr/local/lib/mailcow-backup-suite/`
sowie drei Einträge in `/etc/cron.d/mailcow-backup`.

### Testläufe

```bash
/usr/local/sbin/mailcow-backup.sh   ; tail -f /var/log/mailcow-backup.log
/usr/local/sbin/mailcow-verify.sh   ; tail -f /var/log/mailcow-verify.log
/usr/local/sbin/mailcow-watchdog.sh ; tail -f /var/log/mailcow-watchdog.log
```

Nach dem ersten Backup-Lauf erscheint der Server automatisch im Dashboard;
Verify- und Watchdog-Status erscheinen dort auf der Server-Detailseite.

## 4. ⚠ Schlüssel sichern (PFLICHT)

Ohne diese zwei Dinge ist **kein Restore** möglich — extern sichern (Passwortmanager/Tresor):

1. **Passphrase:** `/root/.borg-passphrase`
2. **Key-Export:** `/root/borg-key-backup.txt`

## Konfiguration ändern

`/etc/mailcow-backup.conf` auf dem jeweiligen Server anpassen (Aufbewahrung,
Komponenten, Threads, Dashboard-URL, Watchdog-Schwellen etc.) — wirkt beim
nächsten Lauf des jeweiligen Agents. Zeitplan in `/etc/cron.d/mailcow-backup`.
Vollständige Variablenreferenz: [docs/AGENTS.md](AGENTS.md#konfigurationsreferenz-etcmailcow-backupconf).

## Dashboard aktualisieren

Unter **Einstellungen** zeigt die Oberfläche den installierten und den neuesten
Commit. „Update installieren" startet den bestehenden Updater entkoppelt über
systemd; die UI wartet auf den Neustart und zeigt anschließend das Update-Log.

Alternativ auf dem Dashboard-Host:

```bash
cd /opt/mailcow-backup-dashboard
bash update.sh
```

Bei älteren Installationen ohne `DASH_ADMIN_TOKEN` bleibt aus
Kompatibilitätsgründen der bisherige Agent-Token auch Admin-Token. Für eine
saubere Token-Trennung den aktuellen `server/install-server.sh` erneut ausführen;
vorhandene Tokens und Daten werden dabei beibehalten.
