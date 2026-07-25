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
import sqlite3
import time
from contextlib import closing

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, JSONResponse
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


@app.get("/")
async def index():
    return FileResponse(os.path.join(BASE, "static", "index.html"))
