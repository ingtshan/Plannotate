# Plannotate

Review versioned HTML plans directly in GitHub pull requests.

Plannotate turns a self-contained plan into immutable HTML artifacts, renders them in a sandboxed browser extension, and stores block, selection, and general feedback as native GitHub review threads. The CLI reads the same threads back for the next plan iteration.

**No application server, database, or hosted review state is required. GitHub is the source of truth.**

## How it works

```text
plan.html
   |  plannotate package
   v
.plannotate/<plan-key>/
   |- manifest.json
   |- v0001.html
   `- v0001.anchors.json
          |
          | commit to a pull request
          v
browser extension <-> GitHub API <-> native review threads
          ^
          |
      Plannotate CLI
```

- Every iteration appends a new version; previous HTML and anchor files are never overwritten.
- The extension reads files at the pull request head SHA and verifies their SHA-256 chain before rendering.
- Plan HTML runs inside a restricted sandbox with no network, form, object, or same-origin capability.
- Comments, authorship, timestamps, replies, and resolved state remain in GitHub.
- The implementation uses the Python standard library and native browser APIs; there are no runtime package dependencies or remote CDNs.

See [Architecture and security](docs/architecture.md) for the protocol and trust boundaries.

## Install the extension

Requirements: Chrome or another Manifest V3 Chromium browser, plus Python 3.9 or newer to build the release archive.

```bash
python3 scripts/build_extension.py
```

The command creates:

```text
dist/plannotate-v0.2.1/
dist/plannotate-v0.2.1.zip
dist/SHA256SUMS.txt
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the generated `dist/plannotate-v0.2.1` directory. The ZIP contains the same auditable unpacked directory; a self-signed CRX is intentionally not produced.

Open the extension options and save a fine-grained GitHub personal access token limited to the repositories you review:

- Resource owner: the owner of the repository being reviewed
- Repository access: only selected repositories
- Contents: read-only
- Pull requests: read and write
- Metadata: read-only (automatically required by GitHub)

The options page links to GitHub's token form with the permissions prefilled and checks identity, repository, PR, and plan read access without creating a test comment. GitHub does not expose a side-effect-free write-permission probe, so verify that **Pull requests** says **Read and write**. Organization-owned repositories may also require administrator approval or SSO authorization. A fine-grained token is limited to one resource owner.

The token stays in `chrome.storage.local`. It is sent only to `https://api.github.com` and is never placed in plan HTML, repository files, comments, or the sandbox frame.

## Publish a plan

The source HTML must be UTF-8, self-contained, and no larger than 2 MiB. Scripts, frames, forms, event handlers, and remote assets are rejected. Inline CSS and `data:` images are supported.

```bash
./bin/plannotate package path/to/plan.html example/architecture \
  --repo-root "$(git rev-parse --show-toplevel)"

git add path/to/plan.html .plannotate/example/architecture
git commit -m "docs: publish architecture plan"
git push
```

Running `package` again after editing the source creates `v0002`; it does not modify `v0001`. Add a stable `data-plan-anchor="authentication"` attribute to important blocks when comments should carry clearly across versions. Unmarked blocks receive deterministic fallback anchors.

Open the pull request and choose the native-style **Plan review** tab. Plannotate renders an inline review workspace in the PR, discovers changed manifests, lets you choose a version, and supports:

- general plan feedback;
- block-level comments;
- text-selection comments;
- replies, resolve, reopen, and deletion when GitHub grants the capability;
- explicit carryover display for unresolved comments on older versions.

## Use the CLI

The CLI resolves authentication from `GITHUB_TOKEN`, then `GH_TOKEN`, then an existing `gh auth token` session.

```bash
# List plans changed by a pull request
./bin/plannotate plans https://github.com/owner/repository/pull/123

# Export unresolved comments in compact Markdown
./bin/plannotate pull owner/repository#123 example/architecture

# Create general or anchored feedback
./bin/plannotate comment owner/repository#123 example/architecture 'Add rollback steps'
./bin/plannotate comment owner/repository#123 example/architecture 'Clarify this boundary' \
  --anchor authentication

# Reply and resolve using the GraphQL thread ID from pull output
./bin/plannotate reply owner/repository#123 PRRT_node_id 'Addressed in v0002'
./bin/plannotate resolve owner/repository#123 PRRT_node_id --note 'Updated the threat model'
./bin/plannotate reopen owner/repository#123 PRRT_node_id
```

The intended loop is: `pull` -> edit source -> `package` -> commit -> reply -> resolve -> `pull` again.

## Development

```bash
python3 -m unittest discover -s tests -v
node --test extension/tests/*.test.js
find extension -name '*.js' -exec node --check {} \;
python3 scripts/build_extension.py
(cd dist && shasum -a 256 -c SHA256SUMS.txt)
```

The release builder uses an explicit production-file allowlist and deterministic ZIP metadata. Test sources are never included in the extension archive.

## License

[MIT](LICENSE)
