"""Tests for immutable GitHub plan artifact generation."""

import hashlib
import json
import os
import tempfile
import unittest

from plannotate.artifact import (
    ArtifactError,
    build_artifact,
    fnv1a_utf16,
    scan_anchors,
    valid_plan_key,
)


class GitHubArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.source = os.path.join(self.temporary.name, "source.html")

    def _write(self, body):
        with open(self.source, "w", encoding="utf-8") as destination:
            destination.write(body)

    def test_scans_browser_compatible_blocks_lines_headings_and_unicode_hash(self):
        # Arrange
        source = "\n".join((
            "<!doctype html>",
            '<h1 data-plan-anchor="overview">总览😀</h1>',
            "<p>第一段 <strong>内容</strong></p>",
            '<img alt="结构图" src="data:image/png;base64,AA==">',
            "<p>   </p>",
        ))

        # Act
        anchors = scan_anchors(source)

        # Assert
        self.assertEqual(len(anchors), 3)
        self.assertEqual(anchors[0]["anchor_id"], "overview")
        self.assertEqual(anchors[0]["line"], 2)
        self.assertEqual(anchors[1]["quote"], "第一段 内容")
        self.assertEqual(anchors[1]["heading_path"], "总览😀")
        self.assertEqual(anchors[2]["quote"], "[图] 结构图")
        self.assertEqual(fnv1a_utf16("😀"), "cb31c4b8")

    def test_appends_versions_without_overwriting_prior_artifacts(self):
        # Arrange
        first_body = '<h1 data-plan-anchor="title">第一版</h1>\n<p>内容</p>\n'
        self._write(first_body)

        # Act
        first = build_artifact(
            self.source, self.temporary.name, "example/classroom-engine",
            created_at="2026-08-12T10:00:00-07:00",
        )
        self._write('<h1 data-plan-anchor="title">第二版</h1>\n<p>新内容</p>\n')
        second = build_artifact(
            self.source, self.temporary.name, "example/classroom-engine",
            created_at="2026-08-12T11:00:00-07:00",
        )

        # Assert
        manifest_path = first["manifest_path"]
        with open(manifest_path, "r", encoding="utf-8") as source:
            manifest = json.load(source)
        self.assertEqual(manifest["latest"], 2)
        self.assertEqual(len(manifest["versions"]), 2)
        self.assertEqual(first["artifact"]["version"], 1)
        self.assertEqual(second["artifact"]["version"], 2)
        self.assertEqual(len(first["artifact"]["anchors_sha256"]), 64)
        first_html = os.path.join(os.path.dirname(manifest_path), "v0001.html")
        with open(first_html, "rb") as source:
            preserved = source.read()
        self.assertEqual(preserved, first_body.encode("utf-8"))
        self.assertEqual(
            first["artifact"]["artifact_sha256"],
            hashlib.sha256(first_body.encode("utf-8")).hexdigest(),
        )

    def test_svg_blocks_use_direct_title_and_inherit_figure_anchor(self):
        # Arrange
        source = "\n".join((
            '<figure data-plan-anchor="context-diagram">',
            "<svg><title>系统上下文图</title><rect/></svg>",
            "<figcaption>图例说明</figcaption>",
            "</figure>",
            '<figure data-plan-anchor="second">',
            "<svg><rect><title>tooltip</title></rect></svg>",
            "<svg><title>后备图</title></svg>",
            "</figure>",
        ))

        # Act
        first_svg, caption, second_svg, third_svg = scan_anchors(source)

        # Assert: the first media block claims the figure anchor and its title
        self.assertEqual(first_svg["anchor_id"], "context-diagram")
        self.assertEqual(first_svg["quote"], "[图] 系统上下文图")
        self.assertEqual(caption["quote"], "图例说明")
        self.assertEqual(caption["anchor_id"], caption["legacy_block_id"])
        # A nested shape title is not the diagram title
        self.assertEqual(second_svg["anchor_id"], "second")
        self.assertEqual(second_svg["quote"], "[图] svg")
        # Only one media block inherits each figure anchor
        self.assertEqual(third_svg["anchor_id"], third_svg["legacy_block_id"])
        self.assertEqual(third_svg["quote"], "[图] 后备图")

    def test_rejects_executable_or_external_content_and_duplicate_anchors(self):
        invalid_sources = (
            "<script>alert(1)</script>",
            '<p onclick="alert(1)">unsafe</p>',
            '<img src="https://example.com/image.png">',
            '<p data-plan-anchor="same">one</p><p data-plan-anchor="same">two</p>',
            '<figure data-plan-anchor="bad anchor"><svg></svg></figure>',
            '<figure data-plan-anchor="dup"><svg></svg></figure>'
            '<p data-plan-anchor="dup">text</p>',
        )

        for source in invalid_sources:
            with self.subTest(source=source):
                with self.assertRaises(ArtifactError):
                    scan_anchors(source)

    def test_plan_key_validation_accepts_namespaces_and_rejects_traversal(self):
        valid = ("example/classroom-engine", "项目/方案_v2", "a/b/c/d/e")
        invalid = ("demo", "a/../b", "/absolute", "a//b", "a/b/c/d/e/f")

        for value in valid:
            self.assertTrue(valid_plan_key(value), value)
        for value in invalid:
            self.assertFalse(valid_plan_key(value), value)

    def test_self_closing_text_block_does_not_capture_following_content(self):
        anchors = scan_anchors("<p/><p>kept</p>")

        self.assertEqual(len(anchors), 1)
        self.assertEqual(anchors[0]["quote"], "kept")

    def test_never_overwrites_a_preexisting_version_file(self):
        self._write("<p>new</p>")
        directory = os.path.join(
            self.temporary.name, ".plannotate", "example", "demo"
        )
        os.makedirs(directory)
        target = os.path.join(directory, "v0001.html")
        with open(target, "w", encoding="utf-8") as destination:
            destination.write("preserved")

        with self.assertRaises(ArtifactError):
            build_artifact(self.source, self.temporary.name, "example/demo")
        with open(target, "r", encoding="utf-8") as source:
            self.assertEqual(source.read(), "preserved")

    def test_rejects_artifact_namespace_symlink_outside_repository(self):
        self._write("<p>safe source</p>")
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        os.symlink(outside.name, os.path.join(self.temporary.name, ".plannotate"))

        with self.assertRaisesRegex(ArtifactError, "escapes repository"):
            build_artifact(self.source, self.temporary.name, "example/demo")


if __name__ == "__main__":
    unittest.main()
