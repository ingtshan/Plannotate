"""Command-line interface for Plannotate."""

import argparse
import json
import os
import sys

from .artifact import ArtifactError, build_artifact
from .client import (
    DEFAULT_API_URL,
    DEFAULT_GRAPHQL_URL,
    GitHubClient,
    GitHubError,
    discover_plan_keys,
    load_plan_bundle,
    parse_pull_ref,
    resolve_token,
)
from .format import bind_manifest, protocol_threads, threads_to_markdown
from .protocol import SCHEMA, ProtocolError, build_comment_body


def build_parser():
    parser = argparse.ArgumentParser(
        prog="plannotate",
        description="Review immutable HTML plans in GitHub pull requests.",
    )
    parser.add_argument(
        "--api-url", default=os.environ.get("GITHUB_API_URL", DEFAULT_API_URL)
    )
    parser.add_argument(
        "--graphql-url",
        default=os.environ.get("GITHUB_GRAPHQL_URL", DEFAULT_GRAPHQL_URL),
    )
    commands = parser.add_subparsers(dest="command", required=True)
    _add_artifact_commands(commands)
    _add_thread_commands(commands)
    return parser


def _add_artifact_commands(commands):
    package = commands.add_parser("package", help="append an immutable HTML version")
    package.add_argument("source")
    package.add_argument("plan_key")
    package.add_argument("--repo-root", default=".")
    package.set_defaults(handler=_package)

    plans = commands.add_parser("plans", help="list plan manifests changed by a PR")
    plans.add_argument("pull_request")
    plans.set_defaults(handler=_plans)

    pull = commands.add_parser("pull", help="export plan review threads")
    pull.add_argument("pull_request")
    pull.add_argument("plan_key")
    pull.add_argument("--status", choices=("open", "resolved", "all"), default="open")
    pull.add_argument("--json", action="store_true", dest="as_json")
    pull.set_defaults(handler=_pull)

    comment = commands.add_parser("comment", help="create a file or block review thread")
    comment.add_argument("pull_request")
    comment.add_argument("plan_key")
    comment.add_argument("body")
    comment.add_argument("--version", type=int)
    comment.add_argument("--anchor")
    comment.add_argument("--selection-start", type=int)
    comment.add_argument("--selection-end", type=int)
    comment.add_argument("--selection-text")
    comment.set_defaults(handler=_comment)


def _add_thread_commands(commands):
    reply = commands.add_parser("reply", help="reply to a review thread")
    reply.add_argument("pull_request")
    reply.add_argument("thread_id")
    reply.add_argument("body")
    reply.set_defaults(handler=_reply)

    resolve = commands.add_parser("resolve", help="resolve a review thread")
    resolve.add_argument("pull_request")
    resolve.add_argument("thread_id")
    resolve.add_argument("--note")
    resolve.set_defaults(handler=_resolve)

    reopen = commands.add_parser("reopen", help="reopen a resolved review thread")
    reopen.add_argument("pull_request")
    reopen.add_argument("thread_id")
    reopen.set_defaults(handler=_reopen)

    delete = commands.add_parser("delete", help="delete a review comment by node id")
    delete.add_argument("pull_request")
    delete.add_argument("comment_id")
    delete.set_defaults(handler=_delete)


def _client(args):
    return GitHubClient(
        resolve_token(), api_url=args.api_url, graphql_url=args.graphql_url
    )


def _package(args):
    result = build_artifact(args.source, args.repo_root, args.plan_key)
    artifact = result["artifact"]
    print("created {0}".format(artifact["artifact_path"]))
    print("anchors {0}".format(result["anchor_count"]))
    print("sha256 {0}".format(artifact["artifact_sha256"]))


def _plans(args):
    reference = parse_pull_ref(args.pull_request)
    keys = discover_plan_keys(_client(args).list_pull_files(reference))
    if not keys:
        print("（该 PR 没有 Plannotate manifest）")
        return
    for key in keys:
        print(key)


def _pull(args):
    reference = parse_pull_ref(args.pull_request)
    client = _client(args)
    bundle = load_plan_bundle(client, reference, args.plan_key)
    records = bind_manifest(
        protocol_threads(
            client.list_review_threads(reference), plan_key=args.plan_key
        ),
        bundle["manifest"],
    )
    if args.as_json:
        print(json.dumps(records, ensure_ascii=False, indent=2, sort_keys=True))
        return
    print(threads_to_markdown(
        reference.label, args.plan_key, records,
        bundle["manifest"]["latest"], args.status,
    ))


def _selection(args):
    values = (args.selection_start, args.selection_end, args.selection_text)
    if all(value is None for value in values):
        return None
    if any(value is None for value in values):
        raise ProtocolError("selection start/end/text must be provided together")
    return {"start": values[0], "end": values[1], "text": values[2]}


def _comment(args):
    selection = _selection(args)
    if args.anchor is None and selection is not None:
        raise ProtocolError("a selection requires --anchor")
    reference = parse_pull_ref(args.pull_request)
    client = _client(args)
    bundle = load_plan_bundle(
        client, reference, args.plan_key, version=args.version
    )
    version = bundle["version"]
    anchor = None
    if args.anchor:
        anchor = next(
            (item for item in bundle["anchors"].get("anchors", [])
             if item.get("anchor_id") == args.anchor), None
        )
        if anchor is None:
            raise GitHubError("anchor does not exist: " + args.anchor)
    metadata = {
        "schema": SCHEMA,
        "plan_key": args.plan_key,
        "version": version["version"],
        "artifact_path": version["artifact_path"],
        "artifact_sha256": version["artifact_sha256"],
        "general": anchor is None,
        "anchor_id": anchor.get("anchor_id") if anchor else None,
        "line": anchor.get("line") if anchor else None,
        "block_index": anchor.get("index") if anchor else None,
        "block_hash": anchor.get("block_hash") if anchor else None,
        "quote": anchor.get("quote", "") if anchor else "",
        "heading_path": anchor.get("heading_path", "") if anchor else "",
        "selection": selection if anchor else None,
    }
    body = build_comment_body(args.body, metadata)
    created = client.create_review_comment(
        reference, bundle["head_sha"], version["artifact_path"], body,
        line=anchor.get("line") if anchor else None, file_level=anchor is None,
    )
    print("created c{0}: {1}".format(created.get("id"), created.get("html_url", "")))


def _reply(args):
    parse_pull_ref(args.pull_request)
    result = _client(args).reply_thread(args.thread_id, args.body)
    comment = result["addPullRequestReviewThreadReply"]["comment"]
    print("replied c{0}: {1}".format(comment.get("databaseId"), comment.get("url")))


def _resolve(args):
    parse_pull_ref(args.pull_request)
    client = _client(args)
    if args.note:
        client.reply_thread(args.thread_id, args.note)
    client.resolve_thread(args.thread_id)
    print("resolved " + args.thread_id)


def _reopen(args):
    parse_pull_ref(args.pull_request)
    _client(args).reopen_thread(args.thread_id)
    print("reopened " + args.thread_id)


def _delete(args):
    parse_pull_ref(args.pull_request)
    _client(args).delete_comment(args.comment_id)
    print("deleted " + args.comment_id)


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        args.handler(args)
    except (ArtifactError, GitHubError, ProtocolError, OSError, ValueError) as error:
        parser.exit(2, "error: {0}\n".format(error))
    return 0


if __name__ == "__main__":
    sys.exit(main())
