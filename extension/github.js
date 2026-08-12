(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./protocol.js"));
  } else {
    root.PlannotateGitHub = factory(root.PlannotateProtocol);
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function (protocol) {
  "use strict";

  const API_VERSION = "2022-11-28";
  const MANIFEST_SCHEMA = "plannotate.github/v1";
  const UTF8 = new TextDecoder("utf-8", { fatal: true });
  const PLAN_KEY_PATTERN = /^[A-Za-z0-9._\-一-鿿]+(?:\/[A-Za-z0-9._\-一-鿿]+){1,4}$/;
  const SHA256_PATTERN = /^[0-9a-f]{64}$/;
  const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
  const MAX_MANIFEST_BYTES = 1024 * 1024;
  const MAX_SIDECAR_BYTES = 4 * 1024 * 1024;
  const ANCHOR_ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;
  const BLOCK_HASH_PATTERN = /^[0-9a-f]{8}$/;
  const OWNER_PATTERN = /^[A-Za-z0-9_.-]+$/;
  const COMMENTABLE_TAGS = new Set([
    "h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "pre",
    "blockquote", "tr", "figcaption", "dt", "dd", "img", "svg", "canvas",
  ]);
  const THREADS_QUERY = `
query PlannotateThreads($owner:String!,$repo:String!,$number:Int!,$after:String) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(first:100,after:$after) {
        nodes {
          id isResolved isOutdated path line subjectType
          viewerCanReply viewerCanResolve viewerCanUnresolve
          comments(first:100) {
            nodes {
              id databaseId body createdAt url author { login }
              viewerCanDelete replyTo { databaseId }
            }
            pageInfo { hasNextPage }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

  function parsePullUrl(value) {
    const match = String(value || "").match(
      /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)(?:[/?#].*)?$/
    );
    if (!match) throw new Error("当前页面不是 GitHub pull request");
    return { owner: match[1], repo: match[2], number: Number(match[3]) };
  }

  function tokenTemplateUrl(owner) {
    const query = new URLSearchParams({
      name: "Plannotate review",
      description: "Read versioned plans and write review threads in GitHub pull requests",
      expires_in: "90",
      contents: "read",
      pull_requests: "write",
    });
    if (typeof owner === "string" && OWNER_PATTERN.test(owner)) {
      query.set("target_name", owner);
    }
    return "https://github.com/settings/personal-access-tokens/new?" + query;
  }

  function permissionHelp(error, ref) {
    const message = String(error && error.message || error || "");
    const status = Number(error && error.status) || 0;
    const repository = ref && ref.owner && ref.repo
      ? ref.owner + "/" + ref.repo : "目标仓库";
    const owner = ref && ref.owner ? ref.owner : "仓库所有者";
    const invalid = status === 401 || /bad credentials|requires authentication/i.test(message);
    const denied = status === 403
      || /resource not accessible by personal access token|saml|forbidden/i.test(message);
    if (!invalid && !denied) return null;
    if (invalid) {
      return {
        title: "GitHub token 无效或已过期",
        summary: "GitHub 拒绝了当前 token。请重新创建并保存一个 fine-grained token。",
        steps: [
          "Resource owner：" + owner,
          "Repository access：包含 " + repository,
          "Repository permissions：Contents = Read-only；Pull requests = Read and write",
        ],
        tokenUrl: tokenTemplateUrl(ref && ref.owner),
      };
    }
    return {
      title: "当前 token 没有 PR review 写权限",
      summary: "它可能能读取 plan，但不能在 " + repository + " 回复、解决或创建 review thread。",
      steps: [
        "Resource owner 必须选择 " + owner,
        "Repository access 必须包含 " + repository,
        "Repository permissions 中 Pull requests 必须是 Read and write，不是 Read-only",
        "组织仓库还要确认 token 已获管理员批准；启用 SSO 时需完成授权",
      ],
      tokenUrl: tokenTemplateUrl(ref && ref.owner),
    };
  }

  function validPlanKey(value) {
    if (typeof value !== "string" || !PLAN_KEY_PATTERN.test(value)) return false;
    return value.split("/").every((segment) => segment !== "." && segment !== "..");
  }

  function discoverPlanKeys(files) {
    const result = new Set();
    (files || []).forEach((item) => {
      const match = String(item.filename || "").match(
        /^\.plannotate\/(.+)\/manifest\.json$/
      );
      if (match && validPlanKey(match[1])) result.add(match[1]);
    });
    return Array.from(result).sort();
  }

  function bytesToHex(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map((value) => value.toString(16).padStart(2, "0")).join("");
  }

  async function sha256(bytes) {
    let buffer = bytes;
    if (ArrayBuffer.isView(bytes)) {
      buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    if (!(buffer instanceof ArrayBuffer)) throw new Error("SHA-256 input must be bytes");
    return bytesToHex(await crypto.subtle.digest("SHA-256", buffer));
  }

  function artifactPath(planKey, version) {
    return ".plannotate/" + planKey + "/v" + String(version).padStart(4, "0") + ".html";
  }

  function anchorsPath(planKey, version) {
    return ".plannotate/" + planKey + "/v" + String(version).padStart(4, "0")
      + ".anchors.json";
  }

  function validateManifest(manifest, planKey) {
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
        || manifest.schema !== MANIFEST_SCHEMA || manifest.plan_key !== planKey) {
      throw new Error("manifest schema 或 plan_key 不匹配");
    }
    const versions = manifest.versions;
    if (!Number.isInteger(manifest.latest) || manifest.latest < 1
        || !Array.isArray(versions) || versions.length !== manifest.latest) {
      throw new Error("manifest latest/versions 不一致");
    }
    versions.forEach((record, index) => {
      const version = index + 1;
      if (!record || typeof record !== "object" || record.version !== version) {
        throw new Error("manifest 版本必须连续且有序");
      }
      if (record.artifact_path !== artifactPath(planKey, version)
          || record.anchors_path !== anchorsPath(planKey, version)) {
        throw new Error("manifest 版本路径不是规范路径");
      }
      if (!SHA256_PATTERN.test(record.artifact_sha256)
          || !SHA256_PATTERN.test(record.anchors_sha256)) {
        throw new Error("manifest SHA-256 非法");
      }
      if (typeof record.created_at !== "string" || !record.created_at) {
        throw new Error("manifest created_at 非法");
      }
    });
    return manifest;
  }

  function validateAnchors(documentValue, planKey, record) {
    if (!documentValue || typeof documentValue !== "object" || Array.isArray(documentValue)
        || documentValue.schema !== MANIFEST_SCHEMA) {
      throw new Error("anchor sidecar schema 非法");
    }
    const expected = {
      plan_key: planKey,
      version: record.version,
      artifact_path: record.artifact_path,
      artifact_sha256: record.artifact_sha256,
    };
    Object.keys(expected).forEach((name) => {
      if (documentValue[name] !== expected[name]) {
        throw new Error("anchor sidecar " + name + " 与 manifest 不一致");
      }
    });
    if (!Array.isArray(documentValue.anchors)) throw new Error("anchors 必须是数组");
    const identifiers = new Set();
    documentValue.anchors.forEach((anchor, index) => {
      if (!anchor || typeof anchor !== "object" || anchor.index !== index
          || !COMMENTABLE_TAGS.has(anchor.tag)) {
        throw new Error("anchor sidecar 第 " + index + " 项结构非法");
      }
      if (!Number.isInteger(anchor.line) || anchor.line < 1
          || typeof anchor.anchor_id !== "string"
          || !ANCHOR_ID_PATTERN.test(anchor.anchor_id)
          || identifiers.has(anchor.anchor_id)
          || typeof anchor.block_hash !== "string"
          || !BLOCK_HASH_PATTERN.test(anchor.block_hash)
          || anchor.legacy_block_id !== "b" + index + "-" + anchor.block_hash
          || typeof anchor.quote !== "string" || Array.from(anchor.quote).length > 300
          || typeof anchor.heading_path !== "string"
          || Array.from(anchor.heading_path).length > 200) {
        throw new Error("anchor sidecar 第 " + index + " 项字段非法");
      }
      identifiers.add(anchor.anchor_id);
    });
    return documentValue;
  }

  function commentText(value, maximum) {
    if (typeof value !== "string" || !value.trim()) throw new Error("评论正文不能为空");
    if (Array.from(value).length > maximum) {
      throw new Error("评论正文不能超过 " + maximum + " 字符");
    }
    return value.trim();
  }

  function limitBytes(buffer, maximum, label) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > maximum) {
      throw new Error(label + " 超过大小限制");
    }
    return buffer;
  }

  class GitHubApi {
    constructor(token, options) {
      const config = options || {};
      if (!token) throw new Error("请先配置 GitHub token");
      this.token = token;
      this.apiUrl = (config.apiUrl || "https://api.github.com").replace(/\/$/, "");
      this.graphqlUrl = config.graphqlUrl || "https://api.github.com/graphql";
      this.fetch = config.fetchImpl || fetch.bind(globalThis);
    }

    headers(accept) {
      return {
        Accept: accept || "application/vnd.github+json",
        Authorization: "Bearer " + this.token,
        "X-GitHub-Api-Version": API_VERSION,
      };
    }

    async request(method, path, body, accept) {
      const headers = this.headers(accept);
      const options = { method, headers };
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(body);
      }
      const url = path.startsWith("http") ? path : this.apiUrl + path;
      const response = await this.fetch(url, options);
      if (!response.ok) {
        let message = await response.text();
        try { message = JSON.parse(message).message || message; } catch (_error) { /* text */ }
        const error = new Error("GitHub HTTP " + response.status + ": " + message);
        error.name = "GitHubApiError";
        error.status = response.status;
        error.apiMessage = message;
        error.acceptedPermissions = response.headers.get("x-accepted-github-permissions") || "";
        throw error;
      }
      return response;
    }

    async json(method, path, body) {
      return (await this.request(method, path, body)).json();
    }

    async graphql(query, variables) {
      const response = await this.fetch(this.graphqlUrl, {
        method: "POST",
        headers: Object.assign(this.headers(), { "Content-Type": "application/json" }),
        body: JSON.stringify({ query, variables }),
      });
      let payload;
      try { payload = await response.json(); } catch (_error) {
        throw new Error("GitHub GraphQL 返回了无效 JSON");
      }
      if (!response.ok) throw new Error("GitHub GraphQL HTTP " + response.status);
      if (payload.errors) {
        const error = new Error(payload.errors.map((item) => item.message).join("; "));
        error.name = "GitHubGraphqlError";
        error.status = payload.errors.some(
          (item) => /resource not accessible|forbidden/i.test(item.message || "")
        ) ? 403 : 0;
        error.graphqlErrors = payload.errors;
        throw error;
      }
      return payload.data;
    }

    pullPath(ref) {
      return "/repos/" + ref.owner + "/" + ref.repo + "/pulls/" + ref.number;
    }

    async getPull(ref) { return this.json("GET", this.pullPath(ref)); }

    async getAuthenticatedUser() { return this.json("GET", "/user"); }

    async getRepository(ref) {
      return this.json("GET", "/repos/" + ref.owner + "/" + ref.repo);
    }

    async listPullFiles(ref) {
      const result = [];
      for (let page = 1; page <= 30; page += 1) {
        const batch = await this.json(
          "GET", this.pullPath(ref) + "/files?per_page=100&page=" + page
        );
        result.push(...batch);
        if (batch.length < 100) return result;
      }
      throw new Error("PR 文件超过 GitHub API 的 3000 文件窗口");
    }

    async getContentBytes(ref, path, commitSha) {
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const endpoint = "/repos/" + ref.owner + "/" + ref.repo + "/contents/"
        + encoded + "?ref=" + encodeURIComponent(commitSha);
      const response = await this.request(
        "GET", endpoint, undefined, "application/vnd.github.raw+json"
      );
      return response.arrayBuffer();
    }

    async getContentText(ref, path, commitSha) {
      return UTF8.decode(await this.getContentBytes(ref, path, commitSha));
    }

    async listReviewThreads(ref) {
      const result = [];
      let after = null;
      const seen = new Set();
      while (true) {
        const data = await this.graphql(THREADS_QUERY, {
          owner: ref.owner, repo: ref.repo, number: ref.number, after,
        });
        const pull = data.repository && data.repository.pullRequest;
        if (!pull) throw new Error("PR 不存在或当前 token 无权访问");
        const connection = pull.reviewThreads;
        connection.nodes.forEach((thread) => {
          if (thread.comments.pageInfo.hasNextPage) {
            throw new Error("单条 review thread 超过 100 条回复");
          }
          result.push(Object.assign({}, thread, { comments: thread.comments.nodes }));
        });
        if (!connection.pageInfo.hasNextPage) return result;
        after = connection.pageInfo.endCursor;
        if (typeof after !== "string" || !after || seen.has(after)) {
          throw new Error("GitHub review thread 分页游标非法");
        }
        seen.add(after);
      }
    }

    async createReviewComment(ref, payload) {
      const body = {
        body: commentText(payload.body, 65536),
        commit_id: payload.commitSha,
        path: payload.path,
      };
      if (payload.fileLevel) body.subject_type = "file";
      else Object.assign(body, { line: payload.line, side: "RIGHT" });
      return this.json("POST", this.pullPath(ref) + "/comments", body);
    }

    async replyThread(threadId, body) {
      if (typeof threadId !== "string" || !threadId || threadId.length > 200) {
        throw new Error("thread id 非法");
      }
      const query = `mutation Reply($thread:ID!,$body:String!) {
        addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}) {
          comment { id databaseId body createdAt url author { login } }
        }
      }`;
      return this.graphql(query, { thread: threadId, body: commentText(body, 4000) });
    }

    async resolveThread(threadId) {
      return this.graphql(
        "mutation Resolve($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id isResolved}}}",
        { thread: threadId }
      );
    }

    async reopenThread(threadId) {
      return this.graphql(
        "mutation Reopen($thread:ID!){unresolveReviewThread(input:{threadId:$thread}){thread{id isResolved}}}",
        { thread: threadId }
      );
    }

    async deleteComment(commentId) {
      return this.graphql(
        "mutation Delete($comment:ID!){deletePullRequestReviewComment(input:{id:$comment}){clientMutationId}}",
        { comment: commentId }
      );
    }
  }

  async function loadBundle(api, ref, planKey, requestedVersion) {
    if (!validPlanKey(planKey)) throw new Error("plan key 非法");
    const pull = await api.getPull(ref);
    const headSha = pull.head && pull.head.sha;
    if (!headSha) throw new Error("PR 缺少 head SHA");
    const manifestPath = ".plannotate/" + planKey + "/manifest.json";
    const manifestBuffer = limitBytes(
      await api.getContentBytes(ref, manifestPath, headSha),
      MAX_MANIFEST_BYTES, "manifest"
    );
    const manifest = validateManifest(JSON.parse(UTF8.decode(manifestBuffer)), planKey);
    if (requestedVersion !== undefined
        && (!Number.isInteger(requestedVersion) || requestedVersion < 1)) {
      throw new Error("版本必须是正整数");
    }
    const versionNumber = requestedVersion || manifest.latest;
    const version = manifest.versions.find((item) => item.version === versionNumber);
    if (!version) throw new Error("版本不存在：" + versionNumber);
    let [artifactBuffer, anchorBuffer] = await Promise.all([
      api.getContentBytes(ref, version.artifact_path, headSha),
      api.getContentBytes(ref, version.anchors_path, headSha),
    ]);
    artifactBuffer = limitBytes(artifactBuffer, MAX_ARTIFACT_BYTES, "artifact");
    anchorBuffer = limitBytes(anchorBuffer, MAX_SIDECAR_BYTES, "anchor sidecar");
    const [digest, anchorsDigest] = await Promise.all([
      sha256(artifactBuffer), sha256(anchorBuffer),
    ]);
    if (anchorsDigest !== version.anchors_sha256) {
      throw new Error("anchor sidecar SHA-256 与 manifest 不一致");
    }
    const anchors = validateAnchors(
      JSON.parse(UTF8.decode(anchorBuffer)), planKey, version
    );
    if (digest !== version.artifact_sha256 || anchors.artifact_sha256 !== digest) {
      throw new Error("artifact、manifest 与 anchor sidecar 的 SHA-256 不一致");
    }
    return {
      pull, headSha, manifest, version, anchors,
      html: UTF8.decode(artifactBuffer),
    };
  }

  function normalizeThreads(threads, planKey, manifest) {
    const versions = new Map((manifest && manifest.versions || []).map(
      (item) => [item.version, item]
    ));
    const result = [];
    (threads || []).forEach((thread) => {
      const comments = thread.comments || [];
      const rootComment = comments.find((item) => !item.replyTo);
      if (!rootComment) return;
      const parsed = protocol.parseCommentBody(rootComment.body);
      if (!parsed || parsed.metadata.plan_key !== planKey) return;
      if (thread.path !== parsed.metadata.artifact_path) {
        throw new Error("Plannotate thread path 与 metadata 不一致：" + thread.id);
      }
      if (manifest) {
        const version = versions.get(parsed.metadata.version);
        if (!version || version.artifact_path !== parsed.metadata.artifact_path
            || version.artifact_sha256 !== parsed.metadata.artifact_sha256) {
          throw new Error("Plannotate thread 不属于 manifest 中的 artifact：" + thread.id);
        }
      }
      result.push({
        threadId: thread.id,
        isResolved: Boolean(thread.isResolved),
        isOutdated: Boolean(thread.isOutdated),
        path: thread.path,
        line: thread.line,
        subjectType: thread.subjectType,
        permissions: {
          reply: Boolean(thread.viewerCanReply),
          resolve: Boolean(thread.viewerCanResolve),
          reopen: Boolean(thread.viewerCanUnresolve),
          delete: Boolean(rootComment.viewerCanDelete),
        },
        metadata: parsed.metadata,
        body: parsed.body,
        root: rootComment,
        replies: comments.filter((item) => item !== rootComment),
      });
    });
    return result;
  }

  return Object.freeze({
    GitHubApi,
    discoverPlanKeys,
    loadBundle,
    normalizeThreads,
    parsePullUrl,
    permissionHelp,
    sha256,
    tokenTemplateUrl,
    validateAnchors,
    validateManifest,
    validPlanKey,
  });
}));
