import unittest
from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "server" / "static" / "index.html"


class DocumentInspector(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags = []
        self.attributes = []
        self.scripts = []
        self._active_script = None

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        self.tags.append(tag)
        self.attributes.append((tag, attributes))
        if tag == "script":
            script = {"attributes": attributes, "content": ""}
            self.scripts.append(script)
            self._active_script = script

    def handle_endtag(self, tag):
        if tag == "script":
            self._active_script = None

    def handle_data(self, data):
        if self._active_script is not None:
            self._active_script["content"] += data


class EnterpriseUiContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.index_text = INDEX.read_text(encoding="utf-8")
        cls.inspector = DocumentInspector()
        cls.inspector.feed(cls.index_text)

    def test_document_has_accessible_landmarks(self):
        for landmark in ("aside", "nav", "header", "main", "footer"):
            self.assertIn(landmark, self.inspector.tags)
        self.assertIn('href="#main-content"', self.index_text)
        self.assertIn('aria-live="polite"', self.index_text)

    def test_assets_are_external_and_pinned(self):
        script_sources = [
            script["attributes"].get("src")
            for script in self.inspector.scripts
            if script["attributes"].get("src")
        ]
        self.assertIn("/static/app.js", script_sources)
        self.assertIn(
            "https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js",
            script_sources,
        )
        self.assertIn('href="/static/styles.css"', self.index_text)

        chart_script = next(
            script for script in self.inspector.scripts
            if "chart.js@" in script["attributes"].get("src", "")
        )
        self.assertTrue(chart_script["attributes"].get("integrity", "").startswith("sha384-"))
        self.assertEqual(chart_script["attributes"].get("crossorigin"), "anonymous")

    def test_no_inline_script_style_or_event_handlers(self):
        for script in self.inspector.scripts:
            self.assertFalse(script["content"].strip(), "Inline JavaScript is not allowed")
        self.assertNotIn("<style", self.index_text.lower())

        for tag, attributes in self.inspector.attributes:
            self.assertNotIn("style", attributes, f"Inline style found on <{tag}>")
            inline_events = [name for name in attributes if name.lower().startswith("on")]
            self.assertEqual(inline_events, [], f"Inline event handler found on <{tag}>")

    def test_deploy_scripts_include_all_ui_assets(self):
        assets = ("index.html", "styles.css", "app.js")
        for script_path in ("server/install-server.sh", "update.sh"):
            contents = (ROOT / script_path).read_text(encoding="utf-8")
            for asset in assets:
                self.assertIn(asset, contents, f"{asset} missing from {script_path}")

    def test_backend_sets_browser_security_policy(self):
        app_source = (ROOT / "server" / "app.py").read_text(encoding="utf-8")
        for header in (
            "Content-Security-Policy",
            "X-Content-Type-Options",
            "X-Frame-Options",
            "Referrer-Policy",
        ):
            self.assertIn(header, app_source)


if __name__ == "__main__":
    unittest.main()
