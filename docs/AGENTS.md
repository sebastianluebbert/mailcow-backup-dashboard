# Die Agent-Suite

Auf jedem Mailcow-Server läuft nicht mehr ein einzelnes Backup-Skript, sondern
drei spezialisierte Agents, die eine gemeinsame Bibliothek nutzen. Diese Datei
beschreibt Architektur, Konfiguration und Zeitplan der Suite.

## Überblick

| Datei | Rolle | Cron |
|-------|-------|------|
| `lib/common.sh` | Gemeinsame Konfiguration, Reporting, Self-Update | — (wird nur eingebunden) |
| `mailcow-backup.sh` | Erzeugt das Backup und lädt es verschlüsselt zu Borg hoch | täglich, konfigurierbare Uhrzeit |
| `mailcow-verify.sh` | Restore-Test des jüngsten Archivs | wöchentlich, sonntags |
| `mailcow-watchdog.sh` | Health-Check zwischen den Backup-Läufen | stündlich |

Alle drei Agents lesen dieselbe Konfigurationsdatei `/etc/mailcow-backup.conf`
und melden ihre Ergebnisse über denselben Endpunkt (`POST /api/report`) an das
Dashboard — unterschieden über das Feld `kind` (`backup`, `verify`, `watchdog`).

## Backup-Agent (`mailcow-backup.sh`)

1. Liest `BACKUP_COMPONENTS` aus der Konfiguration (Standard: `all`) und prüft
   die Werte gegen die von mailcow unterstützten Komponenten:
   `vmail`, `crypt`, `redis`, `rspamd`, `postfix`, `mysql`, `all`.
2. Ruft `helper-scripts/backup_and_restore.sh backup <komponenten…>` **einmalig**
   mit allen gewählten Komponenten auf, damit sie im selben Zeitstempel-Verzeichnis
   landen (mailcow legt sonst pro Aufruf ein neues Verzeichnis an).
3. Prüft je Komponente, ob die erwartete Archivdatei erzeugt wurde
   (`backup_vmail.tar.zst`, `backup_mariadb.tar.zst`, …) und protokolliert
   Vorhandensein + Größe als strukturierte `components`-Angabe im Report.
4. Archiviert das komplette Backup-Verzeichnis verschlüsselt und dedupliziert
   in das Borg-Repository, führt `borg prune` (Aufbewahrung) und `borg compact`
   aus und räumt das lokale Backup-Verzeichnis auf.
5. Meldet Erfolg/Fehler inkl. Dauer, Größen und Komponenten-Aufschlüsselung an
   das Dashboard.

**Warum nur ein Aufruf statt einem pro Komponente?** mailcows eigenes Skript
verwendet für alle in einem Aufruf übergebenen Komponenten denselben
Zeitstempel; mehrere separate Aufrufe würden mehrere Verzeichnisse erzeugen und
die Wiederherstellung unnötig verkomplizieren.

### Nur bestimmte Komponenten sichern

In `/etc/mailcow-backup.conf`:

```bash
BACKUP_COMPONENTS="vmail,mysql,crypt"
```

Sinnvoll z. B. wenn Redis/Rspamd-Daten (Caches, Bayes-Lerndaten) bewusst nicht
gesichert werden sollen, um Backup-Zeit und Speicherbedarf zu reduzieren.

## Verify-Agent (`mailcow-verify.sh`)

- Ermittelt das jüngste Archiv im Borg-Repository (`borg list --last 1`).
- Extrahiert es in ein temporäres Verzeichnis (`VERIFY_LOCATION`, Standard
  `/opt/mailcow-backups/.verify`).
- Prüft, dass `mailcow.conf` vorhanden und nicht leer ist.
- Prüft für jede vorhandene Komponente die Archivgröße und — falls `zstd`
  installiert ist — die Integrität via `zstd -t`.
- Räumt das temporäre Verzeichnis danach vollständig auf.
- **Greift nie in den laufenden Mailcow-Stack ein**: kein `docker stop`,
  kein `docker start`, keine Änderung an Produktivdaten.

Optional kann zusätzlich eine vollständige Repository-Prüfung
(`borg check --repository-only`) aktiviert werden — das ist deutlich
aufwendiger und sollte nur gelegentlich laufen:

```bash
VERIFY_FULL=1 /usr/local/sbin/mailcow-verify.sh
```

Der Verify-Agent **ersetzt keine echte Restore-Probe**. Er bestätigt nur, dass
die Archivdateien lesbar und nicht beschädigt sind — nicht, dass mailcow damit
tatsächlich vollständig wiederhergestellt werden kann. Die quartalsweise
Restore-Probe aus [RESTORE.md](RESTORE.md) bleibt weiterhin empfohlen.

## Watchdog-Agent (`mailcow-watchdog.sh`)

Läuft bewusst **ohne `set -e`**, damit eine fehlschlagende Einzelprüfung nicht
die übrigen Prüfungen verhindert. Kontrolliert:

1. **Speicherplatz** am Backup-Ziel (`BACKUP_LOCATION`) — Warn-/Fehlerschwellen
   über `WATCHDOG_DISK_WARN_PERCENT` (Standard 85) und
   `WATCHDOG_DISK_ERROR_PERCENT` (Standard 95).
2. **Erreichbarkeit** des Borg-Ziels per kurzer SSH-Verbindung (Timeout 15s).
3. **Alter des letzten erfolgreichen Backups** anhand einer lokalen
   Zustandsdatei (`/var/log/mailcow-backup.state`), die der Backup-Agent
   pflegt — funktioniert auch, wenn das Dashboard selbst nicht erreichbar ist.
   Schwelle: `WATCHDOG_STALE_HOURS` (Standard 26).
4. **Grober Zustand des Mailcow-Stacks** (prüft, ob der Container
   `watchdog-mailcow` läuft), sofern Docker verfügbar ist.

Der Watchdog meldet `ok`, wenn keine Prüfung anschlägt, sonst `error` mit einer
zusammengefassten Nachricht aller aufgetretenen Probleme.

## Gemeinsame Bibliothek (`lib/common.sh`)

Wird von allen drei Agents eingebunden und stellt bereit:

- `agent_load_config` — lädt `/etc/mailcow-backup.conf` und setzt Standardwerte.
- `agent_borg_env` — exportiert `BORG_PASSPHRASE` und `BORG_RSH`.
- `agent_report` — sendet einen JSON-Report an `/api/report` (mit korrektem
  JSON-Escaping der Freitext-Nachricht).
- `agent_fetch_and_replace` — lädt eine Suite-Komponente vom Dashboard
  (`/agent/scripts/<name>`), prüft Marker + Bash-Syntax und ersetzt die lokale
  Datei nur bei bestandener Prüfung.
- `agent_disk_usage_percent` — ermittelt die Speicherauslastung eines Pfads.

## Konfigurationsreferenz (`/etc/mailcow-backup.conf`)

| Variable | Standard | Bedeutung |
|----------|----------|-----------|
| `MAILCOW_DIR` | `/opt/mailcow-dockerized` | Pfad zur mailcow-Installation |
| `BACKUP_LOCATION` | `/opt/mailcow-backups` | Lokales, temporäres Backup-Verzeichnis |
| `BORG_REPO` | *(Pflicht)* | Borg-Repository (SSH-Ziel) |
| `BORG_PASSPHRASE_FILE` | `/root/.borg-passphrase` | Datei mit der Borg-Passphrase |
| `BORG_SSH_PORT` | `23` | SSH-Port des Backup-Ziels |
| `KEEP_DAILY` | `7` | Anzahl Tagesstände (`borg prune`) |
| `THREADS` | `4` | Threads für mailcows Backup-Tool |
| `BACKUP_COMPONENTS` | `all` | Komma-Liste: `vmail,crypt,redis,rspamd,postfix,mysql,all` |
| `DASH_URL` | *(leer)* | Dashboard-URL (leer = kein Reporting) |
| `DASH_TOKEN` | *(leer)* | Agent-Token für das Dashboard |
| `SELF_UPDATE` | `1` | Automatisches Self-Update aller Suite-Dateien |
| `VERIFY_LOCATION` | `$BACKUP_LOCATION/.verify` | Temp-Verzeichnis für den Verify-Agent |
| `VERIFY_FULL` | `0` | `1` aktiviert zusätzlich `borg check --repository-only` |
| `WATCHDOG_DISK_WARN_PERCENT` | `85` | Warnschwelle Speicherplatz |
| `WATCHDOG_DISK_ERROR_PERCENT` | `95` | Fehlerschwelle Speicherplatz |
| `WATCHDOG_STALE_HOURS` | `26` | Ab wann ein fehlendes Backup als überfällig gilt |

## Logs

| Agent | Log-Datei |
|-------|-----------|
| Backup | `/var/log/mailcow-backup.log` |
| Verify | `/var/log/mailcow-verify.log` |
| Watchdog | `/var/log/mailcow-watchdog.log` |
| Backup-Zustand (für Watchdog) | `/var/log/mailcow-backup.state` |
