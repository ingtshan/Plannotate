"""Tests for GitHub REST/GraphQL transport and PR artifact loading."""

import hashlib
import json
import unittest

from plannotate.client import (
    GitHubClient,
    GitHubError,
    PullRef,
    discover_plan_keys,
    load_plan_bundle,
    parse_pull_ref,
)


class RecordingTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, method, url, headers, body=None):
        self.calls.append((method, url, headers, body))
        return self.responses.pop(0)


class BundleClient:
    def __init__(self, manifest, anchors, artifact):
        self.manifest = manifest
        self.anchors = anchors
        self.artifact = artifact
        self.paths = []

    def get_pull(self, _reference):
        return {"head": {"sha": "head-sha"}}

    def get_content(self, _reference, path, commit_sha):
        self.paths.append((path, commit_sha))
        if path.endswith("manifest.json"):
            return json.dumps(self.manifest).encode("utf-8")
        if path.endswith("anchors.json"):
            return json.dumps(self.anchors).encode("utf-8")
        return self.artifact


class GitHubClientTests(unittest.TestCase):
    def test_parses_compact_and_url_pull_references(self):
        self.assertEqual(
            parse_pull_ref("openai/codex#42"), PullRef("openai", "codex", 42)
        )
        self.assertEqual(
            parse_pull_ref("https://github.com/openai/codex/pull/42/files"),
            PullRef("openai", "codex", 42),
        )
        with self.assertRaises(GitHubError):
            parse_pull_ref("codex#42")

    def test_discovers_only_namespaced_plan_manifests(self):
        files = [
            {"filename": ".plannotate/example/classroom/manifest.json"},
            {"filename": ".plannotate/demo/manifest.json"},
            {"filename": ".plannotate/example/classroom/v0001.html"},
            {"filename": "docs/manifest.json"},
        ]
        self.assertEqual(
            discover_plan_keys(files), ["example/classroom"]
        )

    def test_create_review_comment_uses_exact_line_or_file_subject(self):
        # Arrange
        responses = [
            (201, {}, b'{"id":10,"html_url":"https://github.test/c10"}'),
            (201, {}, b'{"id":11,"html_url":"https://github.test/c11"}'),
        ]
        transport = RecordingTransport(responses)
        client = GitHubClient(
            "token", api_url="https://api.github.test",
            graphql_url="https://api.github.test/graphql", transport=transport,
        )
        reference = PullRef("team", "repo", 7)

        # Act
        client.create_review_comment(
            reference, "head", ".plannotate/a/b/v0001.html", "block", line=9
        )
        client.create_review_comment(
            reference, "head", ".plannotate/a/b/v0001.html", "general",
            file_level=True,
        )

        # Assert
        line_payload = json.loads(transport.calls[0][3].decode("utf-8"))
        file_payload = json.loads(transport.calls[1][3].decode("utf-8"))
        self.assertEqual(line_payload["line"], 9)
        self.assertEqual(line_payload["side"], "RIGHT")
        self.assertNotIn("subject_type", line_payload)
        self.assertEqual(file_payload["subject_type"], "file")
        self.assertNotIn("line", file_payload)

    def test_load_bundle_pins_head_and_verifies_both_sha_links(self):
        # Arrange
        artifact = b"<h1>Plan</h1>"
        digest = hashlib.sha256(artifact).hexdigest()
        record = {
            "version": 1,
            "artifact_path": ".plannotate/example/demo/v0001.html",
            "anchors_path": ".plannotate/example/demo/v0001.anchors.json",
            "artifact_sha256": digest,
        }
        manifest = {
            "schema": "plannotate.github/v1",
            "plan_key": "example/demo",
            "latest": 1,
            "versions": [record],
        }
        anchors = {"artifact_sha256": digest, "anchors": []}
        anchors.update({
            "schema": "plannotate.github/v1",
            "plan_key": "example/demo",
            "version": 1,
            "artifact_path": record["artifact_path"],
        })
        anchors_raw = json.dumps(anchors).encode("utf-8")
        record["anchors_sha256"] = hashlib.sha256(anchors_raw).hexdigest()
        record["created_at"] = "2026-08-12T10:00:00-07:00"
        client = BundleClient(manifest, anchors, artifact)

        # Act
        bundle = load_plan_bundle(
            client, PullRef("team", "repo", 1), "example/demo"
        )

        # Assert
        self.assertEqual(bundle["head_sha"], "head-sha")
        self.assertEqual(bundle["artifact"], artifact)
        self.assertTrue(all(sha == "head-sha" for _path, sha in client.paths))

        # A changed artifact must fail closed.
        client.artifact = b"tampered"
        with self.assertRaises(GitHubError):
            load_plan_bundle(client, PullRef("team", "repo", 1), "example/demo")

    def test_load_bundle_rejects_tampered_anchor_sidecar(self):
        artifact = b"<p>Plan</p>"
        digest = hashlib.sha256(artifact).hexdigest()
        original_anchors = {
            "schema": "plannotate.github/v1", "plan_key": "example/demo",
            "version": 1,
            "artifact_path": ".plannotate/example/demo/v0001.html",
            "artifact_sha256": digest, "anchors": [],
        }
        anchors_digest = hashlib.sha256(
            json.dumps(original_anchors).encode("utf-8")
        ).hexdigest()
        record = {
            "version": 1,
            "artifact_path": ".plannotate/example/demo/v0001.html",
            "anchors_path": ".plannotate/example/demo/v0001.anchors.json",
            "artifact_sha256": digest,
            "anchors_sha256": anchors_digest,
            "created_at": "2026-08-12T10:00:00-07:00",
        }
        manifest = {
            "schema": "plannotate.github/v1", "plan_key": "example/demo",
            "latest": 1, "versions": [record],
        }
        tampered = dict(original_anchors)
        tampered["anchors"] = [{"index": 0}]

        with self.assertRaisesRegex(GitHubError, "SHA-256"):
            load_plan_bundle(
                BundleClient(manifest, tampered, artifact),
                PullRef("team", "repo", 1), "example/demo",
            )

    def test_graphql_surfaces_errors_instead_of_returning_partial_data(self):
        transport = RecordingTransport([
            (200, {}, b'{"errors":[{"message":"denied"}],"data":null}')
        ])
        client = GitHubClient("token", transport=transport)
        with self.assertRaisesRegex(GitHubError, "denied"):
            client.graphql("query { viewer { login } }", {})

    def test_pending_review_conflict_has_actionable_guidance(self):
        payload = json.dumps({
            "message": "Validation Failed",
            "errors": [{
                "resource": "PullRequestReview", "code": "custom",
                "field": "user_id",
                "message": "user_id can only have one pending review per pull request",
            }],
        }).encode("utf-8")
        client = GitHubClient(
            "token", transport=RecordingTransport([(422, {}, payload)])
        )
        with self.assertRaisesRegex(
            GitHubError, "submit or dismiss the existing pending review"
        ):
            client.create_review_comment(
                PullRef("team", "repo", 7), "head",
                ".plannotate/a/b/v0001.html", "body", line=3,
            )


if __name__ == "__main__":
    unittest.main()
