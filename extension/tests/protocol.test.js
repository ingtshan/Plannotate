"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const protocol = require("../protocol.js");

const EXPECTED = "eyJhbmNob3JfaWQiOiJhcmNoaXRlY3R1cmUtYXV0aCIsImFydGlmYWN0X3BhdGgiOiIucGxhbm5vdGF0ZS9leGFtcGxlL2RlbW8vdjAwMDIuaHRtbCIsImFydGlmYWN0X3NoYTI1NiI6ImFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEiLCJibG9ja19oYXNoIjoiZGVhZGJlZWYiLCJibG9ja19pbmRleCI6NywiZ2VuZXJhbCI6ZmFsc2UsImhlYWRpbmdfcGF0aCI6IuaetuaehCA-IOadg-mZkCIsImxpbmUiOjQyLCJwbGFuX2tleSI6ImV4YW1wbGUvZGVtbyIsInF1b3RlIjoi6K6k6K-B5LiO5p2D6ZmQIiwic2NoZW1hIjoicGxhbm5vdGF0ZS5naXRodWIvdjEiLCJzZWxlY3Rpb24iOnsiZW5kIjozLCJzdGFydCI6MSwidGV4dCI6IuivgeS4jiJ9LCJ2ZXJzaW9uIjoyfQ";

function metadata(general) {
  return {
    schema: "plannotate.github/v1",
    plan_key: "example/demo",
    version: 2,
    artifact_path: ".plannotate/example/demo/v0002.html",
    artifact_sha256: "a".repeat(64),
    general: Boolean(general),
    anchor_id: general ? null : "architecture-auth",
    line: general ? null : 42,
    block_index: general ? null : 7,
    block_hash: general ? null : "deadbeef",
    quote: general ? "" : "认证与权限",
    heading_path: general ? "" : "架构 > 权限",
    selection: general ? null : { start: 1, end: 3, text: "证与" },
  };
}

test("uses the same canonical metadata vector as Python", () => {
  assert.equal(protocol.encodeMetadata(metadata(false)), EXPECTED);
  assert.deepEqual(protocol.decodeMetadata(EXPECTED), metadata(false));
});

test("builds readable bodies and restores general metadata", () => {
  const body = protocol.buildCommentBody("补充回滚策略。", metadata(true));
  const parsed = protocol.parseCommentBody(body);
  assert.match(body, /> 总体意见/);
  assert.equal(parsed.body, "补充回滚策略。");
  assert.deepEqual(parsed.metadata, metadata(true));
});

test("rejects mixed general, unknown, and noncanonical metadata", () => {
  const mixed = metadata(true);
  mixed.anchor_id = "unexpected";
  const unknown = Object.assign(metadata(false), { surprise: true });
  const path = Object.assign(metadata(false), { artifact_path: "docs/plan.html" });
  [mixed, unknown, path].forEach((value) => {
    assert.throws(() => protocol.encodeMetadata(value));
  });
  assert.throws(() => protocol.parseCommentBody(
    "<!-- plannotate:body -->\nx\n<!-- plannotate:v1:%%% -->"
  ));
});

test("keeps reserved markers out of visible quotes and user bodies", () => {
  const value = metadata(false);
  value.quote = "literal <!-- plannotate:body --> marker";
  const result = protocol.buildCommentBody("safe", value);
  assert.equal(protocol.parseCommentBody(result).body, "safe");
  assert.throws(() => protocol.buildCommentBody(
    "bad " + protocol.BODY_MARKER, metadata(false)
  ));
});
