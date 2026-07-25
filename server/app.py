#!/usr/bin/env python3
"""Mailcow Backup Dashboard — central collector & enterprise UI.

Endpoints:
  POST /api/report     — agents push backup results (Bearer token)
  GET  /api/servers    — fleet state + per-server history
  GET  /api/summary    — aggregated KPIs for the fleet
  GET  /api/health     — plain health endpoint (Uptime-Kuma friendly)
  GET  /               — dashboard UI
"""
import os
import secrets
import sqlite3
import time
from contextlib import closing

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.environ.get("DASH_DB", os.path.join(BASE, "data", "backups.db"))
API_TOKEN = os.environ.get("DASH_TOKEN", "")
STALE_HOURS = int(os.environ.get("DASH_STALE_HOURS", "26"))

app = FastAPI(title="Mailcow Backup Dashboard", docs_url=None, redoc_url=None)


def db():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    conn.execute("""CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server TEXT NOT NULL,
        ts INTEGER NOT NULL,
        status TEXT NOT NULL,
        duration_s INTEGER,
        backup_gb REAL,
        repo_gb REAL,
        dedup_gb REAL,
        archives INTEGER,
        message TEXT
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_server_ts ON reports(server, ts DESC)")
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
    status: str  # ok | error
    duration_s: int | None = None
    backup_gb: float | None = None
    repo_gb: float | None = None
    dedup_gb: float | None = None
    archives: int | None = None
    message: str | None = None


def _state(last_status: str, last_ts: int, now: float) -> str:
    if now - last_ts > STALE_HOURS * 3600:
        return "stale"
    return "ok" if last_status == "ok" else "error"


@app.post("/api/report")
async def report(r: Report, authorization: str = Header(default="")):
    if not API_TOKEN or authorization != f"Bearer {API_TOKEN}":
        raise HTTPException(401, "invalid token")
    if r.status not in ("ok", "error"):
        raise HTTPException(422, "status must be ok|error")
    with closing(db()) as conn:
        conn.execute(
            "INSERT INTO reports (server, ts, status, duration_s, backup_gb, repo_gb, dedup_gb, archives, message)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (r.server.strip()[:200], int(time.time()), r.status, r.duration_s,
             r.backup_gb, r.repo_gb, r.dedup_gb, r.archives, (r.message or "")[:2000]),
        )
        conn.commit()
    return {"ok": True}


@app.get("/api/servers")
async def servers():
    now = time.time()
    with closing(db()) as conn:
        names = conn.execute(
            "SELECT server, MAX(ts) AS last_ts FROM reports GROUP BY server ORDER BY server"
        ).fetchall()
        out = []
        for n in names:
            last = conn.execute(
                "SELECT * FROM reports WHERE server=? ORDER BY ts DESC LIMIT 1",
                (n["server"],)).fetchone()
            history = conn.execute(
                "SELECT ts,status,duration_s,backup_gb,repo_gb,dedup_gb,archives"
                " FROM reports WHERE server=? ORDER BY ts DESC LIMIT 90",
                (n["server"],)).fetchall()
            errors = conn.execute(
                "SELECT ts,message FROM reports WHERE server=? AND status='error'"
                " ORDER BY ts DESC LIMIT 10", (n["server"],)).fetchall()
            out.append({
                "server": n["server"],
                "state": _state(last["status"], n["last_ts"], now),
                "last": dict(last),
                "history": [dict(h) for h in reversed(history)],
                "recent_errors": [dict(e) for e in errors],
            })
    return JSONResponse(out)


@app.get("/api/summary")
async def summary():
    now = time.time()
    with closing(db()) as conn:
        names = conn.execute(
            "SELECT server, MAX(ts) AS last_ts FROM reports GROUP BY server").fetchall()
        total = len(names)
        ok = err = stale = 0
        repo_sum = 0.0
        last_runs = []
        for n in names:
            last = conn.execute(
                "SELECT status, repo_gb, duration_s FROM reports WHERE server=?"
                " ORDER BY ts DESC LIMIT 1", (n["server"],)).fetchone()
            st = _state(last["status"], n["last_ts"], now)
            ok += st == "ok"
            err += st == "error"
            stale += st == "stale"
            repo_sum += last["repo_gb"] or 0
            last_runs.append({"server": n["server"], "ts": n["last_ts"],
                              "state": st, "duration_s": last["duration_s"]})
        runs_24h = conn.execute(
            "SELECT COUNT(*) c FROM reports WHERE ts > ?", (now - 86400,)).fetchone()["c"]
        fails_7d = conn.execute(
            "SELECT COUNT(*) c FROM reports WHERE status='error' AND ts > ?",
            (now - 7 * 86400,)).fetchone()["c"]
    return {"servers": total, "ok": ok, "error": err, "stale": stale,
            "repo_total_gb": round(repo_sum, 1), "runs_24h": runs_24h,
            "fails_7d": fails_7d, "last_runs": sorted(last_runs, key=lambda x: -x["ts"])}


@app.get("/api/health")
async def health():
    """Uptime-Kuma friendly: HTTP 200 only if every server is green."""
    now = time.time()
    with closing(db()) as conn:
        names = conn.execute(
            "SELECT server, MAX(ts) AS last_ts FROM reports GROUP BY server").fetchall()
        bad = []
        for n in names:
            last = conn.execute(
                "SELECT status FROM reports WHERE server=? ORDER BY ts DESC LIMIT 1",
                (n["server"],)).fetchone()
            st = _state(last["status"], n["last_ts"], now)
            if st != "ok":
                bad.append({"server": n["server"], "state": st})
    if bad:
        return JSONResponse({"status": "degraded", "problems": bad}, status_code=503)
    return {"status": "ok", "servers": len(names)}


app.mount("/static", StaticFiles(directory=os.path.join(BASE, "static")), name="static")


# ── Peer-Onboarding (NetBird-Style) ─────────────────────────────────────────
import json as _json

AGENT_SCRIPT = os.environ.get(
    "AGENT_SCRIPT",
    os.path.join(os.path.dirname(BASE), "agent", "mailcow-backup.sh"))
if not os.path.exists(AGENT_SCRIPT):
    AGENT_SCRIPT = os.path.join(BASE, "agent", "mailcow-backup.sh")


class Peer(BaseModel):
    name: str
    borg_repo: str
    borg_ssh_port: int = 23
    keep_daily: int = 7
    hour: int = 3
    mailcow_dir: str = "/opt/mailcow-dockerized"
    threads: int = 4


@app.get("/api/peers")
async def peers_list(authorization: str = Header(default="")):
    if not API_TOKEN or authorization != f"Bearer {API_TOKEN}":
        raise HTTPException(401, "invalid token")
    with closing(db()) as conn:
        rows = conn.execute("SELECT * FROM peers ORDER BY name").fetchall()
    return [dict(r) | {"config": _json.loads(r["config"])} for r in rows]


@app.post("/api/peers")
async def peers_create(p: Peer, request: Request, authorization: str = Header(default="")):
    if not API_TOKEN or authorization != f"Bearer {API_TOKEN}":
        raise HTTPException(401, "invalid token")
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
    if not API_TOKEN or authorization != f"Bearer {API_TOKEN}":
        raise HTTPException(401, "invalid token")
    with closing(db()) as conn:
        cur = conn.execute("DELETE FROM peers WHERE name=?", (name,))
        conn.commit()
    if cur.rowcount == 0:
        raise HTTPException(404, "peer not found")
    return {"ok": True}


@app.get("/enroll/{key}", response_class=PlainTextResponse)
async def enroll(key: str, request: Request):
    """One-shot enrollment script — configures a mailcow server as backup peer."""
    with closing(db()) as conn:
        row = conn.execute("SELECT * FROM peers WHERE enroll_key=?", (key,)).fetchone()
        if not row:
            raise HTTPException(404, "unknown enrollment key")
        conn.execute("UPDATE peers SET enrolled_ts=? WHERE enroll_key=?",
                     (int(time.time()), key))
        conn.commit()
    cfg = _json.loads(row["config"])
    base = str(request.base_url).rstrip("/")
    try:
        agent = open(AGENT_SCRIPT).read()
    except OSError:
        raise HTTPException(500, "agent script missing on server")
    # Agent-Skript wird als Heredoc eingebettet -> ein einziger curl|bash-Befehl
    return f"""#!/bin/bash
# Mailcow Backup Agent — automatisches Enrollment für Peer '{row["name"]}'
set -euo pipefail
[ "$(id -u)" = 0 ] || {{ echo "Bitte als root ausführen."; exit 1; }}
echo "── Enrollment: {row["name"]} ──"

apt-get update -qq && apt-get install -y -qq borgbackup curl >/dev/null

[ -f /root/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N "" -f /root/.ssh/id_ed25519 -q

if [ ! -f /root/.borg-passphrase ]; then
  openssl rand -base64 32 > /root/.borg-passphrase && chmod 600 /root/.borg-passphrase
  echo "NEUE BORG-PASSPHRASE: $(cat /root/.borg-passphrase)"
  echo "⚠ EXTERN SICHERN — ohne sie ist das Backup unlesbar!"
fi

cat > /etc/mailcow-backup.conf <<CONF
MAILCOW_DIR="{cfg["mailcow_dir"]}"
BACKUP_LOCATION="/opt/mailcow-backups"
BORG_REPO="{cfg["borg_repo"]}"
BORG_SSH_PORT="{cfg["borg_ssh_port"]}"
KEEP_DAILY="{cfg["keep_daily"]}"
THREADS="{cfg["threads"]}"
DASH_URL="{base}"
DASH_TOKEN="{API_TOKEN}"
CONF
chmod 600 /etc/mailcow-backup.conf

cat > /usr/local/sbin/mailcow-backup.sh <<'AGENT_EOF'
{agent}
AGENT_EOF
chmod 700 /usr/local/sbin/mailcow-backup.sh

echo "0 {cfg["hour"]} * * * root /usr/local/sbin/mailcow-backup.sh" > /etc/cron.d/mailcow-backup
chmod 644 /etc/cron.d/mailcow-backup

echo ""
echo "── Noch zu tun ──"
echo "1) SSH-Key am Backup-Ziel hinterlegen (falls noch nicht):"
echo "   ssh -p{cfg["borg_ssh_port"]} {cfg["borg_repo"].split(":")[0]} install-ssh-key < /root/.ssh/id_ed25519.pub"
echo "   Key: $(cat /root/.ssh/id_ed25519.pub)"
echo "2) Repo initialisieren (nur beim ersten Mal):"
echo "   export BORG_PASSPHRASE=\\$(cat /root/.borg-passphrase); export BORG_RSH='ssh -p{cfg["borg_ssh_port"]}'"
echo "   borg init --encryption=repokey-blake2 '{cfg["borg_repo"]}'"
echo "   borg key export '{cfg["borg_repo"]}' /root/borg-key-backup.txt"
echo "3) Testlauf: /usr/local/sbin/mailcow-backup.sh"
echo ""
echo "✔ Enrollment abgeschlossen — Cron: täglich {cfg["hour"]}:00 Uhr"
"""


@app.get("/agent/script", response_class=PlainTextResponse)
async def agent_script():
    """Latest agent script — used by agents for self-updates."""
    try:
        return open(AGENT_SCRIPT).read()
    except OSError:
        raise HTTPException(500, "agent script missing on server")


@app.get("/")
async def index():
    return FileResponse(os.path.join(BASE, "static", "index.html"))
