import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AGENT_DIR = ROOT / "agent"

SUITE_MARKER = "Mailcow Backup Suite"
KNOWN_COMPONENTS = {"vmail", "crypt", "redis", "rspamd", "postfix", "mysql"}


def _read(relative: str) -> str:
    return (AGENT_DIR / relative).read_text(encoding="utf-8")


def _code_only(content: str) -> str:
    """Strips full-line comments so documentation mentions (e.g. 'kein docker
    stop/start') don't trigger checks meant for actual shell commands."""
    return "\n".join(
        line for line in content.splitlines() if not line.strip().startswith("#")
    )


class AgentSuiteContractTests(unittest.TestCase):
    """Static, execution-free checks for the backup/verify/watchdog agent suite.

    These do not require Docker or a real mailcow installation; they guard
    invariants that the self-update mechanism and the component model rely on.
    """

    def test_all_suite_files_have_valid_bash_syntax(self):
        files = [
            "lib/common.sh",
            "mailcow-backup.sh",
            "mailcow-verify.sh",
            "mailcow-watchdog.sh",
            "install-agent.sh",
        ]
        for relative in files:
            path = AGENT_DIR / relative
            self.assertTrue(path.exists(), f"{relative} is missing")
            result = subprocess.run(
                ["bash", "-n", str(path)], capture_output=True, text=True
            )
            self.assertEqual(result.returncode, 0, f"{relative}: {result.stderr}")

    def test_self_updatable_files_contain_suite_marker(self):
        # agent_fetch_and_replace() greps for this marker before installing a
        # downloaded file; losing it would silently disable self-updates.
        for relative in ("lib/common.sh", "mailcow-backup.sh", "mailcow-verify.sh",
                          "mailcow-watchdog.sh"):
            self.assertIn(SUITE_MARKER, _read(relative), relative)

    def test_backup_agent_validates_and_checks_known_components_only(self):
        content = _read("mailcow-backup.sh")
        for component in KNOWN_COMPONENTS:
            self.assertIn(component, content)
        # The component->archive-file mapping must only reference components
        # that mailcow's backup_and_restore.sh actually supports.
        self.assertIn("backup_mariadb.tar.zst", content)
        self.assertIn('VALID_COMPONENTS="vmail crypt redis rspamd postfix mysql all"', content)

    def test_backup_agent_calls_mailcow_helper_exactly_once(self):
        content = _read("mailcow-backup.sh")
        self.assertEqual(
            content.count("backup_and_restore.sh\" backup"), 1,
            "backup_and_restore.sh must be invoked once so all requested "
            "components land in the same timestamped directory",
        )

    def test_verify_agent_never_touches_the_live_mailcow_stack(self):
        content = _code_only(_read("mailcow-verify.sh"))
        for forbidden in ("docker stop", "docker start", "docker compose down",
                           "docker compose up", "docker-compose"):
            self.assertNotIn(forbidden, content)

    def test_verify_agent_cleans_up_its_extraction_directory(self):
        content = _read("mailcow-verify.sh")
        self.assertIn("cleanup()", content)
        self.assertIn("rm -rf \"$WORKDIR\"", content)

    def test_watchdog_agent_never_hard_fails_on_soft_checks(self):
        content = _read("mailcow-watchdog.sh")
        # A hard 'set -e' would abort the whole run on the first failed check
        # (e.g. an unreachable SSH host), defeating the watchdog's purpose.
        self.assertIn("set -uo pipefail", content)
        self.assertNotIn("set -euo pipefail", content)

    def test_report_payloads_are_json_escaped(self):
        for relative in ("lib/common.sh",):
            content = _read(relative)
            self.assertIn("agent_json_escape", content)

    def test_install_agent_deploys_the_whole_suite(self):
        content = _read("install-agent.sh")
        for target in (
            "lib/common.sh",
            "mailcow-backup.sh",
            "mailcow-verify.sh",
            "mailcow-watchdog.sh",
        ):
            self.assertIn(target, content)
        self.assertIn("mailcow-watchdog.sh", content)
        self.assertIn("/etc/cron.d/mailcow-backup", content)


if __name__ == "__main__":
    unittest.main()
