"""Build immutable, line-addressable GitHub plan review artifacts."""

import hashlib
import json
import os
import re
import tempfile
from datetime import datetime
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit

from .protocol import SCHEMA


PLAN_SEGMENT = r"[A-Za-z0-9._\-一-鿿]+"
PLAN_KEY_PATTERN = re.compile(
    r"^{0}(?:/{0}){{1,4}}$".format(PLAN_SEGMENT)
)
EXPLICIT_ANCHOR_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,100}$")
BLOCK_HASH_PATTERN = re.compile(r"^[0-9a-f]{8}$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
COMMENTABLE_TAGS = frozenset(
    ("h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "pre",
     "blockquote", "tr", "figcaption", "dt", "dd", "img", "svg", "canvas")
)
MEDIA_TAGS = frozenset(("img", "svg", "canvas"))
FORBIDDEN_TAGS = frozenset(("script", "iframe", "object", "embed", "base", "form"))
RESOURCE_ATTRIBUTES = frozenset(("src", "poster", "xlink:href"))
MAX_ARTIFACT_BYTES = 2 * 1024 * 1024
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_SIDECAR_BYTES = 4 * 1024 * 1024
MANIFEST_NAME = "manifest.json"
MANIFEST_SCHEMA = SCHEMA


class ArtifactError(ValueError):
    """Raised when source HTML or an artifact manifest is invalid."""


def valid_plan_key(plan_key):
    if not isinstance(plan_key, str) or not PLAN_KEY_PATTERN.fullmatch(plan_key):
        return False
    return all(segment not in (".", "..") for segment in plan_key.split("/"))


def fnv1a_utf16(value):
    """Match JavaScript charCodeAt-based FNV-1a exactly."""
    encoded = value.encode("utf-16-le", "surrogatepass")
    result = 2166136261
    for offset in range(0, len(encoded), 2):
        unit = encoded[offset] | (encoded[offset + 1] << 8)
        result = ((result ^ unit) * 16777619) & 0xffffffff
    return "{0:08x}".format(result)


def normalize_text(value):
    return " ".join(value.strip().split())


class _Candidate:
    def __init__(self, tag, line, attributes):
        self.tag = tag
        self.line = line
        self.attributes = dict(attributes)
        self.text_parts = []


class _PlanParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.candidates = []
        self.active = []
        self.errors = []

    def handle_starttag(self, tag, attrs):
        self._handle_start(tag, attrs, self_closing=False)

    def handle_startendtag(self, tag, attrs):
        self._handle_start(tag, attrs, self_closing=True)

    def _handle_start(self, tag, attrs, self_closing):
        lowered = tag.lower()
        attributes = [(name.lower(), value or "") for name, value in attrs]
        self._validate_element(lowered, attributes)
        if lowered in COMMENTABLE_TAGS:
            candidate = _Candidate(lowered, self.getpos()[0], attributes)
            self.candidates.append(candidate)
            if lowered not in MEDIA_TAGS and not self_closing:
                self.active.append(candidate)

    def handle_endtag(self, tag):
        lowered = tag.lower()
        for index in range(len(self.active) - 1, -1, -1):
            if self.active[index].tag == lowered:
                del self.active[index]
                return

    def handle_data(self, data):
        for candidate in self.active:
            candidate.text_parts.append(data)

    def _validate_element(self, tag, attributes):
        if tag in FORBIDDEN_TAGS:
            self.errors.append("forbidden <{0}> element at line {1}".format(
                tag, self.getpos()[0]
            ))
        for name, value in attributes:
            if name.startswith("on") or name == "srcdoc":
                self.errors.append("executable {0} attribute at line {1}".format(
                    name, self.getpos()[0]
                ))
            if name in RESOURCE_ATTRIBUTES and _unsafe_resource(value):
                self.errors.append("external resource {0} at line {1}".format(
                    value, self.getpos()[0]
                ))
            class_tokens = value.split() if name == "class" else ()
            reserved = (
                (name == "id" and value.lower().startswith("prg-"))
                or (name == "class" and any(
                    token.lower().startswith("prg-") for token in class_tokens
                ))
                or name.startswith("data-prg-")
                or name == "data-plannotate-anchor"
            )
            if reserved:
                self.errors.append("reserved {0} attribute at line {1}".format(
                    name, self.getpos()[0]
                ))


def _unsafe_resource(value):
    if not value or value.startswith("data:") or value.startswith("#"):
        return False
    parsed = urlsplit(value)
    return bool(parsed.scheme or parsed.netloc or not value.startswith("#"))


def _media_details(candidate):
    if candidate.tag == "img":
        source = candidate.attributes.get("src", "")
        alt = candidate.attributes.get("alt", "")
        clean = source.split("?", 1)[0].split("#", 1)[0]
        filename = unquote(clean.rstrip("/").rsplit("/", 1)[-1]) if clean else ""
        return source + "|" + alt, "[图] " + (alt or filename or "img")
    if candidate.tag == "canvas":
        width = candidate.attributes.get("width", "300")
        height = candidate.attributes.get("height", "150")
        return "canvas|{0}|{1}".format(width, height), "[图] canvas"
    return "svg-line-{0}".format(candidate.line), "[图] svg"


def _candidate_record(candidate, index, headings):
    text = normalize_text("".join(candidate.text_parts))
    if candidate.tag not in MEDIA_TAGS and not text:
        return None
    if candidate.tag in MEDIA_TAGS:
        hash_input, quote = _media_details(candidate)
    else:
        hash_input, quote = text, text[:120]
    block_hash = fnv1a_utf16(hash_input)
    legacy_id = "b{0}-{1}".format(index, block_hash)
    explicit = candidate.attributes.get("data-plan-anchor")
    if explicit and not EXPLICIT_ANCHOR_PATTERN.fullmatch(explicit):
        raise ArtifactError(
            "invalid data-plan-anchor at line {0}: {1}".format(
                candidate.line, explicit
            )
        )
    heading_path = " > ".join(value for value in headings.values() if value)
    record = {
        "anchor_id": explicit or legacy_id,
        "legacy_block_id": legacy_id,
        "index": index,
        "line": candidate.line,
        "tag": candidate.tag,
        "block_hash": block_hash,
        "quote": quote,
        "heading_path": heading_path,
    }
    if candidate.tag in ("h1", "h2", "h3"):
        level = int(candidate.tag[1])
        headings[level] = text[:40]
        for next_level in range(level + 1, 4):
            headings[next_level] = ""
    return record


def scan_anchors(html_text):
    parser = _PlanParser()
    parser.feed(html_text)
    parser.close()
    if parser.errors:
        raise ArtifactError("; ".join(parser.errors))
    headings = {1: "", 2: "", 3: ""}
    records = []
    for candidate in parser.candidates:
        record = _candidate_record(candidate, len(records), headings)
        if record is not None:
            records.append(record)
    identifiers = [item["anchor_id"] for item in records]
    if len(set(identifiers)) != len(identifiers):
        raise ArtifactError("data-plan-anchor values must be unique")
    return records


def _read_source(path):
    size = os.path.getsize(path)
    if size > MAX_ARTIFACT_BYTES:
        raise ArtifactError("source HTML exceeds the 2 MiB artifact limit")
    with open(path, "rb") as source:
        raw = source.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ArtifactError("source HTML must be UTF-8") from error
    return raw, text


def _load_manifest(path, plan_key):
    if not os.path.exists(path):
        return {"schema": MANIFEST_SCHEMA, "plan_key": plan_key, "latest": 0,
                "versions": []}
    if os.path.islink(path):
        raise ArtifactError("manifest must not be a symbolic link")
    if os.path.getsize(path) > MAX_MANIFEST_BYTES:
        raise ArtifactError("existing manifest exceeds 1 MiB")
    with open(path, "r", encoding="utf-8") as source:
        try:
            manifest = json.load(source)
        except json.JSONDecodeError as error:
            raise ArtifactError("existing manifest is not valid JSON") from error
    validate_manifest(manifest, plan_key)
    return manifest


def artifact_path(plan_key, version):
    return ".plannotate/{0}/v{1:04d}.html".format(plan_key, version)


def anchor_sidecar_path(plan_key, version):
    return ".plannotate/{0}/v{1:04d}.anchors.json".format(plan_key, version)


def validate_manifest(manifest, plan_key):
    """Validate the complete immutable-version manifest contract."""
    if not isinstance(manifest, dict) or manifest.get("schema") != MANIFEST_SCHEMA:
        raise ArtifactError("manifest schema is unsupported")
    if manifest.get("plan_key") != plan_key or not valid_plan_key(plan_key):
        raise ArtifactError("manifest plan_key does not match the request")
    latest = manifest.get("latest")
    versions = manifest.get("versions")
    if (not isinstance(latest, int) or isinstance(latest, bool) or latest < 0
            or not isinstance(versions, list) or len(versions) != latest):
        raise ArtifactError("manifest latest/versions are inconsistent")
    expected_versions = list(range(1, latest + 1))
    actual_versions = []
    for record in versions:
        if not isinstance(record, dict):
            raise ArtifactError("manifest version record must be an object")
        version = record.get("version")
        if (not isinstance(version, int) or isinstance(version, bool)
                or version < 1):
            raise ArtifactError("manifest version is invalid")
        actual_versions.append(version)
        if record.get("artifact_path") != artifact_path(plan_key, version):
            raise ArtifactError("manifest artifact_path is not canonical")
        if record.get("anchors_path") != anchor_sidecar_path(plan_key, version):
            raise ArtifactError("manifest anchors_path is not canonical")
        if SHA256_PATTERN.fullmatch(record.get("artifact_sha256", "")) is None:
            raise ArtifactError("manifest artifact_sha256 is invalid")
        if SHA256_PATTERN.fullmatch(record.get("anchors_sha256", "")) is None:
            raise ArtifactError("manifest anchors_sha256 is invalid")
        if not isinstance(record.get("created_at"), str) or not record["created_at"]:
            raise ArtifactError("manifest created_at is invalid")
    if actual_versions != expected_versions:
        raise ArtifactError("manifest versions must be consecutive and ordered")
    return manifest


def validate_anchor_document(document, plan_key, record):
    """Validate a sidecar after its own SHA-256 has been verified."""
    if not isinstance(document, dict) or document.get("schema") != MANIFEST_SCHEMA:
        raise ArtifactError("anchor sidecar schema is unsupported")
    expected = {
        "plan_key": plan_key,
        "version": record["version"],
        "artifact_path": record["artifact_path"],
        "artifact_sha256": record["artifact_sha256"],
    }
    for name, value in expected.items():
        if document.get(name) != value:
            raise ArtifactError("anchor sidecar {0} does not match manifest".format(name))
    anchors = document.get("anchors")
    if not isinstance(anchors, list):
        raise ArtifactError("anchor sidecar anchors must be an array")
    identifiers = set()
    for index, anchor in enumerate(anchors):
        if not isinstance(anchor, dict) or anchor.get("index") != index:
            raise ArtifactError("anchor sidecar indices must be consecutive")
        if anchor.get("tag") not in COMMENTABLE_TAGS:
            raise ArtifactError("anchor sidecar tag is invalid")
        if (not isinstance(anchor.get("line"), int)
                or isinstance(anchor.get("line"), bool) or anchor["line"] < 1):
            raise ArtifactError("anchor sidecar line is invalid")
        identifier = anchor.get("anchor_id")
        if (not isinstance(identifier, str)
                or EXPLICIT_ANCHOR_PATTERN.fullmatch(identifier) is None
                or identifier in identifiers):
            raise ArtifactError("anchor sidecar anchor_id is invalid or duplicated")
        identifiers.add(identifier)
        block_hash = anchor.get("block_hash", "")
        if BLOCK_HASH_PATTERN.fullmatch(block_hash) is None:
            raise ArtifactError("anchor sidecar block_hash is invalid")
        if anchor.get("legacy_block_id") != "b{0}-{1}".format(index, block_hash):
            raise ArtifactError("anchor sidecar legacy_block_id is invalid")
        quote = anchor.get("quote")
        heading = anchor.get("heading_path")
        if not isinstance(quote, str) or len(quote) > 300:
            raise ArtifactError("anchor sidecar quote is invalid")
        if not isinstance(heading, str) or len(heading) > 200:
            raise ArtifactError("anchor sidecar heading_path is invalid")
    return document


def _atomic_write(path, body, binary=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    mode = "wb" if binary else "w"
    kwargs = {} if binary else {"encoding": "utf-8"}
    descriptor, temporary = tempfile.mkstemp(
        prefix=".plannotate-", dir=os.path.dirname(path)
    )
    try:
        with os.fdopen(descriptor, mode, **kwargs) as destination:
            destination.write(body)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _immutable_write(path, body, binary=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    mode = "wb" if binary else "w"
    kwargs = {} if binary else {"encoding": "utf-8"}
    descriptor, temporary = tempfile.mkstemp(
        prefix=".plannotate-", dir=os.path.dirname(path)
    )
    try:
        with os.fdopen(descriptor, mode, **kwargs) as destination:
            destination.write(body)
        try:
            os.link(temporary, path)
        except FileExistsError as error:
            raise ArtifactError("artifact version already exists") from error
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _version_documents(raw, anchors, manifest, plan_key, version, timestamp):
    digest = hashlib.sha256(raw).hexdigest()
    artifact_relative = artifact_path(plan_key, version)
    anchors_relative = anchor_sidecar_path(plan_key, version)
    anchor_document = {
        "schema": MANIFEST_SCHEMA,
        "plan_key": plan_key,
        "version": version,
        "artifact_path": artifact_relative,
        "artifact_sha256": digest,
        "anchors": anchors,
    }
    anchors_body = (
        json.dumps(anchor_document, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    )
    if len(anchors_body.encode("utf-8")) > MAX_SIDECAR_BYTES:
        raise ArtifactError("anchor sidecar exceeds 4 MiB")
    version_record = {
        "version": version,
        "artifact_path": artifact_relative,
        "anchors_path": anchors_relative,
        "artifact_sha256": digest,
        "anchors_sha256": hashlib.sha256(anchors_body.encode("utf-8")).hexdigest(),
        "created_at": timestamp,
    }
    updated = dict(manifest)
    updated["latest"] = version
    updated["versions"] = list(manifest["versions"]) + [version_record]
    return anchors_body, version_record, updated


def build_artifact(source_path, repository_root, plan_key, created_at=None):
    """Append an immutable HTML version and update its manifest atomically."""
    if not valid_plan_key(plan_key):
        raise ArtifactError("plan_key must contain 2-5 safe path segments")
    repository_root = os.path.realpath(repository_root)
    if not os.path.isdir(repository_root):
        raise ArtifactError("repository root does not exist")
    source_path = os.path.realpath(source_path)
    if not os.path.isfile(source_path):
        raise ArtifactError("source HTML does not exist")
    raw, text = _read_source(source_path)
    anchors = scan_anchors(text)
    artifact_directory = os.path.join(
        repository_root, ".plannotate", *plan_key.split("/")
    )
    if os.path.commonpath((repository_root, os.path.realpath(artifact_directory))) \
            != repository_root:
        raise ArtifactError("artifact directory escapes repository root")
    manifest_path = os.path.join(artifact_directory, MANIFEST_NAME)
    manifest = _load_manifest(manifest_path, plan_key)
    version = int(manifest.get("latest", 0)) + 1
    html_name = "v{0:04d}.html".format(version)
    anchors_name = "v{0:04d}.anchors.json".format(version)
    html_path = os.path.join(artifact_directory, html_name)
    anchors_path = os.path.join(artifact_directory, anchors_name)
    if os.path.exists(html_path) or os.path.exists(anchors_path):
        raise ArtifactError("next artifact version already exists")
    timestamp = created_at or datetime.now().astimezone().isoformat(timespec="seconds")
    anchors_body, version_record, updated = _version_documents(
        raw, anchors, manifest, plan_key, version, timestamp
    )
    manifest_body = (
        json.dumps(updated, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    )
    if len(manifest_body.encode("utf-8")) > MAX_MANIFEST_BYTES:
        raise ArtifactError("updated manifest exceeds 1 MiB")
    _immutable_write(html_path, raw, binary=True)
    _immutable_write(anchors_path, anchors_body)
    _atomic_write(manifest_path, manifest_body)
    return {"manifest_path": manifest_path, "artifact": version_record,
            "anchor_count": len(anchors)}
