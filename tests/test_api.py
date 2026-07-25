import atexit
import os
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


if __name__ == "__main__":
    unittest.main()
