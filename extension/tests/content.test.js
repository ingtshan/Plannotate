"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { pullContext, viewerQuery } = require("../content.js");
const { normalizedTag } = require("../sandbox.js");

test("parses single-digit and nested pull request URLs", () => {
  assert.deepEqual(
    pullContext("https://github.com/owner/repository/pull/1"),
    { owner: "owner", repo: "repository", pull: "1" }
  );
  assert.deepEqual(
    pullContext("https://github.com/owner/repository/pull/42/files"),
    { owner: "owner", repo: "repository", pull: "42" }
  );
});

test("rejects non-pull-request and non-GitHub URLs", () => {
  assert.equal(pullContext("https://github.com/owner/repository/issues/1"), null);
  assert.equal(pullContext("https://example.com/owner/repository/pull/1"), null);
  assert.equal(pullContext("https://github.com/owner/repository/pull/0"), null);
});

test("builds an embedded viewer query without ambient page state", () => {
  assert.equal(
    viewerQuery({ owner: "octo cat", repo: "plan/review", pull: "7" }),
    "owner=octo+cat&repo=plan%2Freview&pull=7&embedded=1"
  );
});

test("normalizes HTML and SVG namespace tag names for anchor matching", () => {
  assert.equal(normalizedTag({ tagName: "svg" }), "SVG");
  assert.equal(normalizedTag({ tagName: "TR" }), "TR");
});
