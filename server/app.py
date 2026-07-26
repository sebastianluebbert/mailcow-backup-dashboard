#!/usr/bin/env python3
"""Mailcow Backup Dashboard — central collector & operations UI.

Endpoints:
  POST /api/report         — agents push results (Bearer token)
                              kind: backup | verify | watchdog
  GET  /api/servers        — fleet state + per-server history & checks
  GET  /api/summary        — aggregated KPIs for the fleet
  GET  /api/health         — plain health endpoint (Uptime-Kuma friendly)
  /api/auth/*, /api/account/*, /api/users/*
                            — human user accounts: login, TOTP, passkeys,
                              user management (session-cookie protected)
  GET  /api/peers          — protected peer administration
  GET  /api/settings/*     — protected version, update and log operations
  GET  /agent/scripts/{n}  — protected suite component download (self-update)
  GET  /               — dashboard UI

Two independent auth models are in play:
  - Bearer token (DASH_TOKEN) for machine agents: POST /api/report,
    GET /agent/scripts/*, GET /agent/script.
  - Session cookie (human users, see auth.py) for everything an admin does
    in the browser: peers, settings/updates, account & user management.
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

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

import auth
from db import BASE, db

API_TOKEN = os.environ.get("DASH_TOKEN", "")
STALE_HOURS = int(os.environ.get("DASH_STALE_HOURS", "26"))
REPORT_KINDS = {"backup", "verify", "watchdog"}

app = FastAPI(title="Mailcow Backup Dashboard", docs_url=None, redoc_url=None)


@app.on_event("startup")
async def bootstrap_admin_user():
    """Creates the initial admin account from env vars, if configured and no
    users exist yet. Purely additive/idempotent — safe to leave the env vars
    set permanently, they only ever act once."""
    username = os.environ.get("DASH_BOOTSTRAP_USER", "").strip()
    password = os.environ.get("DASH_BOOTSTRAP_PASSWORD", "")
    if not username or not password:
        return
    with closing(db()) as conn:
        if auth.count_users(conn) == 0:
            auth.create_user(conn, username, password, is_admin=True)


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


# ── Authentication: login, 2FA (TOTP), passkeys (WebAuthn) ──────────────────
USERNAME_PATTERN = r"^[A-Za-z0-9._-]{3,64}$"


class LoginRequest(BaseModel):
    username: str
    password: str


class SetupRequest(BaseModel):
    username: str = Field(pattern=USERNAME_PATTERN)
    password: str = Field(min_length=auth.MIN_PASSWORD_LENGTH, max_length=200)


class TotpLoginRequest(BaseModel):
    login_token: str
    code: str = Field(min_length=6, max_length=10)


class WebAuthnLoginOptionsRequest(BaseModel):
    login_token: str | None = None
    username: str | None = None


class WebAuthnVerifyRequest(BaseModel):
    state_token: str
    login_token: str | None = None
    credential: dict[str, Any]


class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=auth.MIN_PASSWORD_LENGTH, max_length=200)


class TotpConfirmRequest(BaseModel):
    code: str = Field(min_length=6, max_length=10)


class TotpDisableRequest(BaseModel):
    current_password: str


class WebAuthnRegisterVerifyRequest(BaseModel):
    challenge_token: str
    credential: dict[str, Any]
    nickname: str = Field(default="Passkey", max_length=100)


class UserCreateRequest(BaseModel):
    username: str = Field(pattern=USERNAME_PATTERN)
    password: str = Field(min_length=auth.MIN_PASSWORD_LENGTH, max_length=200)
    is_admin: bool = False


def _webauthn_summary(context: dict) -> dict:
    return {"secure_context": context["secure_context"], "available": context["available"]}


@app.get("/api/auth/status")
async def auth_status(request: Request):
    with closing(db()) as conn:
        needs_setup = auth.count_users(conn) == 0
        session_user = None
        if not needs_setup:
            token = request.cookies.get(auth.SESSION_COOKIE, "")
            session_user = auth.get_session(conn, token) if token else None
    context = auth.resolve_webauthn_context(request)
    return {
        "needs_setup": needs_setup,
        "authenticated": session_user is not None,
        "user": auth.public_user(session_user) if session_user else None,
        "webauthn": _webauthn_summary(context),
    }


@app.post("/api/auth/setup")
async def auth_setup(body: SetupRequest, request: Request, response: Response):
    with closing(db()) as conn:
        if auth.count_users(conn) > 0:
            raise HTTPException(409, "setup already completed")
        user_id = auth.create_user(conn, body.username, body.password, is_admin=True)
        auth.reset_failed_attempts(conn, user_id)
        token = auth.create_session(conn, user_id, request.headers.get("user-agent", ""))
        user = auth.get_user_by_id(conn, user_id)
    auth.set_session_cookie(response, token, request)
    return {"ok": True, "user": auth.public_user(user)}


@app.post("/api/auth/login")
async def auth_login(body: LoginRequest, request: Request, response: Response):
    with closing(db()) as conn:
        auth.purge_expired_challenges(conn)
        user = auth.get_user_by_username(conn, body.username)
        if not user:
            raise HTTPException(401, "Benutzername oder Passwort ist falsch")
        if auth.is_locked(user):
            raise HTTPException(429, "Konto vorübergehend gesperrt — bitte später erneut versuchen")
        if not auth.verify_password(body.password, user["password_hash"]):
            auth.register_failed_attempt(conn, user["id"])
            raise HTTPException(401, "Benutzername oder Passwort ist falsch")

        has_webauthn = conn.execute(
            "SELECT 1 FROM webauthn_credentials WHERE user_id=? LIMIT 1", (user["id"],)
        ).fetchone() is not None
        methods = []
        if user["totp_enabled"]:
            methods.append("totp")
        if has_webauthn:
            methods.append("webauthn")

        if methods:
            login_token = auth.create_challenge(conn, "mfa_pending", user["id"], {})
            return {"mfa_required": True, "login_token": login_token, "methods": methods}

        auth.reset_failed_attempts(conn, user["id"])
        token = auth.create_session(conn, user["id"], request.headers.get("user-agent", ""))
    auth.set_session_cookie(response, token, request)
    return {"ok": True, "user": auth.public_user(user)}


@app.post("/api/auth/login/totp")
async def auth_login_totp(body: TotpLoginRequest, request: Request, response: Response):
    with closing(db()) as conn:
        pending = auth.peek_challenge(conn, body.login_token, "mfa_pending")
        if not pending:
            raise HTTPException(400, "Anmeldevorgang abgelaufen — bitte erneut anmelden")
        user = auth.get_user_by_id(conn, pending["user_id"])
        if not user or not user["totp_enabled"]:
            raise HTTPException(400, "TOTP ist für dieses Konto nicht aktiviert")
        if auth.is_locked(user):
            raise HTTPException(429, "Konto vorübergehend gesperrt — bitte später erneut versuchen")
        if not auth.verify_totp(user["totp_secret"], body.code):
            auth.register_failed_attempt(conn, user["id"])
            raise HTTPException(401, "Ungültiger Code")
        auth.delete_challenge(conn, body.login_token)
        auth.reset_failed_attempts(conn, user["id"])
        token = auth.create_session(conn, user["id"], request.headers.get("user-agent", ""))
    auth.set_session_cookie(response, token, request)
    return {"ok": True, "user": auth.public_user(user)}


@app.post("/api/auth/login/webauthn/options")
async def auth_login_webauthn_options(body: WebAuthnLoginOptionsRequest, request: Request):
    context = auth.resolve_webauthn_context(request)
    if not context["available"]:
        raise HTTPException(400, "Passkeys sind auf diesem Host nicht verfügbar")
    with closing(db()) as conn:
        user = None
        if body.login_token:
            pending = auth.peek_challenge(conn, body.login_token, "mfa_pending")
            if not pending:
                raise HTTPException(400, "Anmeldevorgang abgelaufen — bitte erneut anmelden")
            user = auth.get_user_by_id(conn, pending["user_id"])
        elif body.username:
            user = auth.get_user_by_username(conn, body.username)
        options, state_token = auth.webauthn_authentication_options(conn, context, user)
    return {"options": options, "state_token": state_token}


@app.post("/api/auth/login/webauthn/verify")
async def auth_login_webauthn_verify(body: WebAuthnVerifyRequest, request: Request, response: Response):
    context = auth.resolve_webauthn_context(request)
    with closing(db()) as conn:
        user = auth.webauthn_finish_authentication(conn, context, body.state_token, body.credential)
        if body.login_token:
            pending = auth.peek_challenge(conn, body.login_token, "mfa_pending")
            if not pending or pending["user_id"] != user["id"]:
                raise HTTPException(400, "Passkey gehört nicht zu diesem Anmeldeversuch")
            auth.delete_challenge(conn, body.login_token)
        if auth.is_locked(user):
            raise HTTPException(429, "Konto vorübergehend gesperrt — bitte später erneut versuchen")
        auth.reset_failed_attempts(conn, user["id"])
        token = auth.create_session(conn, user["id"], request.headers.get("user-agent", ""))
    auth.set_session_cookie(response, token, request)
    return {"ok": True, "user": auth.public_user(user)}


@app.post("/api/auth/logout")
async def auth_logout(request: Request, response: Response):
    token = request.cookies.get(auth.SESSION_COOKIE, "")
    with closing(db()) as conn:
        auth.delete_session(conn, token)
    auth.clear_session_cookie(response)
    return {"ok": True}


# ── Account self-service (logged-in user) ───────────────────────────────────
@app.get("/api/account")
async def account_get(request: Request, user: sqlite3.Row = Depends(auth.require_user)):
    context = auth.resolve_webauthn_context(request)
    with closing(db()) as conn:
        credentials = auth.list_webauthn_credentials(conn, user["id"])
    return {
        "user": auth.public_user(user),
        "webauthn_credentials": credentials,
        "webauthn": _webauthn_summary(context),
    }


@app.post("/api/account/password")
async def account_change_password(body: PasswordChangeRequest,
                                   user: sqlite3.Row = Depends(auth.require_user)):
    if not auth.verify_password(body.current_password, user["password_hash"]):
        raise HTTPException(401, "Aktuelles Passwort ist falsch")
    with closing(db()) as conn:
        conn.execute("UPDATE users SET password_hash=? WHERE id=?",
                     (auth.hash_password(body.new_password), user["id"]))
        conn.commit()
        auth.delete_sessions_for_user(conn, user["id"])
    return {"ok": True, "message": "Passwort geändert — bitte erneut anmelden."}


@app.post("/api/account/totp/setup")
async def account_totp_setup(user: sqlite3.Row = Depends(auth.require_user)):
    secret = auth.generate_totp_secret()
    with closing(db()) as conn:
        conn.execute("UPDATE users SET totp_secret=?, totp_enabled=0 WHERE id=?",
                     (secret, user["id"]))
        conn.commit()
    uri = auth.totp_provisioning_uri(secret, user["username"])
    return {"secret": secret, "otpauth_uri": uri, "qr_svg": auth.totp_qr_svg(uri)}


@app.post("/api/account/totp/confirm")
async def account_totp_confirm(body: TotpConfirmRequest, user: sqlite3.Row = Depends(auth.require_user)):
    with closing(db()) as conn:
        current = auth.get_user_by_id(conn, user["id"])
        if not current["totp_secret"]:
            raise HTTPException(400, "Kein TOTP-Setup gestartet")
        if not auth.verify_totp(current["totp_secret"], body.code):
            raise HTTPException(400, "Ungültiger Code")
        conn.execute("UPDATE users SET totp_enabled=1 WHERE id=?", (user["id"],))
        conn.commit()
    return {"ok": True}


@app.post("/api/account/totp/disable")
async def account_totp_disable(body: TotpDisableRequest, user: sqlite3.Row = Depends(auth.require_user)):
    if not auth.verify_password(body.current_password, user["password_hash"]):
        raise HTTPException(401, "Passwort ist falsch")
    with closing(db()) as conn:
        conn.execute("UPDATE users SET totp_secret=NULL, totp_enabled=0 WHERE id=?", (user["id"],))
        conn.commit()
    return {"ok": True}


@app.post("/api/account/webauthn/register/options")
async def account_webauthn_register_options(request: Request, user: sqlite3.Row = Depends(auth.require_user)):
    context = auth.resolve_webauthn_context(request)
    if not context["available"]:
        raise HTTPException(400, "Passkeys sind auf diesem Host nicht verfügbar (HTTPS oder 'localhost' nötig)")
    with closing(db()) as conn:
        options, challenge_token = auth.webauthn_registration_options(conn, user, context)
    return {"options": options, "challenge_token": challenge_token}


@app.post("/api/account/webauthn/register/verify")
async def account_webauthn_register_verify(body: WebAuthnRegisterVerifyRequest, request: Request,
                                            user: sqlite3.Row = Depends(auth.require_user)):
    context = auth.resolve_webauthn_context(request)
    with closing(db()) as conn:
        auth.webauthn_finish_registration(conn, context, body.challenge_token, body.credential, body.nickname)
    return {"ok": True}


@app.delete("/api/account/webauthn/{credential_row_id}")
async def account_webauthn_delete(credential_row_id: int, user: sqlite3.Row = Depends(auth.require_user)):
    with closing(db()) as conn:
        cur = conn.execute(
            "DELETE FROM webauthn_credentials WHERE id=? AND user_id=?",
            (credential_row_id, user["id"]),
        )
        conn.commit()
    if cur.rowcount == 0:
        raise HTTPException(404, "passkey not found")
    return {"ok": True}


# ── User management (admin only) ────────────────────────────────────────────
@app.get("/api/users")
async def users_list(_: sqlite3.Row = Depends(auth.require_admin)):
    with closing(db()) as conn:
        rows = conn.execute("SELECT * FROM users ORDER BY username").fetchall()
        out = []
        for row in rows:
            credential_count = conn.execute(
                "SELECT COUNT(*) c FROM webauthn_credentials WHERE user_id=?", (row["id"],)
            ).fetchone()["c"]
            out.append(auth.public_user(row) | {"webauthn_count": credential_count})
    return out


@app.post("/api/users")
async def users_create(body: UserCreateRequest, admin: sqlite3.Row = Depends(auth.require_admin)):
    with closing(db()) as conn:
        try:
            user_id = auth.create_user(conn, body.username, body.password, body.is_admin)
        except sqlite3.IntegrityError:
            raise HTTPException(409, "Benutzername bereits vergeben")
        user = auth.get_user_by_id(conn, user_id)
    return auth.public_user(user)


@app.delete("/api/users/{user_id}")
async def users_delete(user_id: int, admin: sqlite3.Row = Depends(auth.require_admin)):
    with closing(db()) as conn:
        target = auth.get_user_by_id(conn, user_id)
        if not target:
            raise HTTPException(404, "user not found")
        if target["is_admin"] and auth.count_admins(conn) <= 1:
            raise HTTPException(409, "der letzte Administrator kann nicht gelöscht werden")
        conn.execute("DELETE FROM users WHERE id=?", (user_id,))
        conn.commit()
    return {"ok": True}


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
async def peers_list(_: sqlite3.Row = Depends(auth.require_user)):
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
async def peers_create(p: Peer, request: Request, _: sqlite3.Row = Depends(auth.require_user)):
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
async def peers_delete(name: str, _: sqlite3.Row = Depends(auth.require_user)):
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
async def version(_: sqlite3.Row = Depends(auth.require_user)):
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
async def run_update(_: sqlite3.Row = Depends(auth.require_user)):
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
async def update_log(_: sqlite3.Row = Depends(auth.require_user)):
    try:
        return PlainTextResponse(await asyncio.to_thread(_read_update_log))
    except OSError:
        return PlainTextResponse("(noch kein Update-Log vorhanden)")


@app.get("/")
async def index():
    return FileResponse(os.path.join(BASE, "static", "index.html"))
