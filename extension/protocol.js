(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.PlannotateProtocol = value;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SCHEMA = "plannotate.github/v1";
  const BODY_MARKER = "<!-- plannotate:body -->";
  const METADATA_PATTERN = /<!-- plannotate:v1:([A-Za-z0-9_-]+) -->\s*$/;
  const PLAN_KEY_PATTERN = /^[A-Za-z0-9._\-一-鿿]+(?:\/[A-Za-z0-9._\-一-鿿]+){1,4}$/;
  const ANCHOR_ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;
  const BLOCK_HASH_PATTERN = /^[0-9a-f]{8}$/;
  const SHA256_PATTERN = /^[0-9a-f]{64}$/;
  const METADATA_FIELDS = new Set([
    "schema", "plan_key", "version", "artifact_path", "artifact_sha256",
    "general", "anchor_id", "line", "block_index", "block_hash", "quote",
    "heading_path", "selection",
  ]);

  function fail(message) {
    throw new Error(message);
  }

  function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== "object") return value;
    const result = {};
    Object.keys(value).sort().forEach((key) => {
      result[key] = stableValue(value[key]);
    });
    return result;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    bytes.forEach((value) => { binary += String.fromCharCode(value); });
    if (typeof btoa === "function") return btoa(binary);
    return Buffer.from(bytes).toString("base64");
  }

  function base64ToBytes(value) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const binary = typeof atob === "function"
      ? atob(padded) : Buffer.from(padded, "base64").toString("binary");
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function encodeMetadata(metadata) {
    const normalized = validateMetadata(metadata);
    const json = JSON.stringify(stableValue(normalized));
    return bytesToBase64(new TextEncoder().encode(json))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function decodeMetadata(encoded) {
    let value;
    try {
      value = JSON.parse(new TextDecoder().decode(base64ToBytes(encoded)));
    } catch (_error) {
      return fail("comment metadata is invalid");
    }
    return validateMetadata(value);
  }

  function codePointLength(value) {
    return Array.from(value).length;
  }

  function validPlanKey(value) {
    if (typeof value !== "string" || !PLAN_KEY_PATTERN.test(value)) return false;
    return value.split("/").every((segment) => segment !== "." && segment !== "..");
  }

  function artifactPath(planKey, version) {
    return ".plannotate/" + planKey + "/v" + String(version).padStart(4, "0") + ".html";
  }

  function validateSelection(selection) {
    if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
      return fail("selection must be an object or null");
    }
    const validStart = Number.isInteger(selection.start) && selection.start >= 0;
    const validEnd = Number.isInteger(selection.end) && selection.end > selection.start;
    if (!validStart || !validEnd) return fail("selection offsets are invalid");
    if (typeof selection.text !== "string"
        || codePointLength(selection.text) < 1 || codePointLength(selection.text) > 500) {
      return fail("selection text must be 1-500 characters");
    }
    const unknown = Object.keys(selection).filter(
      (name) => !["start", "end", "text"].includes(name)
    );
    if (unknown.length) return fail("selection has unknown fields");
    return { start: selection.start, end: selection.end, text: selection.text };
  }

  function commonMetadata(metadata) {
    const unknown = Object.keys(metadata).filter((name) => !METADATA_FIELDS.has(name));
    if (unknown.length) return fail("metadata has unknown fields: " + unknown.sort().join(", "));
    if (metadata.schema !== SCHEMA) return fail("unsupported metadata schema");
    if (!validPlanKey(metadata.plan_key)) return fail("metadata plan_key is invalid");
    if (!Number.isInteger(metadata.version) || metadata.version < 1) {
      return fail("metadata version must be positive");
    }
    if (metadata.artifact_path !== artifactPath(metadata.plan_key, metadata.version)) {
      return fail("metadata artifact_path is not canonical");
    }
    if (typeof metadata.artifact_sha256 !== "string"
        || !SHA256_PATTERN.test(metadata.artifact_sha256)) {
      return fail("metadata artifact_sha256 is invalid");
    }
    if (typeof metadata.general !== "boolean") return fail("metadata general must be boolean");
    return {
      schema: SCHEMA,
      plan_key: metadata.plan_key,
      version: metadata.version,
      artifact_path: metadata.artifact_path,
      artifact_sha256: metadata.artifact_sha256,
      general: metadata.general,
    };
  }

  function generalMetadata(metadata, value) {
    const empty = {
      anchor_id: null, line: null, block_index: null, block_hash: null,
      quote: "", heading_path: "", selection: null,
    };
    Object.keys(empty).forEach((name) => {
      const actual = metadata[name] === undefined ? empty[name] : metadata[name];
      if (actual !== empty[name]) fail("general metadata " + name + " must be empty");
    });
    return Object.assign(value, empty);
  }

  function blockMetadata(metadata, value) {
    if (typeof metadata.anchor_id !== "string" || !ANCHOR_ID_PATTERN.test(metadata.anchor_id)) {
      return fail("metadata anchor_id is invalid");
    }
    if (!Number.isInteger(metadata.line) || metadata.line < 1) {
      return fail("metadata line must be positive");
    }
    if (!Number.isInteger(metadata.block_index) || metadata.block_index < 0) {
      return fail("metadata block_index must be non-negative");
    }
    if (typeof metadata.block_hash !== "string" || !BLOCK_HASH_PATTERN.test(metadata.block_hash)) {
      return fail("metadata block_hash is invalid");
    }
    if (typeof metadata.quote !== "string" || codePointLength(metadata.quote) > 300) {
      return fail("metadata quote must be at most 300 characters");
    }
    if (typeof metadata.heading_path !== "string" || codePointLength(metadata.heading_path) > 200) {
      return fail("metadata heading_path must be at most 200 characters");
    }
    const selection = metadata.selection === null || metadata.selection === undefined
      ? null : validateSelection(metadata.selection);
    return Object.assign(value, {
      anchor_id: metadata.anchor_id,
      line: metadata.line,
      block_index: metadata.block_index,
      block_hash: metadata.block_hash,
      quote: metadata.quote,
      heading_path: metadata.heading_path,
      selection,
    });
  }

  function validateMetadata(metadata) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return fail("metadata must be an object");
    }
    const value = commonMetadata(metadata);
    return metadata.general
      ? generalMetadata(metadata, value) : blockMetadata(metadata, value);
  }

  function headerLines(metadata) {
    const label = "> **Plannotate · `" + metadata.plan_key + "` · v"
      + String(metadata.version).padStart(4, "0") + "**";
    if (metadata.general) return [label, "> 总体意见"];
    const quote = visibleText((metadata.quote || "").trim().replace(/\s+/g, " "));
    const lines = [label, "> 块：" + quote];
    if (metadata.selection) {
      const selected = visibleText(metadata.selection.text.trim().replace(/\s+/g, " "));
      lines.push("> 高亮：“" + selected + "”");
    }
    return lines;
  }

  function visibleText(value) {
    return value.replace(/<!--/g, "<\u200b!--").replace(/-->/g, "--\u200b>");
  }

  function buildCommentBody(body, metadata) {
    if (typeof body !== "string" || !body.trim()) return fail("comment body is empty");
    if (codePointLength(body) > 4000) return fail("comment body exceeds 4000 characters");
    if (body.includes(BODY_MARKER) || body.includes("<!-- plannotate:v1:")) {
      return fail("comment body contains a reserved protocol marker");
    }
    const normalized = validateMetadata(metadata);
    const marker = "<!-- plannotate:v1:" + encodeMetadata(normalized) + " -->";
    return headerLines(normalized).concat([
      "", BODY_MARKER, body.trim(), "", marker,
    ]).join("\n");
  }

  function parseCommentBody(value) {
    if (typeof value !== "string") return null;
    const match = value.match(METADATA_PATTERN);
    if (!match) {
      if (value.includes("<!-- plannotate:v1:")) return fail("comment metadata marker is malformed");
      return null;
    }
    const metadata = decodeMetadata(match[1]);
    const prefix = value.slice(0, match.index).trimEnd();
    if (prefix.split(BODY_MARKER).length !== 2) return fail("comment body marker is missing");
    const markerIndex = prefix.indexOf(BODY_MARKER);
    const body = prefix.slice(markerIndex + BODY_MARKER.length).trim();
    if (!body) return fail("comment body is empty");
    if (codePointLength(body) > 4000) return fail("comment body exceeds 4000 characters");
    return { metadata, body };
  }

  return Object.freeze({
    BODY_MARKER,
    SCHEMA,
    buildCommentBody,
    decodeMetadata,
    encodeMetadata,
    parseCommentBody,
    validateMetadata,
  });
}));
