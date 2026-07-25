# Mailcow Backup Dashboard

Zentrales, verschlüsseltes Backup-Monitoring für beliebig viele **mailcow**-Server —
mit einer spezialisierten **Agent-Suite** statt eines einzelnen Backup-Skripts.

- 🔐 **Borg Backup** (repokey-blake2, zstd) auf beliebige SSH-Ziele (z. B. Hetzner Storage Box)
- 📦 **Modulare Komponenten** (vmail, crypt, redis, rspamd, postfix, mysql) —
  einzeln wählbar statt nur "alles oder nichts"
- 🧪 **Verify-Agent**: automatischer Restore-Test des jüngsten Archivs (wöchentlich),
  ohne den laufenden Mailcow-Stack anzufassen
- 🐕 **Watchdog-Agent**: stündliche Kontrolle von Speicherplatz, Borg-Erreichbarkeit,
  Backup-Alter und Mailcow-Stack-Status — unabhängig vom täglichen Backup-Lauf
- 🧹 Automatische Aufbewahrung (`borg prune`, Standard: 7 Tagesstände)
- 📊 **Operations-Dashboard**: responsive Fleet-Übersicht, KPI-Kacheln, Suche, Filter,
  Verlaufs-Charts, Fehler-Historie, Komponenten-Aufschlüsselung und barrierearme Bedienung
- 🚨 Stale-Erkennung (>26 h kein Backup → Warnung) + `/api/health` für Uptime-Kuma
- 🛰 Jeder Agent meldet seine Läufe (ok/Fehler, Dauer, Details) per REST an den Collector
- ⚙️ Geschützte Systemseite mit Versionsprüfung, Update-Workflow und Loganzeige

## Die Agent-Suite

Statt eines einzelnen Skripts läuft auf jedem Mailcow-Server ein kleines Set
spezialisierter Agents, die eine gemeinsame Bibliothek nutzen:

| Agent | Zeitplan | Aufgabe |
|-------|----------|---------|
| `mailcow-backup.sh` | täglich | Backup der gewählten Komponenten → Borg-Archiv → Report |
| `mailcow-verify.sh` | wöchentlich | Extrahiert das jüngste Archiv testweise und prüft Integrität |
| `mailcow-watchdog.sh` | stündlich | Speicherplatz, Borg-Erreichbarkeit, Backup-Alter, Stack-Status |
| `lib/common.sh` | — | Gemeinsame Konfiguration, Reporting, Self-Update-Logik |

Details zu jedem Agent: [docs/AGENTS.md](docs/AGENTS.md)

## Architektur

```
┌─────────────────────┐   Borg über SSH (verschlüsselt)   ┌──────────────────┐
│ mailcow #1           │ ────────────────────────────────► │  Storage Box /   │
│  Backup + Verify +   │                                   │  beliebiges Ziel │
│  Watchdog Agent      │                                   └──────────────────┘
└──────────┬───────────┘
           │ POST /api/report (Bearer-Token, kind=backup|verify|watchdog)
           ▼
┌─────────────────┐     ┌──────────────────────┐
│   Dashboard     │ ◄── │ mailcow #2…n (Suite) │
│ FastAPI+SQLite  │     └──────────────────────┘
│ :8080 (LAN)     │
└─────────────────┘
```

## Komponenten

| Pfad | Zweck |
|------|-------|
| `server/` | Dashboard/Collector (FastAPI + SQLite + Vanilla JS + Chart.js) |
| `server/install-server.sh` | Installer für den Dashboard-Host (LXC/VM, Debian) |
| `agent/lib/common.sh` | Gemeinsame Bibliothek aller drei Agents |
| `agent/mailcow-backup.sh` | Backup-Agent (läuft täglich per Cron) |
| `agent/mailcow-verify.sh` | Verify-Agent (Restore-Test, läuft wöchentlich) |
| `agent/mailcow-watchdog.sh` | Watchdog-Agent (Health-Check, läuft stündlich) |
| `agent/install-agent.sh` | Interaktiver Installer für neue mailcow-Server |
| `docs/AGENTS.md` | Architektur und Konfiguration der Agent-Suite |
| `docs/INSTALL.md` | Schritt-für-Schritt-Anleitung |
| `docs/RESTORE.md` | **Wiederherstellung** (komplett & einzelne Mailboxen) |
| `docs/TROUBLESHOOTING.md` | Häufige Fehler & Lösungen |

## Quickstart

**1. Dashboard installieren** (einmalig, z. B. auf einem LXC):

```bash
git clone https://github.com/sebastianluebbert/mailcow-backup-dashboard.git
cd mailcow-backup-dashboard/server
bash install-server.sh          # fragt Port & erzeugt Agent-/Admin-Token
```

**2. Agent-Suite auf jedem mailcow-Server:**

```bash
git clone https://github.com/sebastianluebbert/mailcow-backup-dashboard.git
cd mailcow-backup-dashboard/agent
bash install-agent.sh           # fragt Ziel, Komponenten, Aufbewahrung, Dashboard-URL+Token
/usr/local/sbin/mailcow-backup.sh   # Testlauf
```

Empfohlen ist stattdessen das **Peer-Onboarding über das Dashboard** (Einstellungen
→ Peers → Enrollment-Befehl), das die komplette Suite in einem `curl | bash` installiert.

Details: [docs/INSTALL.md](docs/INSTALL.md)

## Updates

**Dashboard:** über **Einstellungen → Update installieren** oder manuell per
`update.sh`. Der Updater zieht `origin/main`, deployt die Server-Dateien und
startet den Dienst neu (mit automatischem Rollback bei Startfehler).

```bash
cd /opt/mailcow-backup-dashboard && bash update.sh
```

**Agents:** aktualisieren sich **selbst** — vor jedem Lauf holt jeder Agent seine
eigene Version und die gemeinsame Bibliothek vom Dashboard (`/agent/scripts/<name>`),
prüft Syntax und Marker und ersetzt sich bei Änderung (abschaltbar mit
`SELF_UPDATE="0"` in `/etc/mailcow-backup.conf`). Nach einem Dashboard-Update
folgt die Flotte automatisch beim nächsten Lauf.

> **Migration von Einzelskript-Installationen:** Ältere Agents kennen die neue
> Bibliothek noch nicht und aktualisieren sich deshalb nicht automatisch auf die
> Suite. Bitte den Enrollment-Befehl erneut ausführen oder `install-agent.sh`
> erneut laufen lassen, um Verify- und Watchdog-Agent zu ergänzen.

## Sicherheit

- Backups sind **client-seitig verschlüsselt** (Borg repokey-blake2) — das Ziel sieht nur Chiffrat.
- **Passphrase** (`/root/.borg-passphrase`) und **Key-Export** (`/root/borg-key-backup.txt`)
  unbedingt extern sichern — ohne sie ist kein Restore möglich.
- Neue Installationen verwenden getrennte **Agent- und Admin-Tokens**. Der
  Admin-Token liegt unter `/etc/backupdash.admin.token`.
- Agent-Self-Updates und schreibende APIs benötigen einen Bearer-Token;
  Enrollment-Keys sind nur einmal verwendbar.
- Der **Verify-Agent** greift ausschließlich lesend auf das Borg-Repository zu
  und rührt den laufenden Mailcow-Stack nie an (kein `docker stop`/`start`).
- Sicherheitsheader und kontextgerechtes HTML-Escaping härten die Oberfläche.
  Der Betrieb hinter HTTPS in einem LAN/VPN bleibt empfohlen.

## Lizenz

Privates Projekt — LK IT Solutions.
