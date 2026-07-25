# Mailcow Backup Dashboard

Zentrales, verschlüsseltes Backup-Monitoring für beliebig viele **mailcow**-Server.

- 🔐 **Borg Backup** (repokey-blake2, zstd) auf beliebige SSH-Ziele (z. B. Hetzner Storage Box)
- 📦 Vollbackup aller mailcow-Komponenten (vmail, MariaDB, Redis, Rspamd, Crypt-Keys, Config)
- 🧹 Automatische Aufbewahrung (`borg prune`, Standard: 7 Tagesstände)
- 📊 **Operations-Dashboard**: responsive Fleet-Übersicht, KPI-Kacheln, Suche, Filter,
  Verlaufs-Charts, Fehler-Historie und barrierearme Bedienung
- 🚨 Stale-Erkennung (>26 h kein Backup → Warnung) + `/api/health` für Uptime-Kuma
- 🛰 Agent meldet jeden Lauf (ok/Fehler, Dauer, Größen) per REST an den Collector
- ⚙️ Geschützte Systemseite mit Versionsprüfung, Update-Workflow und Loganzeige

## Architektur

```
┌─────────────┐   Borg über SSH (verschlüsselt)   ┌──────────────────┐
│ mailcow #1  │ ────────────────────────────────► │  Storage Box /   │
│  + Agent    │                                   │  beliebiges Ziel │
└──────┬──────┘                                   └──────────────────┘
       │ POST /api/report (Bearer-Token)
       ▼
┌─────────────────┐     ┌──────────────┐
│   Dashboard     │ ◄── │ mailcow #2…n │
│ FastAPI+SQLite  │     └──────────────┘
│ :8080 (LAN)     │
└─────────────────┘
```

## Komponenten

| Pfad | Zweck |
|------|-------|
| `server/` | Dashboard/Collector (FastAPI + SQLite + Vanilla JS + Chart.js) |
| `server/install-server.sh` | Installer für den Dashboard-Host (LXC/VM, Debian) |
| `agent/mailcow-backup.sh` | Backup-Skript (läuft per Cron auf jedem mailcow) |
| `agent/install-agent.sh` | Interaktiver Installer für neue mailcow-Server |
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

**2. Agent auf jedem mailcow-Server:**

```bash
git clone https://github.com/sebastianluebbert/mailcow-backup-dashboard.git
cd mailcow-backup-dashboard/agent
bash install-agent.sh           # fragt Ziel, Aufbewahrung, Dashboard-URL+Token
/usr/local/sbin/mailcow-backup.sh   # Testlauf
```

Details: [docs/INSTALL.md](docs/INSTALL.md)

## Updates

**Dashboard:** über **Einstellungen → Update installieren** oder manuell per
`update.sh`. Der Updater zieht `origin/main`, deployt die Server-Dateien und
startet den Dienst neu (mit automatischem Rollback bei Startfehler).

```bash
cd /opt/mailcow-backup-dashboard && bash update.sh
```

**Agents:** aktualisieren sich **selbst** — vor jedem Backup-Lauf holt der Agent
die neueste Version vom Dashboard (`/agent/script`), prüft Syntax und ersetzt
sich bei Änderung (abschaltbar mit `SELF_UPDATE="0"` in `/etc/mailcow-backup.conf`).
Nach einem Dashboard-Update folgt die Flotte also automatisch beim nächsten Lauf.

## Sicherheit

- Backups sind **client-seitig verschlüsselt** (Borg repokey-blake2) — das Ziel sieht nur Chiffrat.
- **Passphrase** (`/root/.borg-passphrase`) und **Key-Export** (`/root/borg-key-backup.txt`)
  unbedingt extern sichern — ohne sie ist kein Restore möglich.
- Neue Installationen verwenden getrennte **Agent- und Admin-Tokens**. Der
  Admin-Token liegt unter `/etc/backupdash.admin.token`.
- Agent-Self-Updates und schreibende APIs benötigen einen Bearer-Token;
  Enrollment-Keys sind nur einmal verwendbar.
- Sicherheitsheader und kontextgerechtes HTML-Escaping härten die Oberfläche.
  Der Betrieb hinter HTTPS in einem LAN/VPN bleibt empfohlen.

## Lizenz

Privates Projekt — LK IT Solutions.
