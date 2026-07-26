"""SQLite schema and connection factory shared by app.py and auth.py."""
import os
import sqlite3

BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.environ.get("DASH_DB", os.path.join(BASE, "data", "backups.db"))


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, decl: str):
    columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


def db() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")

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

    # ── Human user accounts (dashboard login) ───────────────────────────────
    conn.execute("""CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        totp_secret TEXT,
        totp_enabled INTEGER NOT NULL DEFAULT 0,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER,
        created_ts INTEGER NOT NULL,
        last_login_ts INTEGER
    )""")

    conn.execute("""CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT UNIQUE NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_ts INTEGER NOT NULL,
        expires_ts INTEGER NOT NULL,
        user_agent TEXT
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)")

    conn.execute("""CREATE TABLE IF NOT EXISTS webauthn_credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        credential_id TEXT UNIQUE NOT NULL,
        public_key TEXT NOT NULL,
        sign_count INTEGER NOT NULL DEFAULT 0,
        nickname TEXT,
        transports TEXT,
        created_ts INTEGER NOT NULL,
        last_used_ts INTEGER
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id)")

    # Short-lived, single-use state for multi-step auth ceremonies: pending
    # 2FA after a correct password, and WebAuthn registration/login challenges.
    conn.execute("""CREATE TABLE IF NOT EXISTS auth_challenges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT UNIQUE NOT NULL,
        kind TEXT NOT NULL,
        user_id INTEGER,
        payload TEXT,
        created_ts INTEGER NOT NULL,
        expires_ts INTEGER NOT NULL
    )""")

    return conn
