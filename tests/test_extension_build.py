"""Tests for the installable extension release builder."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile


class ExtensionBuildTests(unittest.TestCase):
    def test_build_contains_only_production_extension_files(self):
        root = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
        script = os.path.join(root, "scripts", "build_extension.py")
        with tempfile.TemporaryDirectory() as output:
            result = subprocess.run(
                [sys.executable, script, "--output", output],
                check=False, capture_output=True, text=True, timeout=20,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            release = os.path.join(output, "plannotate-v0.2.3")
            archive_path = release + ".zip"
            with open(os.path.join(release, "manifest.json"), encoding="utf-8") as source:
                manifest = json.load(source)
            with zipfile.ZipFile(archive_path) as archive:
                names = archive.namelist()
                bad = [name for name in names if "/tests/" in name or name.endswith(".test.js")]
            self.assertEqual(manifest["manifest_version"], 3)
            self.assertFalse(bad)
            self.assertIn("plannotate-v0.2.3/INSTALL.txt", names)
            self.assertTrue(os.path.isfile(os.path.join(output, "SHA256SUMS.txt")))


if __name__ == "__main__":
    unittest.main()
