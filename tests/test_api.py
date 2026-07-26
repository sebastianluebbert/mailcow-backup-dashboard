import atexit
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
TEST_STATE = tempfile.TemporaryDirectory(prefix="backupdash-tests-")
atexit.register(TEST_STATE.cleanup)
DB_PATH = Path(TEST_STATE.name) / "backups.db"

os.environ["DASH_DB"] = str(DB_PATH)
os.environ["DASH_TOKEN"] = "agent-test-token"
os.environ["REPO_DIR"] = str(ROOT)
os.environ.pop("DASH_ADMIN_TOKEN", None)
os.environ.pop("DASH_BOOTSTRAP_USER", None)
os.environ.pop("DASH_BOOTSTRAP_PASSWORD", None)
sys.path.insert(0, str(ROOT / "server"))

import pyotp  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import app as app_module  # noqa: E402
import auth as auth_module  # noqa: E402
from db import db as get_db  # noqa: E402


AGENT_HEADERS = {"Authorization": "Bearer agent-test-token"}
ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "correct horse battery staple"


class ApiContractTests(unittest.TestCase):
    def setUp(self):
        DB_PATH.unlink(missing_ok=True)
        app_module._invalidate_version_cache()
        self.client = TestClient(app_module.app)

    def tearDown(self):
        self.client.close()
        DB_PATH.unlink(missing_ok=True)

    def _setup_admin(self, username=ADMIN_USERNAME, password=ADMIN_PASSWORD):
        """Creates the first admin account and leaves the client authenticated
        (TestClient persists the session cookie across subsequent requests)."""
        response = self.client.post("/api/auth/setup", json={"username": username, "password": password})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["user"]

    def test_security_headers_and_empty_health(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("default-src 'self'", response.headers["Content-Security-Policy"])
        self.assertEqual(response.headers["X-Frame-Options"], "DENY")

        health = self.client.get("/api/health")
        self.assertEqual(health.status_code, 503)
        self.assertEqual(health.json()["status"], "empty")

    def test_agent_and_session_permissions_are_separate(self):
        report = {
            "server": "mx01.example.de",
            "status": "ok",
            "duration_s": 42,
            "backup_gb": 12.5,
            "repo_gb": 7.1,
            "archives": 7,
        }
        self.assertEqual(self.client.post("/api/report", json=report).status_code, 401)
        self.assertEqual(
            self.client.post("/api/report", json=report, headers=AGENT_HEADERS).status_code,
            200,
        )
        self.assertEqual(self.client.get("/api/health").status_code, 200)

        self.assertEqual(self.client.get("/agent/script").status_code, 401)
        self.assertEqual(
            self.client.get("/agent/script", headers=AGENT_HEADERS).status_code,
            200,
        )

        # A valid agent token does not grant access to human-user endpoints.
        self.assertEqual(
            self.client.get("/api/peers", headers=AGENT_HEADERS).status_code,
            401,
        )
        self.assertEqual(self.client.get("/api/peers").status_code, 401)

        self._setup_admin()
        self.assertEqual(self.client.get("/api/peers").status_code, 200)

    def test_enrollment_is_one_time_and_shell_quoted(self):
        self._setup_admin()

        invalid = self.client.post(
            "/api/peers",
            json={"name": "invalid peer", "borg_repo": "host:path"},
        )
        self.assertEqual(invalid.status_code, 422)

        created = self.client.post(
            "/api/peers",
            json={
                "name": "mx02.example.de",
                "borg_repo": "user@host:backups/$(unsafe)",
                "mailcow_dir": "/opt/mailcow dockerized",
                "hour": 3,
            },
        )
        self.assertEqual(created.status_code, 200)
        key = created.json()["enroll_key"]

        enrolled = self.client.get(f"/enroll/{key}")
        self.assertEqual(enrolled.status_code, 200)
        self.assertIn("BORG_REPO='user@host:backups/$(unsafe)'", enrolled.text)
        self.assertIn("MAILCOW_DIR='/opt/mailcow dockerized'", enrolled.text)
        syntax = subprocess.run(
            ["bash", "-n"],
            input=enrolled.text,
            text=True,
            capture_output=True,
        )
        self.assertEqual(syntax.returncode, 0, syntax.stderr)

        self.assertEqual(self.client.get(f"/enroll/{key}").status_code, 404)
        peers = self.client.get("/api/peers").json()
        self.assertIsNone(peers[0]["enroll_key"])

    def test_settings_require_login_and_update_is_accepted(self):
        snapshot = {
            "repo_dir": str(ROOT),
            "installed": {"commit": "abc123", "date": "now", "subject": "Installed"},
            "latest": {"commit": "def456", "date": "now", "subject": "Latest"},
            "behind": 1,
            "update_available": True,
            "stale_hours": 26,
        }
        self.assertEqual(self.client.get("/api/settings/version").status_code, 401)

        self._setup_admin()
        with patch.object(app_module, "_collect_version", return_value=snapshot):
            version = self.client.get("/api/settings/version")
        self.assertEqual(version.status_code, 200)
        self.assertTrue(version.json()["update_available"])

        with patch.object(app_module, "_start_update") as start_update:
            response = self.client.post("/api/settings/update")
        self.assertEqual(response.status_code, 202)
        start_update.assert_called_once()

    def test_report_kinds_are_isolated_and_summary_counts_them(self):
        server = "mx04.example.de"

        def post(kind, status, **extra):
            payload = {"server": server, "kind": kind, "status": status, **extra}
            response = self.client.post("/api/report", json=payload, headers=AGENT_HEADERS)
            self.assertEqual(response.status_code, 200, response.text)

        post("backup", "ok", duration_s=100, backup_gb=5.0, repo_gb=3.0, archives=4,
             components={"vmail": {"present": True, "bytes": 123456}})
        post("verify", "error", message="zstd -t fehlgeschlagen")
        post("watchdog", "ok")

        servers = self.client.get("/api/servers").json()
        self.assertEqual(len(servers), 1)
        entry = servers[0]
        self.assertEqual(entry["state"], "ok")
        self.assertEqual(entry["last"]["components"], {"vmail": {"present": True, "bytes": 123456}})
        self.assertIsNotNone(entry["verify"])
        self.assertEqual(entry["verify"]["state"], "error")
        self.assertEqual(entry["verify"]["last_message"], "zstd -t fehlgeschlagen")
        self.assertIsNotNone(entry["watchdog"])
        self.assertEqual(entry["watchdog"]["state"], "ok")

        summary = self.client.get("/api/summary").json()
        self.assertEqual(summary["servers"], 1)
        self.assertEqual(summary["ok"], 1)
        self.assertEqual(summary["verify_fails_30d"], 1)
        self.assertEqual(summary["watchdog_fails_24h"], 0)

    def test_invalid_report_kind_is_rejected(self):
        response = self.client.post(
            "/api/report",
            json={"server": "mx05.example.de", "kind": "bogus", "status": "ok"},
            headers=AGENT_HEADERS,
        )
        self.assertEqual(response.status_code, 422)

    def test_peer_backup_components_are_validated_and_deduplicated(self):
        self._setup_admin()

        invalid = self.client.post(
            "/api/peers",
            json={"name": "mx06.example.de", "borg_repo": "user@host:backups/mx06",
                  "backup_components": "vmail,not-a-thing"},
        )
        self.assertEqual(invalid.status_code, 422)

        created = self.client.post(
            "/api/peers",
            json={"name": "mx07.example.de", "borg_repo": "user@host:backups/mx07",
                  "backup_components": "mysql, vmail, mysql"},
        )
        self.assertEqual(created.status_code, 200)
        peers = self.client.get("/api/peers").json()
        peer = next(p for p in peers if p["name"] == "mx07.example.de")
        self.assertEqual(peer["config"]["backup_components"], "mysql,vmail")

    def test_enrollment_script_installs_the_full_suite_with_three_cron_jobs(self):
        self._setup_admin()
        created = self.client.post(
            "/api/peers",
            json={"name": "mx08.example.de", "borg_repo": "user@host:backups/mx08",
                  "backup_components": "vmail,mysql", "hour": 4},
        )
        self.assertEqual(created.status_code, 200)
        key = created.json()["enroll_key"]
        enrolled = self.client.get(f"/enroll/{key}")
        self.assertEqual(enrolled.status_code, 200)
        for marker in (
            "AGENT_LIB_EOF", "AGENT_BACKUP_EOF", "AGENT_VERIFY_EOF", "AGENT_WATCHDOG_EOF",
            "mailcow-verify.sh", "mailcow-watchdog.sh",
            "0 4 * * * root /usr/local/sbin/mailcow-backup.sh",
            "15 * * * * root /usr/local/sbin/mailcow-watchdog.sh",
            "0 6 * * 0 root /usr/local/sbin/mailcow-verify.sh",
        ):
            self.assertIn(marker, enrolled.text, marker)
        syntax = subprocess.run(
            ["bash", "-n"], input=enrolled.text, text=True, capture_output=True
        )
        self.assertEqual(syntax.returncode, 0, syntax.stderr)

    def test_schema_migration_adds_missing_columns_to_old_databases(self):
        legacy_db = Path(TEST_STATE.name) / "legacy.db"
        legacy_db.unlink(missing_ok=True)
        conn = sqlite3.connect(legacy_db)
        conn.execute("""CREATE TABLE reports (
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
        conn.execute(
            "INSERT INTO reports (server, ts, status, message) VALUES (?,?,?,?)",
            ("legacy.example.de", 1, "ok", "pre-migration row"),
        )
        conn.commit()
        conn.close()

        import db as db_module
        original_db_path = db_module.DB
        db_module.DB = str(legacy_db)
        try:
            migrated = get_db()
            row = migrated.execute("SELECT kind, components FROM reports").fetchone()
            user_count = migrated.execute("SELECT COUNT(*) c FROM users").fetchone()["c"]
            migrated.close()
        finally:
            db_module.DB = original_db_path
        self.assertEqual(row["kind"], "backup")
        self.assertIsNone(row["components"])
        self.assertEqual(user_count, 0)
        legacy_db.unlink(missing_ok=True)

    # ── Human user auth: setup, login, lockout ──────────────────────────────
    def test_auth_status_reports_needs_setup_until_first_user_exists(self):
        status = self.client.get("/api/auth/status").json()
        self.assertTrue(status["needs_setup"])
        self.assertFalse(status["authenticated"])

        self._setup_admin()
        status = self.client.get("/api/auth/status").json()
        self.assertFalse(status["needs_setup"])
        self.assertTrue(status["authenticated"])
        self.assertEqual(status["user"]["username"], ADMIN_USERNAME)

    def test_setup_is_rejected_once_a_user_already_exists(self):
        self._setup_admin()
        second = self.client.post("/api/auth/setup", json={"username": "someone", "password": ADMIN_PASSWORD})
        self.assertEqual(second.status_code, 409)

    def test_login_lockout_after_repeated_failures(self):
        self._setup_admin()
        self.client.post("/api/auth/logout")

        for _ in range(auth_module.LOCKOUT_THRESHOLD):
            response = self.client.post(
                "/api/auth/login", json={"username": ADMIN_USERNAME, "password": "wrong"}
            )
            self.assertEqual(response.status_code, 401)

        locked = self.client.post(
            "/api/auth/login", json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD}
        )
        self.assertEqual(locked.status_code, 429)

    def test_totp_setup_and_step_up_login(self):
        self._setup_admin()

        setup = self.client.post("/api/account/totp/setup")
        self.assertEqual(setup.status_code, 200, setup.text)
        secret = setup.json()["secret"]
        self.assertTrue(setup.json()["qr_svg"].startswith("<?xml"))

        wrong = self.client.post("/api/account/totp/confirm", json={"code": "000000"})
        self.assertEqual(wrong.status_code, 400)

        confirm = self.client.post("/api/account/totp/confirm", json={"code": pyotp.TOTP(secret).now()})
        self.assertEqual(confirm.status_code, 200)

        self.client.post("/api/auth/logout")
        login = self.client.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD})
        self.assertEqual(login.status_code, 200)
        body = login.json()
        self.assertTrue(body["mfa_required"])
        self.assertIn("totp", body["methods"])
        login_token = body["login_token"]

        bad_code = self.client.post("/api/auth/login/totp", json={"login_token": login_token, "code": "000000"})
        self.assertEqual(bad_code.status_code, 401)

        # The challenge must survive a failed attempt so the user can retry.
        good_code = self.client.post(
            "/api/auth/login/totp",
            json={"login_token": login_token, "code": pyotp.TOTP(secret).now()},
        )
        self.assertEqual(good_code.status_code, 200)
        self.assertEqual(self.client.get("/api/peers").status_code, 200)

    def test_password_change_invalidates_the_current_session(self):
        self._setup_admin()
        response = self.client.post(
            "/api/account/password",
            json={"current_password": ADMIN_PASSWORD, "new_password": "another very long passphrase"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get("/api/peers").status_code, 401)

        relogin = self.client.post(
            "/api/auth/login", json={"username": ADMIN_USERNAME, "password": "another very long passphrase"}
        )
        self.assertEqual(relogin.status_code, 200)

    def test_user_management_is_admin_only_and_protects_last_admin(self):
        me = self._setup_admin()

        created = self.client.post(
            "/api/users", json={"username": "viewer", "password": "viewer long passphrase", "is_admin": False}
        )
        self.assertEqual(created.status_code, 200, created.text)
        viewer_id = created.json()["id"]

        listing = self.client.get("/api/users").json()
        self.assertEqual(len(listing), 2)

        cannot_delete_self = self.client.delete(f"/api/users/{me['id']}")
        self.assertEqual(cannot_delete_self.status_code, 409)

        deleted = self.client.delete(f"/api/users/{viewer_id}")
        self.assertEqual(deleted.status_code, 200)

        # A non-admin user cannot manage other accounts.
        self.client.post(
            "/api/users", json={"username": "viewer2", "password": "viewer2 long passphrase", "is_admin": False}
        )
        self.client.post("/api/auth/logout")
        self.client.post("/api/auth/login", json={"username": "viewer2", "password": "viewer2 long passphrase"})
        self.assertEqual(self.client.get("/api/users").status_code, 403)

    def test_webauthn_endpoints_require_a_secure_context(self):
        # TestClient's default host ("testserver") is neither HTTPS nor
        # "localhost", so passkey registration must be refused cleanly.
        self._setup_admin()
        response = self.client.post("/api/account/webauthn/register/options")
        self.assertEqual(response.status_code, 400)

        status = self.client.get("/api/auth/status").json()
        self.assertFalse(status["webauthn"]["available"])


if __name__ == "__main__":
    unittest.main()
