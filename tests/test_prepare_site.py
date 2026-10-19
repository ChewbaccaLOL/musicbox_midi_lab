from pathlib import Path
import tempfile
import unittest

from tools.prepare_site import prepare_site


class PrepareSiteTests(unittest.TestCase):
    def test_versions_changed_assets_without_touching_sources(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source, output = root / "web", root / "site"
            source.mkdir()
            html = '<link href="styles.css"><script src="app.js"></script><img src="icon.png">'
            (source / "index.html").write_text(html)
            (source / "styles.css").write_text("body {}")
            (source / "app.js").write_text("first")
            prepare_site(source, output)
            first = (output / "index.html").read_text()
            self.assertIn('styles.css?v=', first)
            self.assertIn('app.js?v=', first)
            self.assertIn('src="icon.png"', first)
            self.assertEqual((source / "index.html").read_text(), html)
            (source / "app.js").write_text("second")
            prepare_site(source, output)
            second = (output / "index.html").read_text()
            self.assertNotEqual(first, second)
            self.assertEqual(first.split('<script')[0], second.split('<script')[0])

    def test_rejects_output_inside_sources(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp)
            with self.assertRaises(ValueError):
                prepare_site(source, source / "site")


if __name__ == "__main__":
    unittest.main()
