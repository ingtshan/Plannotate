"""Token-conscious formatting for GitHub review threads."""

from .protocol import ProtocolError, parse_comment_body


GENERAL_HEADING = "（总体意见）"
UNTITLED = "（无标题）"
MAX_QUOTE = 80


def protocol_threads(threads, plan_key=None):
    """Normalize GitHub GraphQL threads carrying valid Plannotate markers."""
    records = []
    for thread in threads:
        comments = thread.get("comments") or []
        root = next((item for item in comments if item.get("replyTo") is None), None)
        if root is None:
            continue
        try:
            parsed = parse_comment_body(root.get("body"))
        except ProtocolError as error:
            records.append({"protocol_error": str(error), "thread": thread})
            continue
        if parsed is None:
            continue
        metadata = parsed["metadata"]
        if plan_key is not None and metadata["plan_key"] != plan_key:
            continue
        if thread.get("path") != metadata["artifact_path"]:
            records.append({
                "protocol_error": "thread path does not match artifact_path",
                "thread": thread,
            })
            continue
        replies = [item for item in comments if item is not root]
        records.append({
            "thread_id": thread["id"],
            "is_resolved": bool(thread.get("isResolved")),
            "is_outdated": bool(thread.get("isOutdated")),
            "path": thread.get("path"),
            "line": thread.get("line"),
            "subject_type": thread.get("subjectType"),
            "root": root,
            "body": parsed["body"],
            "metadata": metadata,
            "replies": replies,
            "permissions": {
                "reply": bool(thread.get("viewerCanReply")),
                "resolve": bool(thread.get("viewerCanResolve")),
                "reopen": bool(thread.get("viewerCanUnresolve")),
                "delete": bool(root.get("viewerCanDelete")),
            },
        })
    return records


def bind_manifest(records, manifest):
    """Fail records closed when marker identity is absent from the manifest."""
    versions = {
        item["version"]: item for item in manifest.get("versions", [])
        if isinstance(item, dict) and isinstance(item.get("version"), int)
    }
    result = []
    for record in records:
        metadata = record.get("metadata")
        if metadata is None:
            result.append(record)
            continue
        version = versions.get(metadata["version"])
        matches = version is not None and all((
            metadata["artifact_path"] == version.get("artifact_path"),
            metadata["artifact_sha256"] == version.get("artifact_sha256"),
        ))
        if matches:
            result.append(record)
        else:
            result.append({
                "protocol_error": "comment artifact identity is not in manifest",
                "thread": record,
            })
    return result


def _minute(value):
    return (value or "")[:16].replace("T", " ")


def _author(comment):
    return ((comment.get("author") or {}).get("login")) or "ghost"


def _database_id(comment):
    value = comment.get("databaseId")
    return "c{0}".format(value) if value is not None else comment.get("id", "comment")


def _short(value):
    value = value or ""
    return value if len(value) <= MAX_QUOTE else value[:MAX_QUOTE] + "…"


def _thread_key(record):
    metadata = record["metadata"]
    return (
        -metadata["version"],
        0 if metadata["general"] else 1,
        metadata.get("block_index", 2 ** 31),
        record["root"].get("createdAt", ""),
        record["root"].get("databaseId", 0),
    )


def _heading(record):
    metadata = record["metadata"]
    if metadata["general"]:
        return GENERAL_HEADING
    return metadata.get("heading_path") or UNTITLED


def _append_thread(lines, record):
    root = record["root"]
    status = "resolved" if record["is_resolved"] else "open"
    outdated = " · outdated" if record["is_outdated"] else ""
    lines.append(
        "- [{0}] [{1}] @{2} {3} · thread {4}{5}".format(
            status, _database_id(root), _author(root),
            _minute(root.get("createdAt")), record["thread_id"], outdated,
        )
    )
    metadata = record["metadata"]
    if not metadata["general"]:
        lines.append("  > 块: " + _short(metadata.get("quote", "")))
        selection = metadata.get("selection")
        if selection is not None:
            lines.append('  > 高亮: "' + _short(selection["text"]) + '"')
    lines.extend("  " + line for line in record["body"].split("\n"))
    for reply in record["replies"]:
        lines.append(
            "  ↳ [{0}] @{1} {2}".format(
                _database_id(reply), _author(reply), _minute(reply.get("createdAt"))
            )
        )
        lines.extend("    " + line for line in (reply.get("body") or "").split("\n"))


def threads_to_markdown(reference_label, plan_key, records, latest, status="open"):
    valid = [item for item in records if "metadata" in item]
    errors = [item for item in records if "protocol_error" in item]
    selected = [
        item for item in valid
        if status == "all"
        or (status == "resolved") == item["is_resolved"]
    ]
    total = len(valid)
    if not selected:
        result = (
            "# Plannotate: {0} | {1} | no {2} comments "
            "(total {3}, latest v{4:04d})"
        ).format(reference_label, plan_key, status, total, latest)
        if errors:
            result += " | protocol errors {0}".format(len(errors))
        return result
    label = status if status != "all" else "all"
    lines = [
        "# Plannotate: {0} | {1} | {2} {3} / total {4} | latest v{5:04d}".format(
            reference_label, plan_key, label, len(selected), total, latest
        )
    ]
    if errors:
        lines.append("! protocol errors: {0} (use --json for details)".format(len(errors)))
    current_group = None
    for record in sorted(selected, key=_thread_key):
        group = (record["metadata"]["version"], _heading(record))
        if group != current_group:
            lines.append("## v{0:04d} §{1}".format(group[0], group[1]))
            current_group = group
        _append_thread(lines, record)
    lines.append("reply: plannotate reply <pr> <thread-id> <body>")
    lines.append("resolve: plannotate resolve <pr> <thread-id> [--note ...]")
    return "\n".join(lines)
