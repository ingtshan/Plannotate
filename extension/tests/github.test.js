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
    subject_type: "line", line: 3, side: "RIGHT",
  });
  assert.equal(JSON.parse(calls[1].options.body).subject_type, "file");
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
