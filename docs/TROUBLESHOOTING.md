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
| `unbekannte BACKUP_COMPONENTS-Komponente '…'` | Tippfehler in `/etc/mailcow-backup.conf` — erlaubt: `vmail,crypt,redis,rspamd,postfix,mysql,all` |
| mysql-Komponente fehlt im Backup | mailcow konnte das SQL-Image nicht bestimmen (`SQLIMAGE` leer) — `docker compose config` bzw. mailcow-Update prüfen |

## Verify-Agent

| Symptom | Ursache / Lösung |
|---------|------------------|
| `keine Archive im Repo gefunden` | Es lief noch kein erfolgreicher Backup-Lauf — zuerst `mailcow-backup.sh` testen |
| `<komponente>-Archiv ist beschädigt (zstd -t fehlgeschlagen)` | Übertragungsfehler oder abgebrochener Backup-Lauf — nächsten Backup-Lauf abwarten und erneut prüfen; bei wiederholtem Auftreten `borg check` erwägen |
| `zstd: command not found` (Integritätsprüfung übersprungen) | `apt-get install zstd` auf dem Mailcow-Server nachholen |
| Verify läuft sehr lange | Großes vmail-Archiv wird komplett extrahiert — normal bei großen Mailboxen; Log via `tail -f /var/log/mailcow-verify.log` beobachten |

## Watchdog-Agent

| Symptom | Ursache / Lösung |
|---------|------------------|
| `Speicherplatz knapp/kritisch` | `KEEP_DAILY` senken, `borg prune`/`compact` ausführen, oder `BACKUP_LOCATION` auf größeres Volume legen |
| `Borg-Ziel nicht erreichbar` | SSH-Port/Firewall/Egress prüfen (siehe oben), Storage-Box-Status im Robot |
| `Kein erfolgreiches Backup seit …h` | Backup-Cron/-Agent prüfen; diese Meldung basiert auf `/var/log/mailcow-backup.state`, unabhängig vom Dashboard |
| `Mailcow-Container watchdog-mailcow läuft nicht` | Mailcow-Stack prüfen: `docker compose ps` im mailcow-Verzeichnis |

## Dashboard

| Symptom | Ursache / Lösung |
|---------|------------------|
| Server erscheint nicht | Report kam nie an: auf dem Mailcow `curl -v http://<dash>:8080/` testen; Token in `/etc/mailcow-backup.conf` = `/etc/backupdash.token`? |
| `401 invalid token` | Token-Mismatch zwischen Agent-Konfig und Dashboard-Service (`systemctl cat backupdash`) |
| Server steht auf „Überfällig" (gelb) | Kein Report seit >26 h: Cron auf dem Mailcow prüfen (`/etc/cron.d/mailcow-backup`, `grep CRON /var/log/syslog`), Log lesen |
| Dashboard nicht erreichbar | `systemctl status backupdash`, Port belegt?, Firewall am Dashboard-Host |
| Charts leer | Erst nach 2+ Läufen sinnvoll; Browser-Konsole auf CDN-Blockade (Chart.js) prüfen |

## Login, 2FA und Passkeys

| Symptom | Ursache / Lösung |
|---------|------------------|
| Einrichtungsseite erscheint erneut nach Update | Normal — die Benutzertabelle war nach dem Update leer. Erstes Konto anlegen oder `DASH_BOOTSTRAP_USER`/`DASH_BOOTSTRAP_PASSWORD` setzen (siehe AUTH.md) |
| „Konto vorübergehend gesperrt" | 5 Fehlversuche (Passwort oder TOTP) sperren ein Konto 15 Minuten; danach automatisch wieder frei |
| Admin-Passwort vergessen | Ein anderer Administrator setzt über **Benutzer** ein neues Konto an, oder direkt in der SQLite-DB (`/opt/backupdash/data/backups.db`, Tabelle `users`) den Datensatz löschen — Vorsicht, danach ist eine Neueinrichtung nötig |
| „Passkeys sind auf diesem Host nicht verfügbar" | WebAuthn benötigt HTTPS oder den Hostnamen `localhost` — reine IP-Adressen funktionieren laut Spezifikation nicht (siehe AUTH.md) |
| TOTP-Code wird abgelehnt | Uhrzeit des Mailcow-/Client-Geräts prüfen — TOTP toleriert nur ±1 Zeitfenster (±30s) |
| Nach Passwortänderung überall abgemeldet | Erwartetes Verhalten — alle Sitzungen werden beim Passwortwechsel invalidiert |

## Nützliche Kommandos

```bash
# Läuft gerade ein Agent?
pgrep -af mailcow-backup.sh
pgrep -af mailcow-verify.sh
pgrep -af mailcow-watchdog.sh

# Letzte Log-Zeilen
tail -50 /var/log/mailcow-backup.log
tail -50 /var/log/mailcow-verify.log
tail -50 /var/log/mailcow-watchdog.log

# Repo-Zustand & Größen
export BORG_PASSPHRASE=$(cat /root/.borg-passphrase); export BORG_RSH="ssh -p23"
borg info  <REPO>
borg list  <REPO>

# Konsistenz-Check (dauert!)
borg check <REPO>

# Manuelle Läufe mit Live-Ausgabe
/usr/local/sbin/mailcow-backup.sh   & tail -f /var/log/mailcow-backup.log
/usr/local/sbin/mailcow-verify.sh   & tail -f /var/log/mailcow-verify.log
/usr/local/sbin/mailcow-watchdog.sh & tail -f /var/log/mailcow-watchdog.log
```

## Monitoring-Tipps

- Uptime-Kuma → HTTP-Monitor auf `/api/health` (200 = alles grün, 503 = Problem;
  bezieht sich nur auf Backup-Reports, nicht auf Verify/Watchdog)
- Verify- und Watchdog-Status je Server auf der Dashboard-Detailseite unter
  „Zusätzliche Prüfungen" einsehen
- Quartalsweise Restore-Probe (siehe RESTORE.md) — ungetestete Backups zählen nicht.
  Der Verify-Agent ist eine Ergänzung, kein Ersatz dafür.
