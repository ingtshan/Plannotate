"""End-to-end tests for the repository-local GitHub CLI surface."""

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest

from plannotate.cli import main


class GitHubCliTests(unittest.TestCase):
    def test_package_command_appends_a_repository_artifact(self):
        with tempfile.TemporaryDirectory() as repository:
            source = os.path.join(repository, "plan.html")
            with open(source, "w", encoding="utf-8") as destination:
                destination.write('<h1 data-plan-anchor="title">Plan</h1>\n')
            output = io.StringIO()

            with contextlib.redirect_stdout(output):
                result = main([
                    "package", source, "example/demo", "--repo-root", repository,
                ])

            manifest_path = os.path.join(
                repository, ".plannotate", "example", "demo", "manifest.json"
            )
            with open(manifest_path, "r", encoding="utf-8") as manifest_file:
                manifest = json.load(manifest_file)
            self.assertEqual(result, 0)
            self.assertEqual(manifest["latest"], 1)
            self.assertIn("created .plannotate/example/demo/v0001.html", output.getvalue())

    def test_partial_selection_fails_before_authentication_or_network(self):
        errors = io.StringIO()

        with contextlib.redirect_stderr(errors):
            with self.assertRaises(SystemExit) as raised:
                main([
                    "comment", "team/repo#7", "example/demo", "body",
                    "--selection-start", "0",
                ])

        self.assertEqual(raised.exception.code, 2)
        self.assertIn("selection start/end/text", errors.getvalue())

    def test_repository_launcher_exposes_all_commands(self):
        root = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
        launcher = os.path.join(root, "bin", "plannotate")

        result = subprocess.run(
            [sys.executable, launcher, "--help"], check=False,
            capture_output=True, text=True, timeout=10,
        )

        self.assertEqual(result.returncode, 0)
        self.assertIn("package,plans,pull,comment,reply,resolve,reopen,delete", result.stdout)


if __name__ == "__main__":
    unittest.main()
