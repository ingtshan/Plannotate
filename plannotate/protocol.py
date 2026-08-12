"""Shared comment-body protocol for GitHub plan review threads."""

import base64
import json
import re


SCHEMA = "plannotate.github/v1"
BODY_MARKER = "<!-- plannotate:body -->"
METADATA_PATTERN = re.compile(
    r"<!-- plannotate:v1:([A-Za-z0-9_-]+) -->\s*$"
)
PLAN_KEY_PATTERN = re.compile(
    r"^[A-Za-z0-9._\-\u4e00-\u9fff]+"
    r"(?:/[A-Za-z0-9._\-\u4e00-\u9fff]+){1,4}$"
)
ANCHOR_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,100}$")
BLOCK_HASH_PATTERN = re.compile(r"^[0-9a-f]{8}$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
METADATA_FIELDS = frozenset((
    "schema", "plan_key", "version", "artifact_path", "artifact_sha256",
    "general", "anchor_id", "line", "block_index", "block_hash", "quote",
    "heading_path", "selection",
))
MAX_BODY_LENGTH = 4000
MAX_QUOTE_LENGTH = 300
MAX_SELECTION_LENGTH = 500


class ProtocolError(ValueError):
    """Raised when a Plannotate marker or payload violates the protocol."""


def _base64url_encode(raw):
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _base64url_decode(value):
    padding = "=" * (-len(value) % 4)
    try:
        return base64.b64decode(
            value + padding, altchars=b"-_", validate=True
        )
    except (ValueError, base64.binascii.Error) as error:
        raise ProtocolError("comment metadata is not valid base64url") from error


def _required(metadata, name, expected_type):
    value = metadata.get(name)
    if not isinstance(value, expected_type):
        raise ProtocolError("metadata {0} has invalid type".format(name))
    return value


def _valid_plan_key(value):
    if not isinstance(value, str) or PLAN_KEY_PATTERN.fullmatch(value) is None:
        return False
    return all(segment not in (".", "..") for segment in value.split("/"))


def _artifact_path(plan_key, version):
    return ".plannotate/{0}/v{1:04d}.html".format(plan_key, version)


def _common_metadata(metadata):
    unknown = sorted(set(metadata) - METADATA_FIELDS)
    if unknown:
        raise ProtocolError("metadata has unknown fields: " + ", ".join(unknown))
    if metadata.get("schema") != SCHEMA:
        raise ProtocolError("metadata schema must be " + SCHEMA)
    plan_key = _required(metadata, "plan_key", str)
    if not _valid_plan_key(plan_key):
        raise ProtocolError("metadata plan_key is invalid")
    version = _required(metadata, "version", int)
    if isinstance(version, bool) or version < 1:
        raise ProtocolError("metadata version must be a positive integer")
    artifact_path = _required(metadata, "artifact_path", str)
    if artifact_path != _artifact_path(plan_key, version):
        raise ProtocolError("metadata artifact_path is not canonical")
    artifact_sha256 = _required(metadata, "artifact_sha256", str)
    if SHA256_PATTERN.fullmatch(artifact_sha256) is None:
        raise ProtocolError("metadata artifact_sha256 is invalid")
    general = _required(metadata, "general", bool)
    return {
        "schema": SCHEMA,
        "plan_key": plan_key,
        "version": version,
        "artifact_path": artifact_path,
        "artifact_sha256": artifact_sha256,
        "general": general,
    }


def _general_metadata(metadata, result):
    expected_empty = {
        "anchor_id": None, "line": None, "block_index": None,
        "block_hash": None, "quote": "", "heading_path": "",
        "selection": None,
    }
    for name, expected in expected_empty.items():
        if metadata.get(name, expected) != expected:
            raise ProtocolError("general metadata {0} must be empty".format(name))
    result.update(expected_empty)
    return result


def _block_metadata(metadata, result):
    anchor_id = _required(metadata, "anchor_id", str)
    line = _required(metadata, "line", int)
    block_index = _required(metadata, "block_index", int)
    block_hash = _required(metadata, "block_hash", str)
    if ANCHOR_ID_PATTERN.fullmatch(anchor_id) is None:
        raise ProtocolError("metadata anchor_id is invalid")
    if isinstance(line, bool) or line < 1:
        raise ProtocolError("metadata line must be a positive integer")
    if isinstance(block_index, bool) or block_index < 0:
        raise ProtocolError("metadata block_index must be a non-negative integer")
    if BLOCK_HASH_PATTERN.fullmatch(block_hash) is None:
        raise ProtocolError("metadata block_hash is invalid")
    quote = metadata.get("quote", "")
    heading = metadata.get("heading_path", "")
    if not isinstance(quote, str) or len(quote) > MAX_QUOTE_LENGTH:
        raise ProtocolError("metadata quote must be at most 300 characters")
    if not isinstance(heading, str) or len(heading) > 200:
        raise ProtocolError("metadata heading_path must be at most 200 characters")
    selection = metadata.get("selection")
    if selection is not None:
        selection = _validate_selection(selection)
    result.update({
        "anchor_id": anchor_id, "line": line, "block_index": block_index,
        "block_hash": block_hash, "quote": quote, "heading_path": heading,
        "selection": selection,
    })
    return result


def validate_metadata(metadata):
    """Validate and return a canonical defensive copy of protocol metadata."""
    if not isinstance(metadata, dict):
        raise ProtocolError("metadata must be an object")
    result = _common_metadata(metadata)
    if result["general"]:
        return _general_metadata(metadata, result)
    return _block_metadata(metadata, result)


def _validate_selection(selection):
    if not isinstance(selection, dict):
        raise ProtocolError("metadata selection must be an object or null")
    start = selection.get("start")
    end = selection.get("end")
    text = selection.get("text")
    valid_start = isinstance(start, int) and not isinstance(start, bool) and start >= 0
    valid_end = isinstance(end, int) and not isinstance(end, bool) and end > start
    if not valid_start or not valid_end:
        raise ProtocolError("metadata selection offsets are invalid")
    if not isinstance(text, str) or not 1 <= len(text) <= MAX_SELECTION_LENGTH:
        raise ProtocolError("metadata selection text must be 1-500 characters")
    unknown = sorted(set(selection) - {"start", "end", "text"})
    if unknown:
        raise ProtocolError("metadata selection has unknown fields")
    return {"start": start, "end": end, "text": text}


def encode_metadata(metadata):
    normalized = validate_metadata(metadata)
    raw = json.dumps(
        normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return _base64url_encode(raw)


def decode_metadata(encoded):
    try:
        value = json.loads(_base64url_decode(encoded).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProtocolError("comment metadata is not valid JSON") from error
    return validate_metadata(value)


def _header_lines(metadata):
    label = "> **Plannotate · `{0}` · v{1:04d}**".format(
        metadata["plan_key"], metadata["version"]
    )
    if metadata["general"]:
        return [label, "> 总体意见"]
    quote = _visible_text(" ".join(metadata.get("quote", "").split()))
    lines = [label, "> 块：" + quote]
    selection = metadata.get("selection")
    if selection is not None:
        selected = _visible_text(" ".join(selection["text"].split()))
        lines.append("> 高亮：\u201c" + selected + "\u201d")
    return lines


def _visible_text(value):
    return value.replace("<!--", "<\u200b!--").replace("-->", "--\u200b>")


def build_comment_body(body, metadata):
    """Build a human-readable GitHub comment with a machine marker."""
    if not isinstance(body, str) or not body.strip():
        raise ProtocolError("comment body must not be empty")
    if len(body) > MAX_BODY_LENGTH:
        raise ProtocolError("comment body must be at most 4000 characters")
    if BODY_MARKER in body or "<!-- plannotate:v1:" in body:
        raise ProtocolError("comment body contains a reserved protocol marker")
    normalized = validate_metadata(metadata)
    marker = "<!-- plannotate:v1:{0} -->".format(
        encode_metadata(normalized)
    )
    return "\n".join(
        _header_lines(normalized) + ["", BODY_MARKER, body.strip(), "", marker]
    )


def parse_comment_body(value):
    """Parse a protocol comment, returning None for unrelated PR comments."""
    if not isinstance(value, str):
        return None
    match = METADATA_PATTERN.search(value)
    if match is None:
        if "<!-- plannotate:v1:" in value:
            raise ProtocolError("comment metadata marker is malformed")
        return None
    metadata = decode_metadata(match.group(1))
    prefix = value[:match.start()].rstrip()
    if prefix.count(BODY_MARKER) != 1:
        raise ProtocolError("comment body marker is missing")
    marker_index = prefix.find(BODY_MARKER)
    body = prefix[marker_index + len(BODY_MARKER):].strip()
    if not body:
        raise ProtocolError("comment body is empty")
    if len(body) > MAX_BODY_LENGTH:
        raise ProtocolError("comment body must be at most 4000 characters")
    return {"metadata": metadata, "body": body}
