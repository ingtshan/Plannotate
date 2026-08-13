# Architecture and security

## Source of truth

Plannotate is a serverless GitHub client. The browser extension and CLI both call GitHub directly. Git repository artifacts hold immutable rendered plans; pull request review threads hold feedback and resolution state.

No Plannotate service receives tokens, plan contents, or comments.

## Artifact layout

A plan key contains two to five safe path segments, for example `example/architecture`. Its versions live under `.plannotate/<plan-key>/`:

```text
manifest.json
v0001.html
v0001.anchors.json
v0002.html
v0002.anchors.json
```

`manifest.json` uses the `plannotate.github/v1` schema and only appends version records. Each record binds the HTML and anchor sidecar with SHA-256 digests. The sidecar also binds the HTML digest.

The compiler uses a staged atomic write and refuses to overwrite an existing version. It rejects symlinked artifact directories and unsafe plan keys.

## Rendering trust boundary

The extension first fixes all reads to the current pull request `head.sha`. It then:

1. loads and validates the manifest;
2. checks the selected paths and version fields;
3. fetches HTML and anchor bytes at the same commit SHA;
4. verifies both SHA-256 digests and their cross-binding;
5. passes only verified HTML, anchors, and normalized thread data into the sandbox.

The sandbox page has a Content Security Policy with no network, object, form, base URL, or same-origin capability. HTML is sanitized both by the compiler and again inside the sandbox. Scripts, frames, embeds, forms, event attributes, `srcdoc`, navigation URLs, remote resources, and privileged Plannotate DOM names are removed or rejected. Plan CSS is scoped so it cannot style extension controls.

Comment bodies are rendered through `textContent`, never interpreted as HTML.

## GitHub permissions

The extension manifest requests only local extension storage and access to `https://api.github.com`. Its content script runs only on GitHub pull request pages.

A fine-grained token should grant the minimum repository permissions:

- Contents: read-only, for manifests and artifacts;
- Pull requests: read and write, for reading, creating, replying to, and deleting review comments;
- Metadata: read-only, as required by GitHub.

The same Pull requests permission covers pending-review recovery. When GitHub rejects a comment because the account already has a pending review, the viewer lists the pull request reviews, finds the caller's `PENDING` review, and either submits it (`POST .../reviews/{id}/events` with a `COMMENT` event) or deletes it (`DELETE .../reviews/{id}`) before resending the kept draft. Both actions run only on an explicit click, and deletion requires a second confirming click that states how many draft comments are removed.

The token remains in `chrome.storage.local`. The plan sandbox cannot read extension storage or make GitHub requests.

The extension treats review threads as versioned plan history: it reads thread state but never mutates it, so no thread-state permission path exists in the browser. GitHub may reject the GraphQL thread-state mutations for a fine-grained PAT even when review-comment writes succeed; resolving or reopening therefore stays in the CLI or the native GitHub UI, where unattended automation can use a classic PAT.

The CLI reads `GITHUB_TOKEN`, `GH_TOKEN`, or `gh auth token` at invocation time. Tokens are never accepted as command-line arguments, written to disk, or included in output.

## Comment protocol

General feedback maps to a file-level GitHub review comment. Block and selection feedback map to a line-level comment on the versioned HTML artifact.

The visible comment header identifies the plan key and artifact version. A trailing `<!-- plannotate:v1:... -->` marker carries validated, base64url-encoded metadata including:

- plan key and version;
- artifact path and SHA-256;
- stable anchor, block position, and quote;
- optional selection offsets and text.

The parser accepts only the documented fields and validates paths, hashes, bounds, and types. Ordinary GitHub comments are ignored. Metadata that does not match the committed manifest fails closed instead of being shown as trusted plan feedback.

## Version semantics

Explicit `data-plan-anchor` values provide the strongest identity between versions. Other blocks use a deterministic document index plus FNV-1a text hash. Selection offsets are relative to the block text.

Media blocks are first-class anchors: the first `img`/`svg`/`canvas` inside a `<figure data-plan-anchor="...">` inherits the figure's anchor, and an SVG's direct `<title>` child becomes its human-readable comment label. Existing sidecars are immutable, so both rules apply only to versions packaged after they were introduced.

Threads stay attached to the artifact version where they were created. The review rail renders every thread in one place as versioned history: current-version groups ordered by block position, general feedback, per-version history groups, and threads whose anchors no longer exist. History is never relabeled as current-version feedback, and the browser UI never changes a thread's resolved state.

## Release integrity

`scripts/build_extension.py` copies an explicit allowlist of extension runtime files, adds installation instructions, and produces a deterministic ZIP. It excludes tests and all repository-only content. `dist/SHA256SUMS.txt` records the archive digest.
