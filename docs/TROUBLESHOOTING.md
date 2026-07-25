# Troubleshooting

## Backup-Läufe

| Symptom | Ursache / Lösung |
|---------|------------------|
| `Connection timed out` beim Borg-Push | Ziel nicht erreichbar: SSH-Port (Hetzner: **23**!), Firewall/Egress prüfen: `ssh -p23 u…@u….your-storagebox.de ls` |
| `Permission denied (publickey)` | SSH-Key nicht am Ziel hinterlegt → `install-ssh-key` (siehe INSTALL.md) |
| `passphrase supplied in BORG_PASSPHRASE is incorrect` | Falsche/geänderte Passphrase in `/root/.borg-passphrase` — extern gesicherte Version verwenden |
| `Failed to create/acquire the lock` | Abgebrochener Lauf hält Lock: `borg break-lock <REPO>` (nur wenn sicher kein Lauf aktiv!) |
| Backup dauert plötzlich Stunden | Erster Lauf nach großen Datenänderungen ist normal; sonst Netz/Storage-Box-Auslastung prüfen |
| `no space left on device` lokal | `/opt/mailcow-backups` wird vor dem Upload angelegt (~1× Datenvolumen nötig). Platz schaffen oder `BACKUP_LOCATION` auf größeres Volume legen |
| Storage Box voll | Aufbewahrung senken (`KEEP_DAILY` in `/etc/mailcow-backup.conf`), dann `borg prune` + `borg compact` manuell |
| Docker-Build/DNS-Fehler nach Firewall-Härtung | Docker-Bridges müssen am Host erlaubt sein (nftables: `iifname { "docker0", "br-*" } accept`) |

## Dashboard

| Symptom | Ursache / Lösung |
|---------|------------------|
| Server erscheint nicht | Report kam nie an: auf dem Mailcow `curl -v http://<dash>:8080/` testen; Token in `/etc/mailcow-backup.conf` = `/etc/backupdash.token`? |
| `401 invalid token` | Token-Mismatch zwischen Agent-Konfig und Dashboard-Service (`systemctl cat backupdash`) |
| Server steht auf „Überfällig" (gelb) | Kein Report seit >26 h: Cron auf dem Mailcow prüfen (`/etc/cron.d/mailcow-backup`, `grep CRON /var/log/syslog`), Log lesen |
| Dashboard nicht erreichbar | `systemctl status backupdash`, Port belegt?, Firewall am Dashboard-Host |
| Charts leer | Erst nach 2+ Läufen sinnvoll; Browser-Konsole auf CDN-Blockade (Chart.js) prüfen |

## Nützliche Kommandos

```bash
# Läuft gerade ein Backup?
pgrep -af mailcow-backup.sh

# Letzte Log-Zeilen
tail -50 /var/log/mailcow-backup.log

# Repo-Zustand & Größen
export BORG_PASSPHRASE=$(cat /root/.borg-passphrase); export BORG_RSH="ssh -p23"
borg info  <REPO>
borg list  <REPO>

# Konsistenz-Check (dauert!)
borg check <REPO>

# Manueller Lauf mit Live-Ausgabe
/usr/local/sbin/mailcow-backup.sh & tail -f /var/log/mailcow-backup.log
```

## Monitoring-Tipps

- Uptime-Kuma → HTTP-Monitor auf `/api/health` (200 = alles grün, 503 = Problem)
- Quartalsweise Restore-Probe (siehe RESTORE.md) — ungetestete Backups zählen nicht.
