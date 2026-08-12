(function () {
  "use strict";

  const protocol = window.PlannotateProtocol;
  const github = window.PlannotateGitHub;
  const elements = {
    status: document.getElementById("status"),
    authPanel: document.getElementById("auth-panel"),
    plan: document.getElementById("plan-select"),
    version: document.getElementById("version-select"),
    iframe: document.getElementById("sandbox"),
    carryoverSection: document.getElementById("carryover-section"),
    carryoverList: document.getElementById("carryover-list"),
    dialog: document.getElementById("composer"),
    dialogTitle: document.getElementById("composer-title"),
    dialogQuote: document.getElementById("composer-quote"),
    dialogBody: document.getElementById("composer-body"),
    dialogError: document.getElementById("composer-error"),
    dialogSubmit: document.getElementById("composer-submit"),
    refresh: document.getElementById("refresh"),
    general: document.getElementById("general-comment"),
  };
  const query = new URLSearchParams(location.search);
  const ref = {
    owner: query.get("owner"), repo: query.get("repo"), number: Number(query.get("pull")),
  };
  const channel = crypto.randomUUID();
  const state = {
    api: null, planKeys: [], planKey: null, bundle: null,
    allThreads: [], records: [], sandboxReady: false, composer: null,
  };

  function setStatus(message, error) {
    elements.status.textContent = message || "";
    elements.status.classList.toggle("error", Boolean(error));
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
    const prUrl = "https://github.com/" + ref.owner + "/" + ref.repo + "/pull/" + ref.number;
    const link = document.getElementById("pr-link");
    link.href = prUrl;
    link.textContent = ref.owner + "/" + ref.repo + "#" + ref.number;
    elements.iframe.src = chrome.runtime.getURL("sandbox.html")
      + "?channel=" + encodeURIComponent(channel);
    const values = await chrome.storage.local.get(["githubToken"]);
    if (!values.githubToken) {
      elements.authPanel.hidden = false;
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
      setStatus(error.message, true);
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
      setStatus(error.message, true);
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
        actions.appendChild(makeButton("回复", () => openReply(record)));
      }
      if (record.permissions.resolve) {
        actions.appendChild(makeButton("解决", () => mutateThread("resolve", record)));
      }
      card.append(meta, body, actions);
      return card;
    }));
  }

  function openComposer(request) {
    if (!state.bundle) return setStatus("plan artifact 尚未加载完成。", true);
    state.composer = { type: "comment", request };
    elements.dialogTitle.textContent = request.general ? "发表总体意见" : "评论此处";
    const selection = request.selection && "\n高亮：“" + request.selection.text + "”";
    elements.dialogQuote.textContent = request.general
      ? "针对当前版本的总体意见"
      : "块：" + request.anchor.quote + (selection || "");
    elements.dialogBody.value = "";
    elements.dialogError.textContent = "";
    elements.dialog.showModal();
    elements.dialogBody.focus();
  }

  function openReply(record) {
    state.composer = { type: "reply", record };
    elements.dialogTitle.textContent = "回复线程";
    elements.dialogQuote.textContent = record.body;
    elements.dialogBody.value = "";
    elements.dialogError.textContent = "";
    elements.dialog.showModal();
    elements.dialogBody.focus();
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

  async function submitComposer() {
    const body = elements.dialogBody.value;
    if (!body.trim() || !state.composer) return;
    elements.dialogSubmit.disabled = true;
    elements.dialogError.textContent = "";
    try {
      if (state.composer.type === "reply") {
        await state.api.replyThread(state.composer.record.threadId, body.trim());
      } else {
        const request = state.composer.request;
        const metadata = commentMetadata(request);
        await state.api.createReviewComment(ref, {
          body: protocol.buildCommentBody(body, metadata),
          commitSha: state.bundle.headSha,
          path: state.bundle.version.artifact_path,
          line: metadata.line,
          fileLevel: metadata.general,
        });
      }
      elements.dialog.close();
      state.composer = null;
      await refreshThreads();
    } catch (error) {
      elements.dialogError.textContent = error.message;
    } finally {
      elements.dialogSubmit.disabled = false;
    }
  }

  async function mutateThread(action, record, notifySandbox) {
    try {
      if (action === "resolve") await state.api.resolveThread(record.threadId);
      else if (action === "reopen") await state.api.reopenThread(record.threadId);
      else if (action === "delete") await state.api.deleteComment(record.root.id);
      await refreshThreads();
    } catch (error) {
      setStatus(error.message, true);
      if (notifySandbox) sendSandboxMutationError(record.threadId, error.message);
    }
  }

  async function replyInline(record, body) {
    try {
      await state.api.replyThread(record.threadId, body);
      await refreshThreads();
    } catch (error) {
      setStatus(error.message, true);
      sendSandboxMutationError(record.threadId, error.message);
    }
  }

  function sendSandboxMutationError(threadId, message) {
    if (!state.sandboxReady) return;
    elements.iframe.contentWindow.postMessage({
      source: "plannotate-parent", channel, type: "mutation-error",
      threadId, message,
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
    } else if (message.type === "compose") {
      openComposer(message);
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
    "click", () => openComposer({ general: true, anchor: null, selection: null })
  );
  document.getElementById("open-settings").addEventListener(
    "click", () => chrome.runtime.openOptionsPage()
  );
  document.getElementById("auth-settings").addEventListener(
    "click", () => chrome.runtime.openOptionsPage()
  );
  document.getElementById("composer-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitComposer();
  });
  ["composer-close", "composer-cancel"].forEach((id) => {
    document.getElementById(id).addEventListener("click", () => {
      state.composer = null;
      elements.dialog.close();
    });
  });

  init().catch((error) => setStatus(error.message, true));
}());
