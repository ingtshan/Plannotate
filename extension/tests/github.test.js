"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const github = require("../github.js");
const protocol = require("../protocol.js");

function bytes(value) {
  return new TextEncoder().encode(value).buffer;
}

function bundleFixture() {
  const html = "<h1 data-plan-anchor=\"title\">Plan</h1>\n";
  const artifactSha = crypto.createHash("sha256").update(html).digest("hex");
  const version = {
    version: 1,
    artifact_path: ".plannotate/example/demo/v0001.html",
    anchors_path: ".plannotate/example/demo/v0001.anchors.json",
    artifact_sha256: artifactSha,
    created_at: "2026-08-12T10:00:00-07:00",
  };
  const anchors = {
    schema: "plannotate.github/v1",
    plan_key: "example/demo",
    version: 1,
    artifact_path: version.artifact_path,
    artifact_sha256: artifactSha,
    anchors: [{
      anchor_id: "title", legacy_block_id: "b0-7ce4fd54", index: 0,
      line: 1, tag: "h1", block_hash: "7ce4fd54", quote: "Plan", heading_path: "",
    }],
  };
  const anchorText = JSON.stringify(anchors);
  version.anchors_sha256 = crypto.createHash("sha256").update(anchorText).digest("hex");
  const manifest = {
    schema: "plannotate.github/v1", plan_key: "example/demo",
    latest: 1, versions: [version],
  };
  return { html, anchorText, manifest, version };
}

test("parses PR URLs and discovers only namespaced manifests", () => {
  assert.deepEqual(
    github.parsePullUrl("https://github.com/team/repo/pull/9/files"),
    { owner: "team", repo: "repo", number: 9 }
  );
  assert.deepEqual(github.discoverPlanKeys([
    { filename: ".plannotate/example/demo/manifest.json" },
    { filename: ".plannotate/flat/manifest.json" },
  ]), ["example/demo"]);
});

test("builds a least-privilege fine-grained token template", () => {
  const url = new URL(github.tokenTemplateUrl("team-owner"));
  assert.equal(url.origin + url.pathname,
    "https://github.com/settings/personal-access-tokens/new");
  assert.equal(url.searchParams.get("target_name"), "team-owner");
  assert.equal(url.searchParams.get("contents"), "read");
  assert.equal(url.searchParams.get("pull_requests"), "write");
  assert.equal(url.searchParams.get("expires_in"), "90");
  assert.equal(new URL(github.tokenTemplateUrl("not/an/owner")).searchParams.has(
    "target_name"
  ), false);
});

test("turns PAT denial into repository-specific recovery steps", () => {
  const error = new Error("Resource not accessible by personal access token");
  error.status = 403;
  const help = github.permissionHelp(
    error, { owner: "team", repo: "plans", number: 7 }
  );
  assert.equal(help.title, "当前 token 没有 PR review 评论权限");
  assert.match(help.summary, /team\/plans/);
  assert.ok(help.steps.some((item) => /Pull requests.*Read and write/.test(item)));
  assert.equal(new URL(help.tokenUrl).searchParams.get("target_name"), "team");
  assert.equal(github.permissionHelp(new Error("network failed"), {}), null);
});

test("classifies token families without exposing token contents", () => {
  assert.equal(github.tokenKind("github_pat_example"), "fine-grained");
  assert.equal(github.tokenKind("ghp_example"), "classic-or-oauth");
  assert.equal(github.tokenKind("opaque-token"), "unknown");
  assert.equal(new github.GitHubApi("github_pat_example", {
    fetchImpl: async () => new Response(),
  }).tokenKind, "fine-grained");
});

test("preserves HTTP status and accepted permissions on GitHub errors", async () => {
  const api = new github.GitHubApi("token", {
    fetchImpl: async () => new Response(JSON.stringify({
      message: "Resource not accessible by personal access token",
    }), {
      status: 403,
      headers: { "x-accepted-github-permissions": "pull_requests=write" },
    }),
  });
  await assert.rejects(api.getAuthenticatedUser(), (error) => {
    assert.equal(error.name, "GitHubApiError");
    assert.equal(error.status, 403);
    assert.equal(error.acceptedPermissions, "pull_requests=write");
    return true;
  });
});

test("turns an existing pending review conflict into actionable recovery", async () => {
  const details = [{
    resource: "PullRequestReview", code: "custom", field: "user_id",
    message: "user_id can only have one pending review per pull request",
  }];
  const api = new github.GitHubApi("github_pat_example", {
    fetchImpl: async () => new Response(JSON.stringify({
      message: "Validation Failed", errors: details,
    }), {
      status: 422, headers: { "content-type": "application/json" },
    }),
  });
  const ref = { owner: "team", repo: "plans", number: 7 };
  await assert.rejects(api.createReviewComment(ref, {
    body: "draft", commitSha: "head", path: ".plannotate/a/b/v0001.html",
    line: 3, fileLevel: false,
  }), (error) => {
    assert.deepEqual(error.apiErrors, details);
    const help = github.errorHelp(error, ref);
    assert.equal(help.title, "GitHub 已有未提交的 review");
    assert.equal(help.pendingReview, true);
    assert.match(help.summary, /评论草稿已保留/);
    return true;
  });
});

test("finds, submits, and deletes the viewer's pending review", async () => {
  const calls = [];
  const responses = [
    [{ id: 77, state: "COMMENTED" }, { id: 99, state: "PENDING" }],
    [{ id: 1 }, { id: 2 }],
    { id: 99, state: "COMMENTED" },
  ];
  const api = new github.GitHubApi("github_pat_example", {
    apiUrl: "https://api.github.test",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const body = responses.shift();
      return new Response(body === undefined ? null : JSON.stringify(body), {
        status: body === undefined ? 204 : 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const ref = { owner: "team", repo: "plans", number: 7 };
  const pending = await api.findPendingReview(ref);
  assert.deepEqual(pending, { id: 99, commentCount: 2 });
  assert.match(calls[0].url, /\/repos\/team\/plans\/pulls\/7\/reviews\?per_page=100/);
  assert.match(calls[1].url, /\/reviews\/99\/comments\?per_page=100$/);
  await api.submitPendingReview(ref, pending.id);
  assert.equal(
    calls[2].url,
    "https://api.github.test/repos/team/plans/pulls/7/reviews/99/events"
  );
  assert.deepEqual(JSON.parse(calls[2].options.body), { event: "COMMENT" });
  await api.deletePendingReview(ref, pending.id);
  assert.equal(calls[3].options.method, "DELETE");
  assert.equal(
    calls[3].url, "https://api.github.test/repos/team/plans/pulls/7/reviews/99"
  );
  await assert.rejects(api.submitPendingReview(ref, "99"), /review id/);
  await assert.rejects(api.deletePendingReview(ref, 0), /review id/);
});

test("reports no pending review when the viewer has none", async () => {
  const api = new github.GitHubApi("token", {
    apiUrl: "https://api.github.test",
    fetchImpl: async () => new Response(
      JSON.stringify([{ id: 5, state: "COMMENTED" }]),
      { status: 200, headers: { "content-type": "application/json" } }
    ),
  });
  assert.equal(
    await api.findPendingReview({ owner: "a", repo: "b", number: 1 }), null
  );
});

test("loads a head-pinned bundle and verifies artifact plus sidecar", async () => {
  const fixture = bundleFixture();
  const paths = [];
  const api = {
    async getPull() { return { head: { sha: "head-sha" } }; },
    async getContentBytes(_ref, path, sha) {
      paths.push([path, sha]);
      if (path.endsWith("manifest.json")) return bytes(JSON.stringify(fixture.manifest));
      return bytes(path.endsWith("anchors.json") ? fixture.anchorText : fixture.html);
    },
  };
  const result = await github.loadBundle(
    api, { owner: "team", repo: "repo", number: 9 }, "example/demo"
  );
  assert.equal(result.headSha, "head-sha");
  assert.equal(result.html, fixture.html);
  assert.ok(paths.every((item) => item[1] === "head-sha"));

  fixture.anchorText += " ";
  await assert.rejects(
    github.loadBundle(api, { owner: "team", repo: "repo", number: 9 }, "example/demo"),
    /anchor sidecar SHA-256/
  );
});

test("creates exact GitHub line and file review payloads", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ id: calls.length }), {
      status: 201, headers: { "content-type": "application/json" },
    });
  };
  const api = new github.GitHubApi("token", {
    apiUrl: "https://api.github.test", fetchImpl,
  });
  const ref = { owner: "team", repo: "repo", number: 9 };
  await api.createReviewComment(ref, {
    body: "line", commitSha: "head", path: ".plannotate/a/b/v0001.html",
    line: 3, fileLevel: false,
  });
  await api.createReviewComment(ref, {
    body: "general", commitSha: "head", path: ".plannotate/a/b/v0001.html",
    fileLevel: true,
  });
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    body: "line", commit_id: "head", path: ".plannotate/a/b/v0001.html",
    line: 3, side: "RIGHT",
  });
  assert.equal(JSON.parse(calls[1].options.body).subject_type, "file");
});

test("deletes a review comment through the fine-grained REST endpoint", async () => {
  const calls = [];
  const api = new github.GitHubApi("github_pat_example", {
    apiUrl: "https://api.github.test",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(null, { status: 204 });
    },
  });
  await api.deleteComment({ owner: "team", repo: "repo", number: 9 }, 123);
  assert.equal(calls[0].url,
    "https://api.github.test/repos/team/repo/pulls/comments/123");
  assert.equal(calls[0].options.method, "DELETE");
  await assert.rejects(
    api.deleteComment({ owner: "team", repo: "repo", number: 9 }, "PRRC_1"),
    /comment id/
  );
});

test("normalizes only matching path-bound protocol threads", () => {
  const fixture = bundleFixture();
  const metadata = {
    schema: protocol.SCHEMA, plan_key: "example/demo", version: 1,
    artifact_path: fixture.version.artifact_path,
    artifact_sha256: fixture.version.artifact_sha256, general: true,
    anchor_id: null, line: null, block_index: null, block_hash: null,
    quote: "", heading_path: "", selection: null,
  };
  const root = {
    id: "PRRC_1", databaseId: 1,
    body: protocol.buildCommentBody("总体意见", metadata), replyTo: null,
    author: { login: "kim" }, viewerCanDelete: true,
  };
  const thread = {
    id: "PRRT_1", path: fixture.version.artifact_path, comments: [root],
    viewerCanReply: true, viewerCanResolve: true, viewerCanUnresolve: false,
  };
  const records = github.normalizeThreads(
    [thread], "example/demo", { versions: [fixture.version] }
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].permissions.delete, true);

  thread.path = "wrong.html";
  assert.throws(
    () => github.normalizeThreads([thread], "example/demo", { versions: [fixture.version] }),
    /path/
  );
});
