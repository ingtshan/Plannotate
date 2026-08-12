"""Golden tests for token-conscious GitHub review exports."""

import unittest

from plannotate.format import bind_manifest, protocol_threads, threads_to_markdown
from plannotate.protocol import build_comment_body, parse_comment_body


def metadata(version, general=False, index=0, heading="架构"):
    return {
        "schema": "plannotate.github/v1",
        "plan_key": "example/demo",
        "version": version,
        "artifact_path": ".plannotate/example/demo/v{0:04d}.html".format(version),
        "artifact_sha256": "a" * 64,
        "general": general,
        "anchor_id": None if general else "b{0}-deadbeef".format(index),
        "line": None if general else index + 2,
        "block_index": None if general else index,
        "block_hash": None if general else "deadbeef",
        "quote": "" if general else "块引文",
        "heading_path": "" if general else heading,
        "selection": None,
    }


def github_thread(thread_id, comment_id, body, resolved=False, reply=None):
    parsed = parse_comment_body(body)
    comments = [{
        "id": "PRRC_root_" + str(comment_id),
        "databaseId": comment_id,
        "body": body,
        "createdAt": "2026-08-12T10:31:45Z",
        "url": "https://github.test/c{0}".format(comment_id),
        "author": {"login": "kim"},
        "replyTo": None,
    }]
    if reply:
        comments.append({
            "id": "PRRC_reply",
            "databaseId": comment_id + 1,
            "body": reply,
            "createdAt": "2026-08-12T10:40:00Z",
            "url": "https://github.test/reply",
            "author": {"login": "bob"},
            "replyTo": {"databaseId": comment_id},
        })
    return {
        "id": thread_id,
        "isResolved": resolved,
        "isOutdated": False,
        "path": (parsed or {"metadata": {
            "artifact_path": ".plannotate/example/demo/v0001.html"
        }})["metadata"]["artifact_path"],
        "line": 2,
        "subjectType": "FILE" if parsed and parsed["metadata"]["general"] else "LINE",
        "viewerCanReply": True,
        "viewerCanResolve": True,
        "viewerCanUnresolve": True,
        "comments": comments,
    }


class GitHubFormatTests(unittest.TestCase):
    def test_filters_protocol_threads_and_exports_latest_version_first(self):
        # Arrange
        block = build_comment_body("修改认证段。", metadata(2, index=3))
        general = build_comment_body("补充回滚策略。", metadata(1, general=True))
        threads = [
            github_thread("PRRT_block", 12, block, reply="收到。"),
            github_thread("PRRT_general", 2, general),
            github_thread("PRRT_other", 30, "ordinary code review"),
        ]

        # Act
        records = protocol_threads(threads, plan_key="example/demo")
        result = threads_to_markdown(
            "team/repo#7", "example/demo", records, latest=2
        )

        # Assert
        self.assertEqual(len(records), 2)
        self.assertIn("open 2 / total 2 | latest v0002", result)
        self.assertLess(result.index("## v0002 §架构"), result.index("## v0001 §（总体意见）"))
        self.assertIn("- [open] [c12] @kim 2026-08-12 10:31 · thread PRRT_block", result)
        self.assertIn("  > 块: 块引文", result)
        self.assertIn("  ↳ [c13] @bob 2026-08-12 10:40", result)
        self.assertNotIn("ordinary code review", result)

    def test_status_filter_and_empty_output_count_all_protocol_threads(self):
        body = build_comment_body("done", metadata(1))
        records = protocol_threads([
            github_thread("PRRT_done", 1, body, resolved=True)
        ])

        open_result = threads_to_markdown(
            "team/repo#7", "example/demo", records, latest=1, status="open"
        )
        resolved_result = threads_to_markdown(
            "team/repo#7", "example/demo", records, latest=1, status="resolved"
        )

        self.assertIn("no open comments (total 1", open_result)
        self.assertIn("resolved 1 / total 1", resolved_result)

    def test_manifest_binding_rejects_forged_artifact_identity(self):
        body = build_comment_body("forged", metadata(1))
        records = protocol_threads([github_thread("PRRT_bad", 1, body)])
        manifest = {
            "versions": [{
                "version": 1,
                "artifact_path": ".plannotate/example/demo/v0001.html",
                "artifact_sha256": "b" * 64,
            }],
        }

        bound = bind_manifest(records, manifest)

        self.assertEqual(bound[0]["protocol_error"],
                         "comment artifact identity is not in manifest")


if __name__ == "__main__":
    unittest.main()
