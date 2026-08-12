"""Tests for GitHub comment protocol metadata and human-readable bodies."""

import unittest

from plannotate.protocol import (
    BODY_MARKER,
    ProtocolError,
    build_comment_body,
    decode_metadata,
    encode_metadata,
    parse_comment_body,
)


def metadata(general=False):
    value = {
        "schema": "plannotate.github/v1",
        "plan_key": "example/classroom-engine",
        "version": 2,
        "artifact_path": ".plannotate/example/classroom-engine/v0002.html",
        "artifact_sha256": "a" * 64,
        "general": general,
        "anchor_id": None if general else "architecture-auth",
        "line": None if general else 42,
        "block_index": None if general else 7,
        "block_hash": None if general else "deadbeef",
        "quote": "" if general else "认证与权限",
        "heading_path": "" if general else "架构 > 权限",
        "selection": None if general else {"start": 1, "end": 3, "text": "证与"},
    }
    return value


class GitHubCommentProtocolTests(unittest.TestCase):
    def test_metadata_round_trip_is_canonical_and_unicode_safe(self):
        # Arrange
        original = metadata()

        # Act
        encoded = encode_metadata(original)
        decoded = decode_metadata(encoded)

        # Assert
        self.assertEqual(decoded, original)
        self.assertNotIn("=", encoded)

    def test_comment_body_keeps_readable_quotes_and_machine_payload(self):
        # Arrange / Act
        result = build_comment_body("请说明刷新令牌策略。", metadata())
        parsed = parse_comment_body(result)

        # Assert
        self.assertIn("Plannotate", result)
        self.assertIn("> 块：认证与权限", result)
        self.assertIn("> 高亮：“证与”", result)
        self.assertIn(BODY_MARKER, result)
        self.assertEqual(parsed["body"], "请说明刷新令牌策略。")
        self.assertEqual(parsed["metadata"], metadata())

    def test_general_comment_has_no_block_or_selection_header(self):
        # Arrange
        general = metadata(general=True)

        # Act
        result = build_comment_body("总体上建议补充回滚。", general)
        parsed = parse_comment_body(result)

        # Assert
        self.assertIn("> 总体意见", result)
        self.assertNotIn("> 块：", result)
        self.assertIsNone(parsed["metadata"]["anchor_id"])
        self.assertIsNone(parsed["metadata"]["selection"])

    def test_unrelated_comment_is_ignored_and_malformed_marker_is_rejected(self):
        self.assertIsNone(parse_comment_body("ordinary GitHub comment"))
        with self.assertRaises(ProtocolError):
            parse_comment_body(
                "<!-- plannotate:body -->\ntext\n"
                "<!-- plannotate:v1:abc -->"
            )

    def test_invalid_selection_and_oversized_body_are_rejected(self):
        # Arrange
        invalid = metadata()
        invalid["selection"] = {"start": 3, "end": 2, "text": "x"}

        # Act / Assert
        with self.assertRaises(ProtocolError):
            encode_metadata(invalid)
        with self.assertRaises(ProtocolError):
            build_comment_body("x" * 4001, metadata())

    def test_rejects_noncanonical_paths_unknown_fields_and_mixed_general_anchor(self):
        invalid_path = metadata()
        invalid_path["artifact_path"] = "docs/plan.html"
        unknown = metadata()
        unknown["surprise"] = True
        mixed = metadata(general=True)
        mixed["anchor_id"] = "unexpected"

        for value in (invalid_path, unknown, mixed):
            with self.subTest(value=value):
                with self.assertRaises(ProtocolError):
                    encode_metadata(value)

    def test_reserved_markers_cannot_make_the_human_body_ambiguous(self):
        value = metadata()
        value["quote"] = "literal <!-- plannotate:body --> marker"

        result = build_comment_body("safe", value)

        self.assertEqual(parse_comment_body(result)["body"], "safe")
        with self.assertRaises(ProtocolError):
            build_comment_body("bad " + BODY_MARKER, metadata())


if __name__ == "__main__":
    unittest.main()
