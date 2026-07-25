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
os.environ["DASH_ADMIN_TOKEN"] = "admin-test-token"
os.environ["REPO_DIR"] = str(ROOT)
sys.path.insert(0, str(ROOT / "server"))

from fastapi.testclient import TestClient  # noqa: E402

import app as app_module  # noqa: E402


AGENT_HEADERS = {"Authorization": "Bearer agent-test-token"}
ADMIN_HEADERS = {"Authorization": "Bearer admin-test-token"}


class ApiContractTests(unittest.TestCase):
    def setUp(self):
        DB_PATH.unlink(missing_ok=True)
        app_module._invalidate_version_cache()
        self.client = TestClient(app_module.app)

    def tearDown(self):
        self.client.close()
        DB_PATH.unlink(missing_ok=True)

    def test_security_headers_and_empty_health(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("default-src 'self'", response.headers["Content-Security-Policy"])
        self.assertEqual(response.headers["X-Frame-Options"], "DENY")

        health = self.client.get("/api/health")
        self.assertEqual(health.status_code, 503)
        self.assertEqual(health.json()["status"], "empty")

    def test_agent_and_admin_permissions_are_separate(self):
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
            self.client.post("/api/report", json=report, headers=ADMIN_HEADERS).status_code,
            401,
        )
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
        self.assertEqual(
            self.client.get("/api/peers", headers=AGENT_HEADERS).status_code,
            401,
        )
        self.assertEqual(
            self.client.get("/api/peers", headers=ADMIN_HEADERS).status_code,
            200,
        )

    def test_enrollment_is_one_time_and_shell_quoted(self):
        invalid = self.client.post(
            "/api/peers",
            headers=ADMIN_HEADERS,
            json={"name": "invalid peer", "borg_repo": "host:path"},
        )
        self.assertEqual(invalid.status_code, 422)

        created = self.client.post(
            "/api/peers",
            headers=ADMIN_HEADERS,
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
        peers = self.client.get("/api/peers", headers=ADMIN_HEADERS).json()
        self.assertIsNone(peers[0]["enroll_key"])

    def test_settings_are_admin_only_and_update_is_accepted(self):
        snapshot = {
            "repo_dir": str(ROOT),
            "installed": {"commit": "abc123", "date": "now", "subject": "Installed"},
            "latest": {"commit": "def456", "date": "now", "subject": "Latest"},
            "behind": 1,
            "update_available": True,
            "stale_hours": 26,
        }
        self.assertEqual(
            self.client.get("/api/settings/version", headers=AGENT_HEADERS).status_code,
            401,
        )
        with patch.object(app_module, "_collect_version", return_value=snapshot):
            version = self.client.get("/api/settings/version", headers=ADMIN_HEADERS)
        self.assertEqual(version.status_code, 200)
        self.assertTrue(version.json()["update_available"])

        with patch.object(app_module, "_start_update") as start_update:
            response = self.client.post("/api/settings/update", headers=ADMIN_HEADERS)
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
        invalid = self.client.post(
            "/api/peers", headers=ADMIN_HEADERS,
            json={"name": "mx06.example.de", "borg_repo": "user@host:backups/mx06",
                  "backup_components": "vmail,not-a-thing"},
        )
        self.assertEqual(invalid.status_code, 422)

        created = self.client.post(
            "/api/peers", headers=ADMIN_HEADERS,
            json={"name": "mx07.example.de", "borg_repo": "user@host:backups/mx07",
                  "backup_components": "mysql, vmail, mysql"},
        )
        self.assertEqual(created.status_code, 200)
        peers = self.client.get("/api/peers", headers=ADMIN_HEADERS).json()
        peer = next(p for p in peers if p["name"] == "mx07.example.de")
        self.assertEqual(peer["config"]["backup_components"], "mysql,vmail")

    def test_enrollment_script_installs_the_full_suite_with_three_cron_jobs(self):
        created = self.client.post(
            "/api/peers", headers=ADMIN_HEADERS,
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

        original_db_path = app_module.DB
        app_module.DB = str(legacy_db)
        try:
            migrated = app_module.db()
            row = migrated.execute("SELECT kind, components FROM reports").fetchone()
            migrated.close()
        finally:
            app_module.DB = original_db_path
        self.assertEqual(row["kind"], "backup")
        self.assertIsNone(row["components"])
        legacy_db.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
