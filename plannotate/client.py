"""Minimal stdlib GitHub REST and GraphQL client for plan review."""

import hashlib
import json
import os
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

from .artifact import (
    ArtifactError,
    MAX_ARTIFACT_BYTES,
    MAX_MANIFEST_BYTES,
    MAX_SIDECAR_BYTES,
    valid_plan_key,
    validate_anchor_document,
    validate_manifest as validate_artifact_manifest,
)


DEFAULT_API_URL = "https://api.github.com"
DEFAULT_GRAPHQL_URL = "https://api.github.com/graphql"
API_VERSION = "2022-11-28"
PULL_REF_PATTERN = re.compile(
    r"^([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)#([1-9]\d*)$"
)
PULL_URL_PATTERN = re.compile(
    r"^https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)"
    r"/pull/([1-9]\d*)(?:[/?#].*)?$"
)
THREADS_QUERY = """
query PlannotateThreads($owner:String!,$repo:String!,$number:Int!,$after:String) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(first:100,after:$after) {
        nodes {
          id isResolved isOutdated path line subjectType
          viewerCanReply viewerCanResolve viewerCanUnresolve
          comments(first:100) {
            nodes {
              id databaseId body createdAt url
              author { login }
              viewerCanDelete
              replyTo { databaseId }
            }
            pageInfo { hasNextPage }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
"""


class GitHubError(RuntimeError):
    """An explicit GitHub API, authentication, or protocol failure."""


@dataclass(frozen=True)
class PullRef:
    owner: str
    repo: str
    number: int

    @property
    def label(self):
        return "{0}/{1}#{2}".format(self.owner, self.repo, self.number)


def parse_pull_ref(value):
    if not isinstance(value, str):
        raise GitHubError("pull request must be owner/repo#number or a GitHub URL")
    match = PULL_REF_PATTERN.fullmatch(value) or PULL_URL_PATTERN.fullmatch(value)
    if match is None:
        raise GitHubError("invalid pull request reference: " + value)
    return PullRef(match.group(1), match.group(2), int(match.group(3)))


def resolve_token(environment=None):
    values = environment if environment is not None else os.environ
    for name in ("GITHUB_TOKEN", "GH_TOKEN"):
        token = values.get(name, "").strip()
        if token:
            return token
    try:
        result = subprocess.run(
            ["gh", "auth", "token"], check=False, capture_output=True,
            text=True, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        result = None
    if result is not None and result.returncode == 0 and result.stdout.strip():
        return result.stdout.strip()
    raise GitHubError(
        "GitHub token missing; set GITHUB_TOKEN/GH_TOKEN or run gh auth login"
    )


class UrlLibTransport:
    def request(self, method, url, headers, body=None):
        request = urllib.request.Request(url, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, dict(response.headers.items()), response.read()
        except urllib.error.HTTPError as error:
            return error.code, dict(error.headers.items()), error.read()
        except urllib.error.URLError as error:
            raise GitHubError("cannot reach GitHub: {0}".format(error.reason)) from error


class GitHubClient:
    def __init__(
        self, token, api_url=DEFAULT_API_URL, graphql_url=DEFAULT_GRAPHQL_URL,
        transport=None,
    ):
        if not isinstance(token, str) or not token:
            raise GitHubError("GitHub token must not be empty")
        self.token = token
        self.api_url = api_url.rstrip("/")
        self.graphql_url = graphql_url
        self.transport = transport or UrlLibTransport()

    def _headers(self, accept="application/vnd.github+json"):
        return {
            "Accept": accept,
            "Authorization": "Bearer " + self.token,
            "User-Agent": "plannotate/0.3.0",
            "X-GitHub-Api-Version": API_VERSION,
        }

    def _request(self, method, path, payload=None, accept=None):
        url = path if path.startswith("http") else self.api_url + path
        body = None
        headers = self._headers(accept or "application/vnd.github+json")
        if payload is not None:
            body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
        status, response_headers, raw = self.transport.request(
            method, url, headers, body
        )
        if status < 200 or status >= 300:
            raise GitHubError(_api_error(status, raw))
        return status, response_headers, raw

    def _json(self, method, path, payload=None):
        _status, _headers, raw = self._request(method, path, payload)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise GitHubError("GitHub returned invalid JSON") from error

    def graphql(self, query, variables):
        headers = self._headers()
        headers["Content-Type"] = "application/json"
        body = json.dumps(
            {"query": query, "variables": variables}, separators=(",", ":")
        ).encode("utf-8")
        status, _response_headers, raw = self.transport.request(
            "POST", self.graphql_url, headers, body
        )
        if status < 200 or status >= 300:
            raise GitHubError(_api_error(status, raw))
        try:
            response = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise GitHubError("GitHub GraphQL returned invalid JSON") from error
        if response.get("errors"):
            messages = "; ".join(
                item.get("message", "unknown GraphQL error")
                for item in response["errors"]
            )
            raise GitHubError("GitHub GraphQL: " + messages)
        return response.get("data")

    def get_pull(self, reference):
        return self._json("GET", _pull_path(reference))

    def list_pull_files(self, reference):
        items = []
        for page in range(1, 31):
            path = _pull_path(reference) + "/files?per_page=100&page={0}".format(page)
            batch = self._json("GET", path)
            if not isinstance(batch, list):
                raise GitHubError("GitHub pull files response is not an array")
            items.extend(batch)
            if len(batch) < 100:
                return items
        raise GitHubError("pull request exceeds the supported 3000-file API window")

    def get_content(self, reference, path, commit_sha):
        encoded_path = urllib.parse.quote(path, safe="/")
        query = urllib.parse.urlencode({"ref": commit_sha})
        endpoint = "/repos/{0}/{1}/contents/{2}?{3}".format(
            reference.owner, reference.repo, encoded_path, query
        )
        _status, _headers, raw = self._request(
            "GET", endpoint, accept="application/vnd.github.raw+json"
        )
        return raw

    def list_review_threads(self, reference):
        threads = []
        after = None
        seen_cursors = set()
        while True:
            variables = {
                "owner": reference.owner, "repo": reference.repo,
                "number": reference.number, "after": after,
            }
            data = self.graphql(THREADS_QUERY, variables)
            pull = ((data or {}).get("repository") or {}).get("pullRequest")
            if pull is None:
                raise GitHubError("pull request was not found or is inaccessible")
            connection = pull["reviewThreads"]
            for thread in connection["nodes"]:
                comments = thread["comments"]
                if comments["pageInfo"]["hasNextPage"]:
                    raise GitHubError("a review thread exceeds 100 comments")
                normalized = dict(thread)
                normalized["comments"] = comments["nodes"]
                threads.append(normalized)
            page_info = connection["pageInfo"]
            if not page_info["hasNextPage"]:
                return threads
            after = page_info["endCursor"]
            if not isinstance(after, str) or not after or after in seen_cursors:
                raise GitHubError("GitHub review thread pagination cursor is invalid")
            seen_cursors.add(after)

    def create_review_comment(
        self, reference, commit_sha, path, body, line=None, file_level=False,
    ):
        body = _comment_text(body, 65536)
        payload = {"body": body, "commit_id": commit_sha, "path": path}
        if file_level:
            payload["subject_type"] = "file"
        else:
            if not isinstance(line, int) or isinstance(line, bool) or line < 1:
                raise GitHubError("line comment requires a positive line")
            payload.update({"line": line, "side": "RIGHT"})
        return self._json("POST", _pull_path(reference) + "/comments", payload)

    def reply_thread(self, thread_id, body):
        _node_id(thread_id, "thread_id")
        body = _comment_text(body, 4000)
        query = """
mutation Reply($thread:ID!,$body:String!) {
  addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}) {
    comment { id databaseId body createdAt url author { login } }
  }
}
"""
        return self.graphql(query, {"thread": thread_id, "body": body})

    def resolve_thread(self, thread_id):
        _node_id(thread_id, "thread_id")
        query = """
mutation Resolve($thread:ID!) {
  resolveReviewThread(input:{threadId:$thread}) { thread { id isResolved } }
}
"""
        return self.graphql(query, {"thread": thread_id})

    def reopen_thread(self, thread_id):
        _node_id(thread_id, "thread_id")
        query = """
mutation Reopen($thread:ID!) {
  unresolveReviewThread(input:{threadId:$thread}) { thread { id isResolved } }
}
"""
        return self.graphql(query, {"thread": thread_id})

    def delete_comment(self, comment_id):
        _node_id(comment_id, "comment_id")
        query = """
mutation Delete($comment:ID!) {
  deletePullRequestReviewComment(input:{id:$comment}) { clientMutationId }
}
"""
        return self.graphql(query, {"comment": comment_id})


def _api_error(status, raw):
    try:
        payload = json.loads(raw.decode("utf-8"))
        message = payload.get("message", raw.decode("utf-8", "replace"))
        details = payload.get("errors")
    except (UnicodeDecodeError, json.JSONDecodeError):
        message = raw.decode("utf-8", "replace")
        details = None
    if isinstance(details, list) and any(
        "one pending review per pull request" in str(item.get("message", "")).lower()
        for item in details if isinstance(item, dict)
    ):
        return (
            "GitHub API HTTP {0}: an existing pending review blocks new comments; "
            "submit or dismiss the existing pending review, then retry"
        ).format(status)
    return "GitHub API HTTP {0}: {1}".format(status, message)


def _node_id(value, label):
    if not isinstance(value, str) or not value.strip() or len(value) > 200:
        raise GitHubError("{0} must be a GitHub node id".format(label))
    return value


def _comment_text(value, maximum):
    if not isinstance(value, str) or not value.strip():
        raise GitHubError("comment body must not be empty")
    if len(value) > maximum:
        raise GitHubError(
            "comment body must be at most {0} characters".format(maximum)
        )
    return value.strip()


def _pull_path(reference):
    return "/repos/{0}/{1}/pulls/{2}".format(
        reference.owner, reference.repo, reference.number
    )


def manifest_path(plan_key):
    if not valid_plan_key(plan_key):
        raise GitHubError("plan_key must contain 2-5 safe path segments")
    return ".plannotate/{0}/manifest.json".format(plan_key)


def discover_plan_keys(files):
    prefix = ".plannotate/"
    suffix = "/manifest.json"
    result = []
    for item in files:
        path = item.get("filename", "")
        if path.startswith(prefix) and path.endswith(suffix):
            key = path[len(prefix):-len(suffix)]
            if valid_plan_key(key):
                result.append(key)
    return sorted(set(result))


def load_plan_bundle(client, reference, plan_key, version=None):
    """Load and cryptographically verify a plan version at the PR head SHA."""
    pull = client.get_pull(reference)
    head_sha = ((pull.get("head") or {}).get("sha"))
    if not isinstance(head_sha, str) or not head_sha:
        raise GitHubError("pull request response is missing head.sha")
    raw_manifest = client.get_content(
        reference, manifest_path(plan_key), head_sha
    )
    _limit(raw_manifest, MAX_MANIFEST_BYTES, "manifest")
    manifest = _decode_json(raw_manifest, "manifest")
    _validate_manifest(manifest, plan_key)
    if (version is not None
            and (not isinstance(version, int) or isinstance(version, bool) or version < 1)):
        raise GitHubError("plan version must be a positive integer")
    selected_version = version or manifest["latest"]
    record = next(
        (item for item in manifest["versions"]
         if item.get("version") == selected_version), None
    )
    if record is None:
        raise GitHubError("plan version does not exist: {0}".format(selected_version))
    anchors_raw = client.get_content(reference, record["anchors_path"], head_sha)
    _limit(anchors_raw, MAX_SIDECAR_BYTES, "anchor sidecar")
    anchors_digest = hashlib.sha256(anchors_raw).hexdigest()
    if anchors_digest != record.get("anchors_sha256"):
        raise GitHubError("anchor sidecar SHA-256 does not match its manifest")
    anchors = _decode_json(anchors_raw, "anchor sidecar")
    artifact = client.get_content(reference, record["artifact_path"], head_sha)
    _limit(artifact, MAX_ARTIFACT_BYTES, "artifact")
    digest = hashlib.sha256(artifact).hexdigest()
    if digest != record.get("artifact_sha256"):
        raise GitHubError("artifact SHA-256 does not match its manifest")
    if anchors.get("artifact_sha256") != digest:
        raise GitHubError("anchor sidecar does not match the artifact")
    try:
        validate_anchor_document(anchors, plan_key, record)
    except ArtifactError as error:
        raise GitHubError(str(error)) from error
    return {
        "pull": pull, "head_sha": head_sha, "manifest": manifest,
        "version": record, "anchors": anchors, "artifact": artifact,
    }


def _decode_json(raw, label):
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GitHubError("{0} is not valid UTF-8 JSON".format(label)) from error


def _limit(raw, maximum, label):
    if not isinstance(raw, bytes):
        raise GitHubError("{0} response is not bytes".format(label))
    if len(raw) > maximum:
        raise GitHubError("{0} exceeds the size limit".format(label))


def _validate_manifest(manifest, plan_key):
    try:
        validate_artifact_manifest(manifest, plan_key)
    except ArtifactError as error:
        raise GitHubError(str(error)) from error
    if manifest["latest"] < 1:
        raise GitHubError("manifest does not contain a plan version")
