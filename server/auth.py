"""Authentication: password hashing, sessions, TOTP and WebAuthn (passkeys).

Design notes
------------
- Human users authenticate via a server-side session referenced by an
  HttpOnly cookie. This is entirely independent from the Bearer-token model
  used by backup agents (DASH_TOKEN) for POST /api/report and
  /agent/scripts/* — agents never see a browser and never hold a session.
- Passwords are hashed with scrypt (Python's standard-library ``hashlib``,
  no extra dependency) using a random salt per user.
- CSRF mitigation: the session cookie uses SameSite=Lax and every
  state-changing endpoint requires a JSON body. A cross-site HTML form
  cannot send an application/json body, and a cross-site fetch cannot send
  one to this origin either, because the app sends no CORS headers (the
  browser blocks the cross-origin request before it would matter).
- WebAuthn (passkeys) requires a secure context: HTTPS, or the literal
  hostname "localhost". Plain LAN IP addresses over HTTP — the most common
  way this dashboard is reached per docs/INSTALL.md — do NOT qualify, so
  passkeys are hidden/disabled in that case. TOTP and passwords always work.
"""
import base64
import hashlib
import hmac
import io
import ipaddress
import json
import os
import secrets
import sqlite3
import time
from contextlib import closing
from typing import Any

import pyotp
import qrcode
import qrcode.image.svg
from fastapi import HTTPException, Request, Response
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import base64url_to_bytes
from webauthn.helpers.structs import (
    AttestationConveyancePreference,
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from db import db

SESSION_COOKIE = "backupdash_session"
SESSION_HOURS = int(os.environ.get("DASH_SESSION_HOURS", "12"))
CHALLENGE_TTL_SECONDS = 5 * 60
LOCKOUT_THRESHOLD = 5
LOCKOUT_SECONDS = 15 * 60
RP_NAME = "Mailcow Backup Dashboard"
MIN_PASSWORD_LENGTH = 10

_SCRYPT_N = 2 ** 14
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_DKLEN = 32


# ── Passwords ────────────────────────────────────────────────────────────
def hash_password(password: str) -> str:
    salt = os.urandom(16)
    derived = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, dklen=_SCRYPT_DKLEN
    )
    return (
        f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}"
        f"${base64.b64encode(salt).decode()}${base64.b64encode(derived).decode()}"
    )


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt_b64, hash_b64 = stored.split("$")
        if scheme != "scrypt":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        derived = hashlib.scrypt(
            password.encode("utf-8"), salt=salt, n=int(n), r=int(r), p=int(p), dklen=len(expected)
        )
        return hmac.compare_digest(derived, expected)
    except (ValueError, TypeError):
        return False


# ── Users ────────────────────────────────────────────────────────────────
def get_user_by_username(conn: sqlite3.Connection, username: str):
    return conn.execute("SELECT * FROM users WHERE username=?", (username.strip(),)).fetchone()


def get_user_by_id(conn: sqlite3.Connection, user_id: int):
    return conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()


def count_users(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"]


def count_admins(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) c FROM users WHERE is_admin=1").fetchone()["c"]


def create_user(conn: sqlite3.Connection, username: str, password: str, is_admin: bool) -> int:
    cursor = conn.execute(
        "INSERT INTO users (username, password_hash, is_admin, created_ts) VALUES (?,?,?,?)",
        (username.strip(), hash_password(password), int(is_admin), int(time.time())),
    )
    conn.commit()
    return cursor.lastrowid


def public_user(user: sqlite3.Row) -> dict:
    return {
        "id": user["id"],
        "username": user["username"],
        "is_admin": bool(user["is_admin"]),
        "totp_enabled": bool(user["totp_enabled"]),
        "created_ts": user["created_ts"],
        "last_login_ts": user["last_login_ts"],
    }


# ── Brute-force lockout ──────────────────────────────────────────────────
def is_locked(user: sqlite3.Row, now: float | None = None) -> bool:
    locked_until = user["locked_until"]
    return bool(locked_until and locked_until > (now or time.time()))


def register_failed_attempt(conn: sqlite3.Connection, user_id: int):
    now = int(time.time())
    row = conn.execute("SELECT failed_attempts FROM users WHERE id=?", (user_id,)).fetchone()
    attempts = (row["failed_attempts"] if row else 0) + 1
    locked_until = now + LOCKOUT_SECONDS if attempts >= LOCKOUT_THRESHOLD else None
    conn.execute(
        "UPDATE users SET failed_attempts=?, locked_until=? WHERE id=?",
        (attempts, locked_until, user_id),
    )
    conn.commit()


def reset_failed_attempts(conn: sqlite3.Connection, user_id: int):
    conn.execute(
        "UPDATE users SET failed_attempts=0, locked_until=NULL, last_login_ts=? WHERE id=?",
        (int(time.time()), user_id),
    )
    conn.commit()


# ── Sessions ─────────────────────────────────────────────────────────────
def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(conn: sqlite3.Connection, user_id: int, user_agent: str) -> str:
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, created_ts, expires_ts, user_agent) VALUES (?,?,?,?,?)",
        (_token_hash(token), user_id, now, now + SESSION_HOURS * 3600, (user_agent or "")[:300]),
    )
    conn.commit()
    return token


def get_session(conn: sqlite3.Connection, token: str):
    if not token:
        return None
    row = conn.execute(
        "SELECT sessions.id AS session_id, sessions.expires_ts, users.*"
        " FROM sessions JOIN users ON users.id = sessions.user_id"
        " WHERE sessions.token_hash=?", (_token_hash(token),)
    ).fetchone()
    if not row:
        return None
    if row["expires_ts"] < time.time():
        conn.execute("DELETE FROM sessions WHERE token_hash=?", (_token_hash(token),))
        conn.commit()
        return None
    return row


def delete_session(conn: sqlite3.Connection, token: str):
    if token:
        conn.execute("DELETE FROM sessions WHERE token_hash=?", (_token_hash(token),))
        conn.commit()


def delete_sessions_for_user(conn: sqlite3.Connection, user_id: int):
    conn.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
    conn.commit()


def set_session_cookie(response: Response, token: str, request: Request):
    response.set_cookie(
        SESSION_COOKIE, token,
        max_age=SESSION_HOURS * 3600,
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
        path="/",
    )


def clear_session_cookie(response: Response):
    response.delete_cookie(SESSION_COOKIE, path="/")


async def optional_user(request: Request):
    token = request.cookies.get(SESSION_COOKIE, "")
    if not token:
        return None
    with closing(db()) as conn:
        return get_session(conn, token)


async def require_user(request: Request) -> sqlite3.Row:
    user = await optional_user(request)
    if not user:
        raise HTTPException(401, "not authenticated")
    return user


async def require_admin(request: Request) -> sqlite3.Row:
    user = await require_user(request)
    if not user["is_admin"]:
        raise HTTPException(403, "admin privileges required")
    return user


# ── Short-lived, single-use challenges (2FA step-up, WebAuthn ceremonies) ──
def create_challenge(conn: sqlite3.Connection, kind: str, user_id: int | None,
                      payload: dict, ttl: int = CHALLENGE_TTL_SECONDS) -> str:
    token = secrets.token_urlsafe(24)
    now = int(time.time())
    conn.execute(
        "INSERT INTO auth_challenges (token, kind, user_id, payload, created_ts, expires_ts)"
        " VALUES (?,?,?,?,?,?)",
        (token, kind, user_id, json.dumps(payload), now, now + ttl),
    )
    conn.commit()
    return token


def pop_challenge(conn: sqlite3.Connection, token: str, kind: str) -> dict | None:
    """Fetch-and-delete a single-use challenge. Returns None if missing, of
    the wrong kind, or expired (still deleting it either way)."""
    row = conn.execute("SELECT * FROM auth_challenges WHERE token=?", (token,)).fetchone()
    if not row:
        return None
    conn.execute("DELETE FROM auth_challenges WHERE token=?", (token,))
    conn.commit()
    if row["kind"] != kind or row["expires_ts"] < time.time():
        return None
    return {"user_id": row["user_id"], "payload": json.loads(row["payload"] or "{}")}


def peek_challenge(conn: sqlite3.Connection, token: str, kind: str) -> dict | None:
    """Like pop_challenge but does not delete — used for multi-attempt steps
    (e.g. re-entering a wrong TOTP code) where the challenge should survive
    a single failed attempt until it naturally expires or succeeds."""
    row = conn.execute("SELECT * FROM auth_challenges WHERE token=?", (token,)).fetchone()
    if not row or row["kind"] != kind or row["expires_ts"] < time.time():
        return None
    return {"user_id": row["user_id"], "payload": json.loads(row["payload"] or "{}")}


def delete_challenge(conn: sqlite3.Connection, token: str):
    conn.execute("DELETE FROM auth_challenges WHERE token=?", (token,))
    conn.commit()


def purge_expired_challenges(conn: sqlite3.Connection):
    conn.execute("DELETE FROM auth_challenges WHERE expires_ts < ?", (int(time.time()),))
    conn.commit()


# ── TOTP (RFC 6238) ──────────────────────────────────────────────────────
def generate_totp_secret() -> str:
    return pyotp.random_base32()


def totp_provisioning_uri(secret: str, username: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=username, issuer_name=RP_NAME)


def totp_qr_svg(uri: str) -> str:
    image = qrcode.make(uri, image_factory=qrcode.image.svg.SvgPathImage, box_size=8, border=1)
    buffer = io.BytesIO()
    image.save(buffer)
    return buffer.getvalue().decode("utf-8")


def verify_totp(secret: str, code: str) -> bool:
    if not secret or not code:
        return False
    try:
        return pyotp.TOTP(secret).verify(code.strip(), valid_window=1)
    except Exception:
        return False


# ── WebAuthn (passkeys) ──────────────────────────────────────────────────
def resolve_webauthn_context(request: Request) -> dict:
    hostname = request.url.hostname or "localhost"
    is_https = request.url.scheme == "https"
    is_loopback_name = hostname == "localhost"
    try:
        ipaddress.ip_address(hostname)
        is_ip_literal = True
    except ValueError:
        is_ip_literal = False
    secure_context = is_https or is_loopback_name
    return {
        "rp_id": hostname,
        "origin": str(request.base_url).rstrip("/"),
        "secure_context": secure_context,
        # A valid WebAuthn RP ID must be a domain string; IP literals (the
        # common way this dashboard is reached on a LAN) are not accepted by
        # browsers even when the context is otherwise secure.
        "available": secure_context and not is_ip_literal,
    }


def webauthn_registration_options(conn: sqlite3.Connection, user: sqlite3.Row, context: dict):
    existing = conn.execute(
        "SELECT credential_id FROM webauthn_credentials WHERE user_id=?", (user["id"],)
    ).fetchall()
    exclude = [
        PublicKeyCredentialDescriptor(id=base64.b64decode(row["credential_id"]))
        for row in existing
    ]
    options = generate_registration_options(
        rp_id=context["rp_id"],
        rp_name=RP_NAME,
        user_name=user["username"],
        user_id=str(user["id"]).encode("utf-8"),
        user_display_name=user["username"],
        attestation=AttestationConveyancePreference.NONE,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.PREFERRED,
            user_verification=UserVerificationRequirement.PREFERRED,
        ),
        exclude_credentials=exclude or None,
    )
    challenge_token = create_challenge(
        conn, "webauthn_register", user["id"],
        {"challenge": base64.b64encode(options.challenge).decode()},
    )
    return json.loads(options_to_json(options)), challenge_token


def webauthn_finish_registration(conn: sqlite3.Connection, context: dict, challenge_token: str,
                                  credential: dict, nickname: str) -> None:
    popped = pop_challenge(conn, challenge_token, "webauthn_register")
    if not popped:
        raise HTTPException(400, "Registrierung abgelaufen — bitte erneut starten")
    try:
        verification = verify_registration_response(
            credential=credential,
            expected_challenge=base64.b64decode(popped["payload"]["challenge"]),
            expected_rp_id=context["rp_id"],
            expected_origin=context["origin"],
        )
    except Exception as exc:
        raise HTTPException(400, f"Passkey konnte nicht registriert werden: {exc}")

    transports = []
    if isinstance(credential, dict):
        transports = credential.get("response", {}).get("transports") or []

    try:
        conn.execute(
            "INSERT INTO webauthn_credentials"
            " (user_id, credential_id, public_key, sign_count, nickname, transports, created_ts)"
            " VALUES (?,?,?,?,?,?,?)",
            (popped["user_id"],
             base64.b64encode(verification.credential_id).decode(),
             base64.b64encode(verification.credential_public_key).decode(),
             verification.sign_count,
             (nickname or "Passkey")[:100],
             json.dumps(transports),
             int(time.time())),
        )
        conn.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Dieser Passkey ist bereits registriert")


def webauthn_authentication_options(conn: sqlite3.Connection, context: dict, user: sqlite3.Row | None):
    allow_credentials = None
    if user is not None:
        rows = conn.execute(
            "SELECT credential_id, transports FROM webauthn_credentials WHERE user_id=?", (user["id"],)
        ).fetchall()
        allow_credentials = [
            PublicKeyCredentialDescriptor(id=base64.b64decode(row["credential_id"]))
            for row in rows
        ]
    options = generate_authentication_options(
        rp_id=context["rp_id"],
        allow_credentials=allow_credentials or None,
        user_verification=UserVerificationRequirement.PREFERRED,
    )
    challenge_token = create_challenge(
        conn, "webauthn_login", user["id"] if user else None,
        {"challenge": base64.b64encode(options.challenge).decode()},
    )
    return json.loads(options_to_json(options)), challenge_token


def webauthn_finish_authentication(conn: sqlite3.Connection, context: dict,
                                    challenge_token: str, credential: dict) -> sqlite3.Row:
    popped = pop_challenge(conn, challenge_token, "webauthn_login")
    if not popped:
        raise HTTPException(400, "Anmeldung abgelaufen — bitte erneut versuchen")

    credential_id_b64 = None
    try:
        raw_id = credential.get("rawId") if isinstance(credential, dict) else None
        if raw_id:
            credential_id_b64 = base64.b64encode(base64url_to_bytes(raw_id)).decode()
    except Exception:
        credential_id_b64 = None
    if not credential_id_b64:
        raise HTTPException(400, "Ungültige Passkey-Antwort")

    stored = conn.execute(
        "SELECT * FROM webauthn_credentials WHERE credential_id=?", (credential_id_b64,)
    ).fetchone()
    if not stored:
        raise HTTPException(400, "Unbekannter Passkey")
    if popped["user_id"] is not None and popped["user_id"] != stored["user_id"]:
        raise HTTPException(400, "Passkey gehört nicht zu diesem Anmeldeversuch")

    try:
        verification = verify_authentication_response(
            credential=credential,
            expected_challenge=base64.b64decode(popped["payload"]["challenge"]),
            expected_rp_id=context["rp_id"],
            expected_origin=context["origin"],
            credential_public_key=base64.b64decode(stored["public_key"]),
            credential_current_sign_count=stored["sign_count"],
        )
    except Exception as exc:
        raise HTTPException(400, f"Passkey-Anmeldung fehlgeschlagen: {exc}")

    conn.execute(
        "UPDATE webauthn_credentials SET sign_count=?, last_used_ts=? WHERE id=?",
        (verification.new_sign_count, int(time.time()), stored["id"]),
    )
    conn.commit()
    return get_user_by_id(conn, stored["user_id"])


def list_webauthn_credentials(conn: sqlite3.Connection, user_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT id, credential_id, nickname, created_ts, last_used_ts, transports"
        " FROM webauthn_credentials WHERE user_id=? ORDER BY created_ts", (user_id,)
    ).fetchall()
    out = []
    for row in rows:
        try:
            transports = json.loads(row["transports"] or "[]")
        except (TypeError, ValueError):
            transports = []
        out.append({
            "id": row["id"],
            "nickname": row["nickname"] or "Passkey",
            "created_ts": row["created_ts"],
            "last_used_ts": row["last_used_ts"],
            "transports": transports,
        })
    return out
