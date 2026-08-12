(function () {
  "use strict";

  const protocol = window.PlannotateProtocol;
  const github = window.PlannotateGitHub;
  const elements = {
    status: document.getElementById("status"),
    authPanel: document.getElementById("auth-panel"),
    authTitle: document.getElementById("auth-title"),
    authMessage: document.getElementById("auth-message"),
    authSteps: document.getElementById("auth-steps"),
    authCreateToken: document.getElementById("auth-create-token"),
    plan: document.getElementById("plan-select"),
    version: document.getElementById("version-select"),
    iframe: document.getElementById("sandbox"),
    carryoverSection: document.getElementById("carryover-section"),
    carryoverList: document.getElementById("carryover-list"),
    refresh: document.getElementById("refresh"),
    general: document.getElementById("general-comment"),
    closeEmbedded: document.getElementById("close-embedded"),
  };
  const query = new URLSearchParams(location.search);
  const ref = {
    owner: query.get("owner"), repo: query.get("repo"), number: Number(query.get("pull")),
  };
  const channel = crypto.randomUUID();
  const state = {
    api: null, planKeys: [], planKey: null, bundle: null,
    allThreads: [], records: [], sandboxReady: false,
  };

  function setStatus(message, error) {
    elements.status.textContent = message || "";
    elements.status.classList.toggle("error", Boolean(error));
  }

  function showAuthHelp(help) {
    elements.authTitle.textContent = help.title;
    elements.authMessage.textContent = help.summary;
    elements.authSteps.replaceChildren(...help.steps.map((value) => {
      const item = document.createElement("li");
      item.textContent = value;
      return item;
    }));
    elements.authCreateToken.href = help.tokenUrl;
    elements.authPanel.hidden = false;
  }

  function hideAuthHelp() {
    elements.authPanel.hidden = true;
  }

  function reportError(error) {
    const help = github.permissionHelp(error, ref);
    if (help) {
      showAuthHelp(help);
      setStatus(help.summary, true);
      return help.summary;
    }
    setStatus(error.message, true);
    return error.message;
  }

  function missingTokenHelp() {
    return {
      title: "尚未配置 GitHub token",
      summary: "Plannotate 需要代表你读取 plan，并写入 GitHub 原生 PR review thread。",
      steps: [
        "Resource owner：" + ref.owner,
        "Repository access：包含 " + ref.owner + "/" + ref.repo,
        "Contents = Read-only；Pull requests = Read and write；Metadata = Read-only",
      ],
      tokenUrl: github.tokenTemplateUrl(ref.owner),
    };
  }

  async function rememberContext() {
    await chrome.storage.local.set({ lastPullContext: ref });
  }

  async function openSettings() {
    try { await rememberContext(); } catch (_error) { /* settings still opens */ }
    await chrome.runtime.openOptionsPage();
  }

  function validRef() {
    return ref.owner && ref.repo && Number.isInteger(ref.number) && ref.number > 0;
  }

  function option(value, label) {
    const item = document.createElement("option");
    item.value = String(value);
    item.textContent = label;
    return item;
  }

  async function init() {
    if (!validRef()) return setStatus("缺少有效的 GitHub PR 上下文。", true);
    if (query.get("embedded") === "1") {
      document.body.classList.add("embedded");
      elements.closeEmbedded.hidden = false;
    }
    const prUrl = "https://github.com/" + ref.owner + "/" + ref.repo + "/pull/" + ref.number;
    const link = document.getElementById("pr-link");
    link.href = prUrl;
    link.textContent = ref.owner + "/" + ref.repo + "#" + ref.number;
    rememberContext().catch(() => {});
    elements.iframe.src = chrome.runtime.getURL("sandbox.html")
      + "?channel=" + encodeURIComponent(channel);
    const values = await chrome.storage.local.get(["githubToken"]);
    if (!values.githubToken) {
      showAuthHelp(missingTokenHelp());
      elements.iframe.hidden = true;
      return setStatus("尚未配置 GitHub token。", true);
    }
    state.api = new github.GitHubApi(values.githubToken);
    await loadPlans();
  }

  async function loadPlans() {
    try {
      setStatus("正在读取 PR 文件…");
      state.planKeys = github.discoverPlanKeys(await state.api.listPullFiles(ref));
      if (!state.planKeys.length) throw new Error("该 PR 没有 .plannotate manifest");
      elements.plan.replaceChildren(...state.planKeys.map((key) => option(key, key)));
      elements.plan.disabled = false;
      state.planKey = state.planKeys[0];
      await loadBundle();
    } catch (error) {
      reportError(error);
    }
  }

  async function loadBundle(requestedVersion) {
    try {
      elements.refresh.disabled = true;
      elements.general.disabled = true;
      setStatus("正在校验 artifact 与评论…");
      state.bundle = await github.loadBundle(
        state.api, ref, state.planKey, requestedVersion
      );
      elements.version.replaceChildren(...state.bundle.manifest.versions
        .slice().reverse().map((item) => option(
          item.version,
          "v" + String(item.version).padStart(4, "0")
            + (item.version === state.bundle.manifest.latest ? "（最新）" : "")
        )));
      elements.version.value = String(state.bundle.version.version);
      elements.version.disabled = false;
      await refreshThreads();
      elements.refresh.disabled = false;
      elements.general.disabled = false;
    } catch (error) {
      reportError(error);
    }
  }

  async function refreshThreads() {
    state.allThreads = await state.api.listReviewThreads(ref);
    state.records = github.normalizeThreads(
      state.allThreads, state.planKey, state.bundle.manifest
    );
    renderCarryover();
    sendRender();
    const open = state.records.filter((item) => !item.isResolved).length;
    setStatus(
      "已验证 " + state.bundle.version.artifact_path + " · 未解决 " + open
        + " / 总计 " + state.records.length
    );
    hideAuthHelp();
  }

  function currentThreads() {
    return state.records.filter(isCurrentArtifact);
  }

  function isCurrentArtifact(record) {
    const version = state.bundle.version;
    return record.metadata.version === version.version
      && record.metadata.artifact_path === version.artifact_path
      && record.metadata.artifact_sha256 === version.artifact_sha256;
  }

  function sendRender() {
    if (!state.sandboxReady || !state.bundle) return;
    elements.iframe.contentWindow.postMessage({
      source: "plannotate-parent", channel, type: "render",
      html: state.bundle.html,
      anchors: state.bundle.anchors.anchors,
      threads: currentThreads(),
    }, "*");
  }

  function makeButton(text, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.addEventListener("click", action);
    return button;
  }

  function renderCarryover() {
    const selected = state.bundle.version.version;
    const items = state.records.filter(
      (item) => !item.isResolved && !isCurrentArtifact(item)
    );
    elements.carryoverSection.hidden = !items.length;
    elements.carryoverList.replaceChildren(...items.map((record) => {
      const card = document.createElement("article");
      card.className = "carryover-card";
      const meta = document.createElement("div");
      meta.className = "carryover-meta";
      meta.textContent = "v" + String(record.metadata.version).padStart(4, "0")
        + (record.metadata.version === selected ? " · artifact 不匹配" : "")
        + " · " + (record.metadata.general ? "总体意见" : record.metadata.quote);
      const body = document.createElement("p");
      body.textContent = record.body;
      const actions = document.createElement("div");
      actions.className = "carryover-actions";
      if (record.permissions.reply) {
        const input = document.createElement("textarea");
        input.rows = 2;
        input.maxLength = 4000;
        input.placeholder = "回复旧版本线程…";
        const reply = makeButton("回复", async () => {
          if (!input.value.trim()) return;
          input.disabled = true;
          reply.disabled = true;
          await replyInline(record, input.value.trim());
        });
        actions.append(input, reply);
      }
      if (record.permissions.resolve) {
        actions.appendChild(makeButton("解决", () => mutateThread("resolve", record)));
      }
      card.append(meta, body, actions);
      return card;
    }));
  }

  function commentMetadata(request) {
    const version = state.bundle.version;
    const anchor = request.anchor;
    return {
      schema: protocol.SCHEMA,
      plan_key: state.planKey,
      version: version.version,
      artifact_path: version.artifact_path,
      artifact_sha256: version.artifact_sha256,
      general: Boolean(request.general),
      anchor_id: anchor ? anchor.anchorId : null,
      line: anchor ? anchor.line : null,
      block_index: anchor ? anchor.index : null,
      block_hash: anchor ? anchor.hash : null,
      quote: anchor ? anchor.quote : "",
      heading_path: anchor ? anchor.headingPath : "",
      selection: request.selection || null,
    };
  }

  async function createComment(request, body) {
    if (!body.trim() || !request || !state.bundle) return;
    try {
      const metadata = commentMetadata(request);
      await state.api.createReviewComment(ref, {
        body: protocol.buildCommentBody(body, metadata),
        commitSha: state.bundle.headSha,
        path: state.bundle.version.artifact_path,
        line: metadata.line,
        fileLevel: metadata.general,
      });
      await refreshThreads();
    } catch (error) {
      sendSandboxComposerError(reportError(error));
    }
  }

  async function mutateThread(action, record, notifySandbox) {
    try {
      if (action === "resolve") await state.api.resolveThread(record.threadId);
      else if (action === "reopen") await state.api.reopenThread(record.threadId);
      else if (action === "delete") await state.api.deleteComment(record.root.id);
      await refreshThreads();
    } catch (error) {
      const message = reportError(error);
      if (notifySandbox) sendSandboxMutationError(record.threadId, message);
    }
  }

  async function replyInline(record, body) {
    try {
      await state.api.replyThread(record.threadId, body);
      await refreshThreads();
    } catch (error) {
      sendSandboxMutationError(record.threadId, reportError(error));
    }
  }

  function sendSandboxMutationError(threadId, message) {
    if (!state.sandboxReady) return;
    elements.iframe.contentWindow.postMessage({
      source: "plannotate-parent", channel, type: "mutation-error",
      threadId, message,
    }, "*");
  }

  function sendSandboxComposerError(message) {
    if (!state.sandboxReady) return;
    elements.iframe.contentWindow.postMessage({
      source: "plannotate-parent", channel, type: "compose-error", message,
    }, "*");
  }

  function findRecord(threadId) {
    return state.records.find((item) => item.threadId === threadId);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== elements.iframe.contentWindow) return;
    const message = event.data || {};
    if (message.source !== "plannotate-sandbox" || message.channel !== channel) return;
    if (message.type === "ready") {
      state.sandboxReady = true;
      sendRender();
    } else if (message.type === "comment") {
      createComment(message.request, message.body || "");
    } else if (message.type === "reply") {
      const record = findRecord(message.threadId);
      if (record) replyInline(record, message.body || "");
    } else if (["resolve", "reopen", "delete"].includes(message.type)) {
      const record = findRecord(message.threadId);
      if (record) mutateThread(message.type, record, true);
    }
  });

  elements.plan.addEventListener("change", async () => {
    state.planKey = elements.plan.value;
    await loadBundle();
  });
  elements.version.addEventListener("change", () => loadBundle(Number(elements.version.value)));
  elements.refresh.addEventListener("click", () => loadBundle(
    Number(elements.version.value) || undefined
  ));
  elements.general.addEventListener(
    "click", () => elements.iframe.contentWindow.postMessage({
      source: "plannotate-parent", channel, type: "open-composer",
      request: { general: true, anchor: null, selection: null },
    }, "*")
  );
  document.getElementById("open-settings").addEventListener(
    "click", () => openSettings().catch((error) => setStatus(error.message, true))
  );
  document.getElementById("auth-settings").addEventListener(
    "click", () => openSettings().catch((error) => setStatus(error.message, true))
  );
  elements.closeEmbedded.addEventListener("click", () => {
    parent.postMessage({ source: "plannotate-viewer", type: "close" }, "*");
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.githubToken) return;
    const token = changes.githubToken.newValue;
    if (!token) {
      state.api = null;
      elements.iframe.hidden = true;
      showAuthHelp(missingTokenHelp());
      setStatus("GitHub token 已清除。", true);
      return;
    }
    state.api = new github.GitHubApi(token);
    elements.iframe.hidden = false;
    loadPlans();
  });

  init().catch((error) => reportError(error));
}());
