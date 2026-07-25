#!/usr/bin/env python3
"""Mailcow Backup Dashboard — central collector & operations UI.

Endpoints:
  POST /api/report         — agents push results (Bearer token)
                              kind: backup | verify | watchdog
  GET  /api/servers        — fleet state + per-server history & checks
  GET  /api/summary        — aggregated KPIs for the fleet
  GET  /api/health         — plain health endpoint (Uptime-Kuma friendly)
  GET  /api/peers          — protected peer administration
  GET  /api/settings/*     — protected version, update and log operations
  GET  /agent/scripts/{n}  — protected suite component download (self-update)
  GET  /               — dashboard UI
"""
import asyncio
import json as _json
import os
import secrets
import shlex
import sqlite3
import subprocess
import time
from collections import deque
from contextlib import closing
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.environ.get("DASH_DB", os.path.join(BASE, "data", "backups.db"))
API_TOKEN = os.environ.get("DASH_TOKEN", "")
ADMIN_TOKEN = os.environ.get("DASH_ADMIN_TOKEN", API_TOKEN)
STALE_HOURS = int(os.environ.get("DASH_STALE_HOURS", "26"))
REPORT_KINDS = {"backup", "verify", "watchdog"}

app = FastAPI(title="Mailcow Backup Dashboard", docs_url=None, redoc_url=None)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' https://cdn.jsdelivr.net; "
        "style-src 'self'; img-src 'self' data:; font-src 'self'; "
        "connect-src 'self'; object-src 'none'; base-uri 'self'; "
        "form-action 'self'; frame-ancestors 'none'"
    )
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    if request.url.scheme == "https":
        response.headers["Strict-Transport-Security"] = "max-age=31536000"
    if request.url.path.startswith(("/api/", "/enroll/")):
        response.headers["Cache-Control"] = "no-store"
    elif request.url.path in ("/", "/static/app.js", "/static/styles.css"):
        response.headers["Cache-Control"] = "no-cache"
    return response


def require_token(authorization: str, expected: str):
    prefix = "Bearer "
    supplied = authorization[len(prefix):] if authorization.startswith(prefix) else ""
    if not expected or not supplied or not secrets.compare_digest(supplied, expected):
        raise HTTPException(401, "invalid token")


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, decl: str):
    columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


def db():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    conn.execute("""CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'backup',
        ts INTEGER NOT NULL,
        status TEXT NOT NULL,
        duration_s INTEGER,
        backup_gb REAL,
        repo_gb REAL,
        dedup_gb REAL,
        archives INTEGER,
        components TEXT,
        message TEXT
    )""")
    # Additive migration for databases created before "kind"/"components"
    # existed — safe to run on every connection (PRAGMA lookup is cheap).
    _ensure_column(conn, "reports", "kind", "TEXT NOT NULL DEFAULT 'backup'")
    _ensure_column(conn, "reports", "components", "TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_server_kind_ts ON reports(server, kind, ts DESC)")
    conn.execute("""CREATE TABLE IF NOT EXISTS peers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        created_ts INTEGER NOT NULL,
        enroll_key TEXT UNIQUE NOT NULL,
        enrolled_ts INTEGER,
        config TEXT NOT NULL
    )""")
    return conn


class Report(BaseModel):
    server: str
    kind: str = "backup"  # backup | verify | watchdog
    status: str  # ok | error
    duration_s: int | None = None
    backup_gb: float | None = None
    repo_gb: float | None = None
    dedup_gb: float | None = None
    archives: int | None = None
    components: dict[str, Any] | None = None
    message: str | None = None


def _state(last_status: str, last_ts: int, now: float) -> str:
    if now - last_ts > STALE_HOURS * 3600:
        return "stale"
    return "ok" if last_status == "ok" else "error"


def _check_summary(conn: sqlite3.Connection, server: str, kind: str, now: float):
    """Latest status + recent errors for a non-backup check kind (verify/watchdog)."""
    last = conn.execute(
        "SELECT ts, status, message FROM reports WHERE server=? AND kind=?"
        " ORDER BY ts DESC LIMIT 1", (server, kind)).fetchone()
    if not last:
        return None
    errors = conn.execute(
        "SELECT ts, message FROM reports WHERE server=? AND kind=? AND status='error'"
        " ORDER BY ts DESC LIMIT 5", (server, kind)).fetchall()
    return {
        "state": _state(last["status"], last["ts"], now),
        "last_ts": last["ts"],
        "last_status": last["status"],
        "last_message": last["message"],
        "recent_errors": [dict(e) for e in errors],
    }


@app.post("/api/report")
async def report(r: Report, authorization: str = Header(default="")):
    require_token(authorization, API_TOKEN)
    if r.kind not in REPORT_KINDS:
        raise HTTPException(422, "kind must be backup|verify|watchdog")
    if r.status not in ("ok", "error"):
        raise HTTPException(422, "status must be ok|error")
    components_json = _json.dumps(r.components) if r.components is not None else None
    with closing(db()) as conn:
        conn.execute(
            "INSERT INTO reports (server, kind, ts, status, duration_s, backup_gb, repo_gb,"
            " dedup_gb, archives, components, message) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (r.server.strip()[:200], r.kind, int(time.time()), r.status, r.duration_s,
             r.backup_gb, r.repo_gb, r.dedup_gb, r.archives, components_json,
             (r.message or "")[:2000]),
        )
        conn.commit()
    return {"ok": True}


@app.get("/api/servers")
async def servers():
    now = time.time()
    with closing(db()) as conn:
        names = conn.execute(
            "SELECT server, MAX(ts) AS last_ts FROM reports WHERE kind='backup'"
            " GROUP BY server ORDER BY server"
        ).fetchall()
        out = []
        for n in names:
            last = conn.execute(
                "SELECT * FROM reports WHERE server=? AND kind='backup'"
                " ORDER BY ts DESC LIMIT 1", (n["server"],)).fetchone()
            history = conn.execute(
                "SELECT ts,status,duration_s,backup_gb,repo_gb,dedup_gb,archives"
                " FROM reports WHERE server=? AND kind='backup' ORDER BY ts DESC LIMIT 90",
                (n["server"],)).fetchall()
            errors = conn.execute(
                "SELECT ts,message FROM reports WHERE server=? AND kind='backup' AND status='error'"
                " ORDER BY ts DESC LIMIT 10", (n["server"],)).fetchall()
            last_dict = dict(last)
            if last_dict.get("components"):
                try:
                    last_dict["components"] = _json.loads(last_dict["components"])
                except (TypeError, ValueError):
                    last_dict["components"] = None
            out.append({
                "server": n["server"],
                "state": _state(last["status"], n["last_ts"], now),
                "last": last_dict,
                "history": [dict(h) for h in reversed(history)],
                "recent_errors": [dict(e) for e in errors],
                "verify": _check_summary(conn, n["server"], "verify", now),
                "watchdog": _check_summary(conn, n["server"], "watchdog", now),
            })
    return JSONResponse(out)


@app.get("/api/summary")
async def summary():
    now = time.time()
    with closing(db()) as conn:
        names = conn.execute(
            "SELECT server, MAX(ts) AS last_ts FROM reports WHERE kind='backup'"
            " GROUP BY server").fetchall()
        total = len(names)
        ok = err = stale = 0
        repo_sum = 0.0
        last_runs = []
        for n in names:
            last = conn.execute(
                "SELECT status, repo_gb, duration_s FROM reports WHERE server=? AND kind='backup'"
                " ORDER BY ts DESC LIMIT 1", (n["server"],)).fetchone()
            st = _state(last["status"], n["last_ts"], now)
            ok += st == "ok"
            err += st == "error"
            stale += st == "stale"
            repo_sum += last["repo_gb"] or 0
            last_runs.append({"server": n["server"], "ts": n["last_ts"],
                              "state": st, "duration_s": last["duration_s"]})
        runs_24h = conn.execute(
            "SELECT COUNT(*) c FROM reports WHERE kind='backup' AND ts > ?",
            (now - 86400,)).fetchone()["c"]
        fails_7d = conn.execute(
            "SELECT COUNT(*) c FROM reports WHERE kind='backup' AND status='error' AND ts > ?",
            (now - 7 * 86400,)).fetchone()["c"]
        verify_fails_30d = conn.execute(
            "SELECT COUNT(*) c FROM reports WHERE kind='verify' AND status='error' AND ts > ?",
            (now - 30 * 86400,)).fetchone()["c"]
        watchdog_fails_24h = conn.execute(
            "SELECT COUNT(*) c FROM reports WHERE kind='watchdog' AND status='error' AND ts > ?",
            (now - 86400,)).fetchone()["c"]
    return {"servers": total, "ok": ok, "error": err, "stale": stale,
            "repo_total_gb": round(repo_sum, 1), "runs_24h": runs_24h,
            "fails_7d": fails_7d, "verify_fails_30d": verify_fails_30d,
            "watchdog_fails_24h": watchdog_fails_24h,
            "last_runs": sorted(last_runs, key=lambda x: -x["ts"])}


@app.get("/api/health")
async def health():
    """Uptime-Kuma friendly: HTTP 200 only if every server's backup is green."""
    now = time.time()
    with closing(db()) as conn:
        names = conn.execute(
            "SELECT server, MAX(ts) AS last_ts FROM reports WHERE kind='backup'"
            " GROUP BY server").fetchall()
        if not names:
            return JSONResponse(
                {"status": "empty", "problems": [{"state": "no_servers"}]},
                status_code=503,
            )
        bad = []
        for n in names:
            last = conn.execute(
                "SELECT status FROM reports WHERE server=? AND kind='backup'"
                " ORDER BY ts DESC LIMIT 1", (n["server"],)).fetchone()
            st = _state(last["status"], n["last_ts"], now)
            if st != "ok":
                bad.append({"server": n["server"], "state": st})
    if bad:
        return JSONResponse({"status": "degraded", "problems": bad}, status_code=503)
    return {"status": "ok", "servers": len(names)}


app.mount("/static", StaticFiles(directory=os.path.join(BASE, "static")), name="static")


# ── Agent-Suite: Dateiauflösung für Enrollment & Self-Update ────────────────
AGENT_DIR_CANDIDATES = [
    os.path.join(os.path.dirname(BASE), "agent"),
    os.path.join(BASE, "agent"),
]


def _resolve_agent_file(*relative_parts: str, env_override: str | None = None) -> str:
    if env_override:
        override = os.environ.get(env_override)
        if override and os.path.exists(override):
            return override
    for base_dir in AGENT_DIR_CANDIDATES:
        candidate = os.path.join(base_dir, *relative_parts)
        if os.path.exists(candidate):
            return candidate
    return os.path.join(AGENT_DIR_CANDIDATES[0], *relative_parts)


AGENT_SUITE_FILES = {
    "lib-common": lambda: _resolve_agent_file("lib", "common.sh"),
    "mailcow-backup": lambda: _resolve_agent_file("mailcow-backup.sh", env_override="AGENT_SCRIPT"),
    "mailcow-verify": lambda: _resolve_agent_file("mailcow-verify.sh"),
    "mailcow-watchdog": lambda: _resolve_agent_file("mailcow-watchdog.sh"),
}


def _read_agent_file(name: str) -> str:
    path = AGENT_SUITE_FILES[name]()
    with open(path, encoding="utf-8") as handle:
        return handle.read()


VALID_BACKUP_COMPONENTS = {"vmail", "crypt", "redis", "rspamd", "postfix", "mysql", "all"}


class Peer(BaseModel):
    name: str = Field(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9._-]+$")
    borg_repo: str = Field(min_length=3, max_length=500)
    borg_ssh_port: int = Field(default=23, ge=1, le=65535)
    keep_daily: int = Field(default=7, ge=1, le=3650)
    hour: int = Field(default=3, ge=0, le=23)
    mailcow_dir: str = Field(default="/opt/mailcow-dockerized", min_length=1, max_length=500)
    threads: int = Field(default=4, ge=1, le=64)
    backup_components: str = Field(default="all", max_length=100)

    @field_validator("backup_components")
    @classmethod
    def _validate_backup_components(cls, value: str) -> str:
        parts = [p.strip() for p in value.split(",") if p.strip()]
        if not parts:
            return "all"
        invalid = sorted(set(parts) - VALID_BACKUP_COMPONENTS)
        if invalid:
            raise ValueError(f"unbekannte Komponente(n): {', '.join(invalid)}")
        deduped: list[str] = []
        for p in parts:
            if p not in deduped:
                deduped.append(p)
        return ",".join(deduped)


@app.get("/api/peers")
async def peers_list(authorization: str = Header(default="")):
    require_token(authorization, ADMIN_TOKEN)
    with closing(db()) as conn:
        rows = conn.execute("SELECT * FROM peers ORDER BY name").fetchall()
    peers = []
    for row in rows:
        peer = dict(row) | {"config": _json.loads(row["config"])}
        if peer["enrolled_ts"]:
            peer["enroll_key"] = None
        peers.append(peer)
    return peers


@app.post("/api/peers")
async def peers_create(p: Peer, request: Request, authorization: str = Header(default="")):
    require_token(authorization, ADMIN_TOKEN)
    key = secrets.token_urlsafe(24)
    with closing(db()) as conn:
        try:
            conn.execute(
                "INSERT INTO peers (name, created_ts, enroll_key, config) VALUES (?,?,?,?)",
                (p.name.strip(), int(time.time()), key, p.model_dump_json()))
            conn.commit()
        except sqlite3.IntegrityError:
            raise HTTPException(409, "peer name already exists")
    base = str(request.base_url).rstrip("/")
    return {"name": p.name, "enroll_key": key,
            "command": f"curl -fsSL {base}/enroll/{key} | bash"}


@app.delete("/api/peers/{name}")
async def peers_delete(name: str, authorization: str = Header(default="")):
    require_token(authorization, ADMIN_TOKEN)
    with closing(db()) as conn:
        cur = conn.execute("DELETE FROM peers WHERE name=?", (name,))
        conn.commit()
    if cur.rowcount == 0:
        raise HTTPException(404, "peer not found")
    return {"ok": True}


@app.get("/enroll/{key}", response_class=PlainTextResponse)
async def enroll(key: str, request: Request):
    """One-shot enrollment script — installs the full backup suite as a peer."""
    with closing(db()) as conn:
        row = conn.execute(
            "SELECT * FROM peers WHERE enroll_key=? AND enrolled_ts IS NULL", (key,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "unknown or already used enrollment key")
    cfg = _json.loads(row["config"])
    base = str(request.base_url).rstrip("/")
    try:
        lib_common = _read_agent_file("lib-common")
        backup_script = _read_agent_file("mailcow-backup")
        verify_script = _read_agent_file("mailcow-verify")
        watchdog_script = _read_agent_file("mailcow-watchdog")
    except OSError:
        raise HTTPException(500, "agent suite files missing on server")
    with closing(db()) as conn:
        cursor = conn.execute(
            "UPDATE peers SET enrolled_ts=?"
            " WHERE enroll_key=? AND enrolled_ts IS NULL",
            (int(time.time()), key),
        )
        conn.commit()
        if cursor.rowcount != 1:
            raise HTTPException(404, "enrollment key was already used")

    peer_name = shlex.quote(row["name"])
    mailcow_dir = shlex.quote(cfg["mailcow_dir"])
    borg_repo = shlex.quote(cfg["borg_repo"])
    dashboard_url = shlex.quote(base)
    dashboard_token = shlex.quote(API_TOKEN)
    backup_components = shlex.quote(cfg.get("backup_components", "all"))
    hour = int(cfg["hour"])
    verify_hour = (hour + 2) % 24
    # Values are shell-quoted before being embedded. The generated config uses
    # printf %q so command substitutions in peer input can never be evaluated.
    return f"""#!/bin/bash
# Mailcow Backup Suite — automatisches Enrollment
set -euo pipefail
[ "$(id -u)" = 0 ] || {{ echo "Bitte als root ausführen."; exit 1; }}

PEER_NAME={peer_name}
MAILCOW_DIR={mailcow_dir}
BORG_REPO={borg_repo}
BORG_SSH_PORT={cfg["borg_ssh_port"]}
KEEP_DAILY={cfg["keep_daily"]}
THREADS={cfg["threads"]}
BACKUP_COMPONENTS={backup_components}
DASH_URL={dashboard_url}
DASH_TOKEN={dashboard_token}

echo "── Enrollment: $PEER_NAME ──"

apt-get update -qq && apt-get install -y -qq borgbackup curl zstd >/dev/null

[ -f /root/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N "" -f /root/.ssh/id_ed25519 -q

if [ ! -f /root/.borg-passphrase ]; then
  openssl rand -base64 32 > /root/.borg-passphrase && chmod 600 /root/.borg-passphrase
  echo "NEUE BORG-PASSPHRASE: $(cat /root/.borg-passphrase)"
  echo "⚠ EXTERN SICHERN — ohne sie ist das Backup unlesbar!"
fi

{{
  printf 'MAILCOW_DIR=%q\\n' "$MAILCOW_DIR"
  printf 'BACKUP_LOCATION=%q\\n' "/opt/mailcow-backups"
  printf 'BORG_REPO=%q\\n' "$BORG_REPO"
  printf 'BORG_SSH_PORT=%q\\n' "$BORG_SSH_PORT"
  printf 'KEEP_DAILY=%q\\n' "$KEEP_DAILY"
  printf 'THREADS=%q\\n' "$THREADS"
  printf 'BACKUP_COMPONENTS=%q\\n' "$BACKUP_COMPONENTS"
  printf 'DASH_URL=%q\\n' "$DASH_URL"
  printf 'DASH_TOKEN=%q\\n' "$DASH_TOKEN"
}} > /etc/mailcow-backup.conf
chmod 600 /etc/mailcow-backup.conf

mkdir -p /usr/local/lib/mailcow-backup-suite
cat > /usr/local/lib/mailcow-backup-suite/common.sh <<'AGENT_LIB_EOF'
{lib_common}
AGENT_LIB_EOF
chmod 644 /usr/local/lib/mailcow-backup-suite/common.sh

cat > /usr/local/sbin/mailcow-backup.sh <<'AGENT_BACKUP_EOF'
{backup_script}
AGENT_BACKUP_EOF
chmod 700 /usr/local/sbin/mailcow-backup.sh

cat > /usr/local/sbin/mailcow-verify.sh <<'AGENT_VERIFY_EOF'
{verify_script}
AGENT_VERIFY_EOF
chmod 700 /usr/local/sbin/mailcow-verify.sh

cat > /usr/local/sbin/mailcow-watchdog.sh <<'AGENT_WATCHDOG_EOF'
{watchdog_script}
AGENT_WATCHDOG_EOF
chmod 700 /usr/local/sbin/mailcow-watchdog.sh

cat > /etc/cron.d/mailcow-backup <<'CRON'
0 {hour} * * * root /usr/local/sbin/mailcow-backup.sh
15 * * * * root /usr/local/sbin/mailcow-watchdog.sh
0 {verify_hour} * * 0 root /usr/local/sbin/mailcow-verify.sh
CRON
chmod 644 /etc/cron.d/mailcow-backup

echo ""
echo "── Noch zu tun ──"
echo "1) SSH-Key am Backup-Ziel hinterlegen (falls noch nicht):"
printf '   ssh -p%s %q install-ssh-key < /root/.ssh/id_ed25519.pub\\n' "$BORG_SSH_PORT" "${{BORG_REPO%%:*}}"
echo "   Key: $(cat /root/.ssh/id_ed25519.pub)"
echo "2) Repo initialisieren (nur beim ersten Mal):"
printf "   export BORG_PASSPHRASE=\\$(cat /root/.borg-passphrase); export BORG_RSH='ssh -p%s'\\n" "$BORG_SSH_PORT"
printf '   borg init --encryption=repokey-blake2 %q\\n' "$BORG_REPO"
printf '   borg key export %q /root/borg-key-backup.txt\\n' "$BORG_REPO"
echo "3) Testläufe:"
echo "   /usr/local/sbin/mailcow-backup.sh"
echo "   /usr/local/sbin/mailcow-verify.sh"
echo "   /usr/local/sbin/mailcow-watchdog.sh"
echo ""
echo "✔ Enrollment abgeschlossen — Backup täglich {hour}:00, Verify sonntags {verify_hour}:00, Watchdog stündlich"
"""


@app.get("/agent/scripts/{name}", response_class=PlainTextResponse)
async def agent_suite_file(name: str, authorization: str = Header(default="")):
    """Suite component download — used by agents for self-updates."""
    require_token(authorization, API_TOKEN)
    if name not in AGENT_SUITE_FILES:
        raise HTTPException(404, "unknown agent component")
    try:
        return _read_agent_file(name)
    except OSError:
        raise HTTPException(500, f"{name} missing on server")


@app.get("/agent/script", response_class=PlainTextResponse)
async def agent_script(authorization: str = Header(default="")):
    """Deprecated alias for /agent/scripts/mailcow-backup (older agents)."""
    require_token(authorization, API_TOKEN)
    try:
        return _read_agent_file("mailcow-backup")
    except OSError:
        raise HTTPException(500, "agent script missing on server")


# ── Einstellungen / Updater ─────────────────────────────────────────────────
REPO_DIR = os.environ.get("REPO_DIR", "/opt/mailcow-backup-dashboard")
UPDATE_LOG = "/var/log/backupdash-update.log"
VERSION_CACHE_SECONDS = 20
_version_cache = {"expires": 0.0, "value": None}
_version_lock = asyncio.Lock()


def _git(*args, timeout=30):
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    try:
        result = subprocess.run(
            ["git", "-C", REPO_DIR, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError(f"git konnte nicht ausgeführt werden: {exc}") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().splitlines()
        raise RuntimeError((detail[-1] if detail else "git command failed")[:300])
    return result.stdout.strip()


def _commit_info(raw: str):
    parts = (raw.split("|", 2) + ["", "", ""])[:3]
    return {"commit": parts[0], "date": parts[1], "subject": parts[2]}


def _collect_version():
    if not os.path.exists(os.path.join(REPO_DIR, ".git")):
        raise RuntimeError(f"kein Git-Repository unter {REPO_DIR}")
    local = _git("log", "-1", "--format=%h|%cd|%s",
                 "--date=format:%d.%m.%Y %H:%M")
    _git("fetch", "-q", "origin", timeout=30)
    remote = _git("log", "-1", "--format=%h|%cd|%s",
                  "--date=format:%d.%m.%Y %H:%M", "origin/main")
    behind = int(_git("rev-list", "--count", "HEAD..origin/main") or 0)
    return {
        "repo_dir": REPO_DIR,
        "installed": _commit_info(local),
        "latest": _commit_info(remote),
        "behind": behind,
        "update_available": behind > 0,
        "stale_hours": STALE_HOURS,
    }


def _invalidate_version_cache():
    _version_cache["expires"] = 0.0
    _version_cache["value"] = None


@app.get("/api/settings/version")
async def version(authorization: str = Header(default="")):
    require_token(authorization, ADMIN_TOKEN)
    now = time.monotonic()
    if _version_cache["value"] is not None and now < _version_cache["expires"]:
        return _version_cache["value"]
    async with _version_lock:
        now = time.monotonic()
        if _version_cache["value"] is not None and now < _version_cache["expires"]:
            return _version_cache["value"]
        try:
            value = await asyncio.to_thread(_collect_version)
        except RuntimeError as exc:
            raise HTTPException(503, f"Versionsprüfung fehlgeschlagen: {exc}")
        _version_cache["value"] = value
        _version_cache["expires"] = time.monotonic() + VERSION_CACHE_SECONDS
        return value


def _start_update(script: str):
    try:
        result = subprocess.run(
            ["systemd-run", "--quiet", "--collect", "--unit=backupdash-update",
             "bash", script],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError(f"Updater konnte nicht gestartet werden: {exc}") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(detail[:500] or "systemd-run ist fehlgeschlagen")


@app.post("/api/settings/update")
async def run_update(authorization: str = Header(default="")):
    require_token(authorization, ADMIN_TOKEN)
    repo_dir = os.path.realpath(REPO_DIR)
    script = os.path.realpath(os.path.join(repo_dir, "update.sh"))
    if os.path.dirname(script) != repo_dir or not os.path.isfile(script):
        raise HTTPException(500, f"update.sh nicht gefunden unter {REPO_DIR}")
    try:
        await asyncio.to_thread(_start_update, script)
    except RuntimeError as exc:
        status = 409 if "already exists" in str(exc).lower() else 500
        raise HTTPException(status, str(exc))
    _invalidate_version_cache()
    return JSONResponse(
        {"ok": True, "message": "Update gestartet — Dienst startet gleich neu."},
        status_code=202,
    )


def _read_update_log():
    with open(UPDATE_LOG, errors="replace") as log_file:
        return "".join(deque(log_file, maxlen=40))


@app.get("/api/settings/update-log")
async def update_log(authorization: str = Header(default="")):
    require_token(authorization, ADMIN_TOKEN)
    try:
        return PlainTextResponse(await asyncio.to_thread(_read_update_log))
    except OSError:
        return PlainTextResponse("(noch kein Update-Log vorhanden)")


@app.get("/")
async def index():
    return FileResponse(os.path.join(BASE, "static", "index.html"))
