(function () {
  "use strict";

  function normalizedTag(element) {
    return String(element && element.tagName || "").toUpperCase();
  }

  if (typeof module === "object" && module.exports) {
    module.exports = { normalizedTag };
    return;
  }

  const channel = new URLSearchParams(location.search).get("channel");
  const BLOCK_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,tr,figcaption,dt,dd,img,svg,canvas";
  const MEDIA = new Set(["IMG", "SVG", "CANVAS"]);
  const FORBIDDEN = "script,iframe,object,embed,base,form,link,meta";
  const planRoot = document.getElementById("prg-plan");
  const errorBox = document.getElementById("prg-error");
  const addButton = document.getElementById("prg-add");
  const selectionButton = document.getElementById("prg-selection");
  const reviewRail = document.getElementById("prg-review-rail");
  const railThreads = document.getElementById("prg-rail-threads");
  const railEmpty = document.getElementById("prg-rail-empty");
  const railCount = document.getElementById("prg-rail-count");
  const composer = document.getElementById("prg-composer");
  const composerTitle = document.getElementById("prg-composer-title");
  const composerQuote = document.getElementById("prg-composer-quote");
  const composerBody = document.getElementById("prg-composer-body");
  const composerError = document.getElementById("prg-composer-error");
  const state = {
    blocks: [], blockByElement: new WeakMap(), hover: null,
    selection: null, threads: [], anchors: [], composerRequest: null,
  };

  function post(type, payload) {
    parent.postMessage(Object.assign({
      source: "plannotate-sandbox", channel, type,
    }, payload || {}), "*");
  }

  function showError(message) {
    errorBox.hidden = !message;
    errorBox.textContent = message || "";
  }

  function safeAttribute(element, attribute) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value.trim();
    if (name.startsWith("on") || name === "srcdoc") return false;
    if (name === "id" && value.toLowerCase().startsWith("prg-")) return false;
    if (name === "class" && value.split(/\s+/).some(
      (token) => token.toLowerCase().startsWith("prg-")
    )) return false;
    if (name.startsWith("data-prg-") || name === "data-plannotate-anchor") return false;
    if (name === "href" || name === "action" || name === "formaction") return false;
    if (["src", "poster", "xlink:href"].includes(name)) {
      return !value || value.startsWith("data:") || value.startsWith("#");
    }
    return true;
  }

  function sanitizedDocument(html) {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    parsed.querySelectorAll(FORBIDDEN).forEach((element) => element.remove());
    parsed.querySelectorAll("*").forEach((element) => {
      Array.from(element.attributes).forEach((attribute) => {
        if (!safeAttribute(element, attribute)) element.removeAttribute(attribute.name);
      });
    });
    parsed.querySelectorAll("style").forEach((style) => {
      style.textContent = safeCss(style.textContent);
    });
    return parsed;
  }

  function safeCss(value) {
    const sheet = new CSSStyleSheet();
    try {
      sheet.replaceSync(value);
    } catch (_error) {
      return "";
    }
    return Array.from(sheet.cssRules)
      .filter((rule) => rule.type !== CSSRule.IMPORT_RULE)
      .map((rule) => rule.cssText)
      .join("\n")
      .replace(/url\s*\([^)]*\)/gi, "none")
      .replace(/!\s*important/gi, "");
  }

  function renderHtml(html) {
    const parsed = sanitizedDocument(html);
    document.querySelectorAll("style[data-plan-style]").forEach((item) => item.remove());
    parsed.querySelectorAll("style").forEach((style) => {
      const imported = document.createElement("style");
      imported.dataset.planStyle = "true";
      imported.textContent = "@scope (#prg-plan) to (.prg-ui) {\n"
        + style.textContent + "\n}";
      const reviewStyle = document.querySelector('link[href="sandbox.css"]');
      document.head.insertBefore(imported, reviewStyle);
    });
    const fragment = document.createDocumentFragment();
    Array.from(parsed.body.childNodes).forEach((node) => {
      fragment.appendChild(document.importNode(node, true));
    });
    planRoot.replaceChildren(fragment);
  }

  function normalizeText(value) {
    return value.trim().replace(/\s+/g, " ");
  }

  function fnv1a(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash = Math.imul(hash ^ value.charCodeAt(index), 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  function mediaDetails(element) {
    const tag = normalizedTag(element);
    if (tag === "IMG") {
      const source = element.getAttribute("src") || "";
      const alt = element.getAttribute("alt") || "";
      const clean = source.split(/[?#]/, 1)[0];
      const filename = clean.split("/").filter(Boolean).pop() || "";
      return { input: source + "|" + alt, quote: "[图] " + (alt || filename || "img") };
    }
    if (tag === "SVG") {
      return {
        input: element.outerHTML.replace(/\s+/g, " ").slice(0, 512), quote: "[图] svg",
      };
    }
    return {
      input: "canvas|" + element.width + "|" + element.height, quote: "[图] canvas",
    };
  }

  function scanBlocks(sidecars) {
    const elements = Array.from(planRoot.querySelectorAll(BLOCK_SELECTOR)).filter(
      (element) => MEDIA.has(normalizedTag(element)) || Boolean(normalizeText(element.textContent))
    );
    if (elements.length !== sidecars.length) {
      throw new Error(
        "anchor sidecar 与渲染结果数量不一致：" + sidecars.length + " / " + elements.length
      );
    }
    state.blockByElement = new WeakMap();
    state.blocks = elements.map((element, index) => {
      const sidecar = sidecars[index];
      const tag = normalizedTag(element);
      if (sidecar.index !== index || sidecar.tag.toUpperCase() !== tag) {
        throw new Error("anchor sidecar 在第 " + index + " 个块发生结构漂移");
      }
      const rawText = element.textContent;
      const text = normalizeText(rawText);
      const media = MEDIA.has(tag) ? mediaDetails(element) : null;
      const runtimeHash = fnv1a(media ? media.input : text);
      if (tag !== "SVG" && runtimeHash !== sidecar.block_hash) {
        throw new Error("anchor sidecar 在第 " + index + " 个块发生内容漂移");
      }
      const block = {
        element, index, rawText, text, hash: sidecar.block_hash,
        anchorId: sidecar.anchor_id,
        line: sidecar.line,
        quote: sidecar.quote,
        headingPath: sidecar.heading_path,
        media: Boolean(media),
      };
      element.classList.add("prg-reviewable");
      element.dataset.planReviewAnchor = block.anchorId;
      state.blockByElement.set(element, block);
      return block;
    });
  }

  function clearMarks() {
    Array.from(planRoot.querySelectorAll("mark.prg-selection-mark")).reverse()
      .forEach((mark) => {
        const owner = mark.parentNode;
        while (mark.firstChild) owner.insertBefore(mark.firstChild, mark);
        mark.remove();
        owner.normalize();
      });
  }

  function wrapRange(block, start, end, threadId) {
    const walker = document.createTreeWalker(block.element, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    let cursor = 0;
    nodes.forEach((node) => {
      const originalLength = node.data.length;
      const nodeEnd = cursor + originalLength;
      if (nodeEnd > start && cursor < end) {
        const localStart = Math.max(start, cursor) - cursor;
        const localEnd = Math.min(end, nodeEnd) - cursor;
        let selected = node;
        if (localStart > 0) selected = node.splitText(localStart);
        const length = localEnd - localStart;
        if (selected.data.length > length) selected.splitText(length);
        const mark = document.createElement("mark");
        mark.className = "prg-selection-mark prg-ui";
        selected.parentNode.insertBefore(mark, selected);
        mark.appendChild(selected);
        mark.addEventListener("click", () => scrollToThread(threadId));
      }
      cursor = nodeEnd;
    });
  }

  function alignedSelection(block, selection) {
    if (!selection) return null;
    if (block.rawText.slice(selection.start, selection.end) === selection.text) {
      return { start: selection.start, end: selection.end };
    }
    const start = block.rawText.indexOf(selection.text);
    return start < 0 ? null : { start, end: start + selection.text.length };
  }

  function commonBlock(startNode, endNode) {
    let element = startNode.nodeType === Node.ELEMENT_NODE
      ? startNode : startNode.parentElement;
    while (element && element !== planRoot) {
      const block = state.blockByElement.get(element);
      if (block && element.contains(endNode)) return block;
      element = element.parentElement;
    }
    return null;
  }

  function boundaryOffset(block, container, offset) {
    let total = 0;
    let found = false;
    function visit(node) {
      if (found) return;
      if (node === container) {
        if (node.nodeType === Node.TEXT_NODE) total += Math.min(offset, node.data.length);
        else {
          Array.from(node.childNodes).slice(0, offset)
            .forEach((child) => { total += child.textContent.length; });
        }
        found = true;
        return;
      }
      if (node.nodeType === Node.TEXT_NODE) total += node.data.length;
      else Array.from(node.childNodes).forEach(visit);
    }
    visit(block.element);
    return found ? total : null;
  }

  function captureSelection() {
    const selection = getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const block = commonBlock(range.startContainer, range.endContainer);
    if (!block || block.media) return null;
    const start = boundaryOffset(block, range.startContainer, range.startOffset);
    const end = boundaryOffset(block, range.endContainer, range.endOffset);
    if (start === null || end === null || end <= start) return null;
    const text = block.rawText.slice(start, end);
    if (!text) return null;
    return { block, start, end, text, rect: range.getBoundingClientRect() };
  }

  function threadContainer(block) {
    let group = railThreads.querySelector(
      '.prg-thread-group[data-anchor="' + CSS.escape(block.anchorId) + '"]'
    );
    if (group) return group.querySelector(".prg-thread-container");
    group = document.createElement("section");
    group.className = "prg-thread-group prg-ui";
    group.dataset.anchor = block.anchorId;
    const heading = textElement("button", "prg-thread-group-link", block.quote);
    heading.type = "button";
    heading.addEventListener("click", () => {
      block.element.scrollIntoView({ behavior: "smooth", block: "center" });
      block.element.classList.add("prg-focus-pulse");
      setTimeout(() => block.element.classList.remove("prg-focus-pulse"), 900);
    });
    const container = document.createElement("div");
    container.className = "prg-thread-container prg-ui";
    group.append(heading, container);
    railThreads.appendChild(group);
    return container;
  }

  function author(comment) {
    return comment.author && comment.author.login || "ghost";
  }

  function textElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    return element;
  }

  function actionButton(label, action) {
    const button = textElement("button", "", label);
    button.type = "button";
    button.addEventListener("click", action);
    return button;
  }

  function threadHeader(record) {
    const header = document.createElement("header");
    header.className = "prg-thread-header";
    header.append(
      textElement("span", "prg-thread-author", "@" + author(record.root)),
      textElement(
        "span", "prg-thread-meta",
        (record.isResolved ? "✓ 已解决" : "未解决") + " · "
          + String(record.root.createdAt || "").slice(0, 16).replace("T", " ")
        )
    );
    return header;
  }

  function threadQuote(metadata) {
    if (metadata.general) return null;
    const quote = textElement("div", "prg-thread-quote", "块：" + metadata.quote);
    if (metadata.selection) {
      quote.append(" · ", textElement(
        "span", "prg-thread-highlight", "“" + metadata.selection.text + "”"
      ));
    }
    return quote;
  }

  function appendReplies(card, record) {
    record.replies.forEach((reply) => {
      const item = document.createElement("div");
      item.className = "prg-reply";
      item.append(
        textElement("div", "prg-reply-meta", "↳ @" + author(reply)),
        textElement("div", "prg-reply-body", reply.body || "")
      );
      card.appendChild(item);
    });
  }

  function threadActions(record) {
    const actions = document.createElement("div");
    actions.className = "prg-thread-actions";
    if (record.permissions.reply) {
      const input = document.createElement("textarea");
      input.rows = 1;
      input.placeholder = "回复…";
      const replyButton = actionButton("回复", () => {
        if (!input.value.trim()) return;
        post("reply", { threadId: record.threadId, body: input.value.trim() });
        input.disabled = true;
        replyButton.disabled = true;
      });
      actions.append(input, replyButton);
    }
    if (!record.isResolved && record.permissions.resolve) {
      actions.appendChild(actionButton(
        record.nativeThreadState ? "前往 GitHub 解决" : "解决",
        () => post(
          record.nativeThreadState ? "open-native-thread" : "resolve",
          { threadId: record.threadId }
        )
      ));
    }
    if (record.isResolved && record.permissions.reopen) {
      actions.appendChild(actionButton(
        record.nativeThreadState ? "前往 GitHub 重开" : "重开",
        () => post(
          record.nativeThreadState ? "open-native-thread" : "reopen",
          { threadId: record.threadId }
        )
      ));
    }
    if (record.permissions.delete) {
      actions.appendChild(actionButton("删除", () => {
        if (confirm("删除此 GitHub review comment？")) {
          post("delete", { threadId: record.threadId });
        }
      }));
    }
    return actions;
  }

  function renderThread(record) {
    const card = document.createElement("article");
    card.className = "prg-thread" + (record.isResolved ? " prg-resolved" : "");
    card.id = "prg-thread-" + record.threadId;
    card.appendChild(threadHeader(record));
    const quote = threadQuote(record.metadata);
    if (quote) card.appendChild(quote);
    card.appendChild(textElement("div", "prg-thread-body", record.body));
    appendReplies(card, record);
    card.appendChild(threadActions(record));
    return card;
  }

  function scrollToThread(threadId) {
    const element = document.getElementById("prg-thread-" + threadId);
    if (element) element.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function showThreadError(threadId, message, nativeFallback) {
    const card = document.getElementById("prg-thread-" + threadId);
    if (!card) return showError(message);
    let error = card.querySelector(".prg-thread-error");
    if (!error) {
      error = textElement("div", "prg-thread-error", "");
      card.appendChild(error);
    }
    error.replaceChildren(document.createTextNode(message));
    if (nativeFallback) {
      error.appendChild(actionButton("在 GitHub 打开此线程", () => post(
        "open-native-thread", { threadId }
      )));
    }
    card.querySelectorAll("textarea,button").forEach((control) => {
      control.disabled = false;
    });
  }

  function renderThreads(records) {
    clearMarks();
    railThreads.replaceChildren();
    state.blocks.forEach((block) => block.element.classList.remove("prg-has-open"));
    const general = records.filter((item) => item.metadata.general);
    const generalSection = document.getElementById("prg-general");
    generalSection.hidden = false;
    document.getElementById("prg-general-threads").replaceChildren(
      ...general.map(renderThread)
    );
    const orphans = [];
    records.filter((item) => !item.metadata.general).forEach((record) => {
      const metadata = record.metadata;
      const block = state.blocks.find((item) => item.anchorId === metadata.anchor_id)
        || state.blocks.find((item) => item.hash === metadata.block_hash);
      if (!block) {
        orphans.push(record);
        return;
      }
      if (!record.isResolved) block.element.classList.add("prg-has-open");
      const card = renderThread(record);
      const aligned = alignedSelection(block, metadata.selection);
      if (metadata.selection && !aligned) {
        card.querySelector(".prg-thread-quote").appendChild(
          textElement("span", "prg-stale", " · 选区已失效")
        );
      } else if (aligned) {
        wrapRange(block, aligned.start, aligned.end, record.threadId);
      }
      threadContainer(block).appendChild(card);
    });
    const orphanSection = document.getElementById("prg-orphans");
    orphanSection.hidden = !orphans.length;
    document.getElementById("prg-orphan-threads").replaceChildren(
      ...orphans.map(renderThread)
    );
    railCount.textContent = records.length + " 个线程";
    railEmpty.hidden = Boolean(records.length);
  }

  function positionButton(button, rect, left) {
    button.hidden = false;
    button.style.left = Math.max(4, (left === undefined ? rect.left : left) + scrollX) + "px";
    button.style.top = Math.max(4, rect.top + scrollY) + "px";
  }

  planRoot.addEventListener("mouseover", (event) => {
    let element = event.target;
    while (element && element !== planRoot && !state.blockByElement.has(element)) {
      element = element.parentElement;
    }
    const block = element && state.blockByElement.get(element);
    if (!block) return;
    if (state.hover) state.hover.element.classList.remove("prg-hover");
    state.hover = block;
    block.element.classList.add("prg-hover");
    const rect = block.element.getBoundingClientRect();
    positionButton(addButton, rect, rect.left - 34);
  });

  addButton.addEventListener("click", () => {
    if (!state.hover) return;
    openComposer({ general: false, anchor: serializableBlock(state.hover), selection: null });
  });

  function serializableBlock(block) {
    return {
      index: block.index, anchorId: block.anchorId, line: block.line,
      hash: block.hash, quote: block.quote, headingPath: block.headingPath,
    };
  }

  planRoot.addEventListener("mouseup", () => {
    const captured = captureSelection();
    state.selection = captured;
    if (!captured) {
      selectionButton.hidden = true;
      return;
    }
    positionButton(selectionButton, captured.rect, captured.rect.right + 6);
  });

  selectionButton.addEventListener("click", () => {
    const captured = state.selection;
    if (!captured) return;
    openComposer({
      general: false,
      anchor: serializableBlock(captured.block),
      selection: { start: captured.start, end: captured.end, text: captured.text },
    });
    selectionButton.hidden = true;
  });

  document.getElementById("prg-general-add").addEventListener("click", () => {
    openComposer({ general: true, anchor: null, selection: null });
  });
  document.getElementById("prg-rail-general").addEventListener("click", () => {
    openComposer({ general: true, anchor: null, selection: null });
  });

  function openComposer(request) {
    state.composerRequest = request;
    composerTitle.textContent = request.general ? "发表总体意见" : "评论此处";
    const selection = request.selection && " · 选区：“" + request.selection.text + "”";
    composerQuote.textContent = request.general
      ? "针对当前 plan 版本"
      : "块：" + request.anchor.quote + (selection || "");
    composerBody.value = "";
    composerError.textContent = "";
    composer.hidden = false;
    composerBody.focus();
  }

  function closeComposer() {
    state.composerRequest = null;
    composer.hidden = true;
    composerError.textContent = "";
  }

  function showComposerError(message, pendingReview) {
    composerError.replaceChildren(document.createTextNode(message));
    if (pendingReview) {
      composerError.appendChild(actionButton(
        "新标签页处理未提交 review",
        () => post("open-pending-review")
      ));
    }
  }

  document.getElementById("prg-composer-submit").addEventListener("click", () => {
    if (!state.composerRequest || !composerBody.value.trim()) return;
    post("comment", {
      request: state.composerRequest,
      body: composerBody.value.trim(),
    });
    composerBody.disabled = true;
    document.getElementById("prg-composer-submit").disabled = true;
  });
  ["prg-composer-close", "prg-composer-cancel"].forEach((id) => {
    document.getElementById(id).addEventListener("click", closeComposer);
  });

  window.addEventListener("message", (event) => {
    const message = event.data || {};
    if (event.source !== parent || message.source !== "plannotate-parent"
        || message.channel !== channel) return;
    if (message.type === "mutation-error") {
      showThreadError(
        message.threadId, message.message || "GitHub 操作失败",
        Boolean(message.nativeFallback)
      );
      return;
    }
    if (message.type === "compose-error") {
      showComposerError(
        message.message || "GitHub 操作失败", Boolean(message.pendingReview)
      );
      composerBody.disabled = false;
      document.getElementById("prg-composer-submit").disabled = false;
      return;
    }
    if (message.type === "open-composer") {
      openComposer(message.request || { general: true, anchor: null, selection: null });
      return;
    }
    if (message.type !== "render") return;
    try {
      showError("");
      renderHtml(message.html);
      state.anchors = message.anchors || [];
      state.threads = message.threads || [];
      scanBlocks(state.anchors);
      renderThreads(state.threads);
      closeComposer();
      composerBody.disabled = false;
      document.getElementById("prg-composer-submit").disabled = false;
    } catch (error) {
      showError(error.message);
      planRoot.replaceChildren();
    }
  });

  post("ready");
}());
