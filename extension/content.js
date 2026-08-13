(function () {
  "use strict";

  const TAB_ID = "plannotate-review-tab";
  const WORKSPACE_ID = "plannotate-review-workspace";
  const FRAME_ID = "plannotate-review-frame";
  const STYLE_ID = "plannotate-review-style";
  const OWNER_PATTERN = /^[A-Za-z0-9_.-]+$/;
  const state = {
    contextKey: null,
    nativeContent: null,
    nativeContentWasHidden: false,
    previousTab: null,
    selectedClasses: [],
    open: false,
  };

  function pullContext(value) {
    let url;
    try {
      url = new URL(String(value || ""), "https://github.com");
    } catch (_error) {
      return null;
    }
    if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
    const match = url.pathname.match(
      /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)(?:\/|$)/
    );
    if (!match) return null;
    return { owner: match[1], repo: match[2], pull: match[3] };
  }

  function viewerQuery(context) {
    return new URLSearchParams({
      owner: context.owner,
      repo: context.repo,
      pull: context.pull,
      embedded: "1",
    }).toString();
  }

  function pendingReviewUrl(context) {
    if (!context || !OWNER_PATTERN.test(String(context.owner || ""))
        || !OWNER_PATTERN.test(String(context.repo || ""))
        || !/^[1-9]\d*$/.test(String(context.pull || ""))) return null;
    return "https://github.com/" + context.owner + "/" + context.repo
      + "/pull/" + context.pull + "/files";
  }

  if (typeof module === "object" && module.exports) {
    module.exports = { pendingReviewUrl, pullContext, viewerQuery };
  }
  if (typeof document === "undefined" || typeof chrome === "undefined") return;

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${TAB_ID} { cursor: pointer; }
      #${TAB_ID}[aria-current="page"] {
        color: var(--fgColor-default, var(--color-fg-default, #1f2328));
        box-shadow: inset 0 -2px var(--underlineNav-borderColor-active, #fd8c73);
        font-weight: 600;
      }
      #${WORKSPACE_ID} {
        width: 100%;
        margin: 16px 0 0;
        overflow: hidden;
        border: 1px solid var(--borderColor-default, var(--color-border-default, #d0d7de));
        border-radius: 6px;
        background: var(--bgColor-default, var(--color-canvas-default, #fff));
        box-shadow: var(--shadow-resting-small, 0 1px 0 rgba(31,35,40,.04));
      }
      #${FRAME_ID} {
        display: block;
        width: 100%;
        height: calc(100vh - 164px);
        min-height: 720px;
        border: 0;
        background: var(--bgColor-default, var(--color-canvas-default, #fff));
      }
      .plannotate-native-content-hidden { display: none !important; }
      @media (max-width: 767px) {
        #${WORKSPACE_ID} { margin-top: 8px; border-right: 0; border-left: 0; border-radius: 0; }
        #${FRAME_ID} { height: calc(100vh - 120px); min-height: 620px; }
      }
    `;
    document.head.appendChild(style);
  }

  function findMount(context) {
    const expected = "/" + context.owner + "/" + context.repo
      + "/pull/" + context.pull + "/files";
    const fileLink = Array.from(document.querySelectorAll("a[href]")).find(
      (link) => link.getAttribute("href") === expected
    );
    const nav = fileLink && fileLink.closest(
      '[aria-label="Pull request navigation tabs"]'
    );
    const header = nav && nav.closest("header");
    const sibling = header && header.nextElementSibling;
    const content = sibling && sibling.id === WORKSPACE_ID
      ? sibling.nextElementSibling : sibling;
    if (!fileLink || !nav || !header || !content) return null;
    return { fileLink, navList: fileLink.parentElement, header, content };
  }

  function makeTab(fileLink) {
    const tab = document.createElement("a");
    tab.id = TAB_ID;
    tab.href = "#plannotate-review";
    tab.className = fileLink.className;
    tab.setAttribute("aria-controls", WORKSPACE_ID);
    const icon = fileLink.querySelector("svg");
    if (icon) tab.appendChild(icon.cloneNode(true));
    tab.appendChild(document.createTextNode("Plan review"));
    tab.addEventListener("click", (event) => {
      event.preventDefault();
      openWorkspace();
    });
    return tab;
  }

  function makeWorkspace(context) {
    const workspace = document.createElement("section");
    workspace.id = WORKSPACE_ID;
    workspace.hidden = true;
    workspace.setAttribute("aria-label", "Plannotate plan review workspace");
    const frame = document.createElement("iframe");
    frame.id = FRAME_ID;
    frame.title = "Plannotate plan review";
    frame.src = chrome.runtime.getURL("viewer.html") + "?" + viewerQuery(context);
    workspace.appendChild(frame);
    return workspace;
  }

  function selectTab(tab, navList) {
    if (state.previousTab && state.previousTab.isConnected) return;
    const current = navList.querySelector('a[aria-current="page"]');
    if (current && current !== tab) {
      state.previousTab = current;
      state.selectedClasses = Array.from(current.classList).filter(
        (name) => name.includes("__selected__")
      );
      current.removeAttribute("aria-current");
      state.selectedClasses.forEach((name) => current.classList.remove(name));
      state.selectedClasses.forEach((name) => tab.classList.add(name));
    }
    tab.setAttribute("aria-current", "page");
  }

  function restoreTab(tab) {
    tab.removeAttribute("aria-current");
    state.selectedClasses.forEach((name) => tab.classList.remove(name));
    if (state.previousTab && state.previousTab.isConnected) {
      state.previousTab.setAttribute("aria-current", "page");
      state.selectedClasses.forEach(
        (name) => state.previousTab.classList.add(name)
      );
    }
    state.previousTab = null;
    state.selectedClasses = [];
  }

  function openWorkspace() {
    const context = pullContext(location.href);
    const mount = context && findMount(context);
    const tab = document.getElementById(TAB_ID);
    const workspace = document.getElementById(WORKSPACE_ID);
    if (!context || !mount || !tab || !workspace) return;
    if (!state.open) {
      state.nativeContent = mount.content;
      state.nativeContentWasHidden = mount.content.hidden;
    }
    state.open = true;
    workspace.hidden = false;
    mount.content.hidden = true;
    mount.content.classList.add("plannotate-native-content-hidden");
    selectTab(tab, mount.navList);
    if (workspace.hidden) workspace.hidden = false;
    workspace.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function closeWorkspace() {
    const tab = document.getElementById(TAB_ID);
    const workspace = document.getElementById(WORKSPACE_ID);
    if (workspace) workspace.hidden = true;
    if (state.nativeContent && state.nativeContent.isConnected) {
      state.nativeContent.hidden = state.nativeContentWasHidden;
      state.nativeContent.classList.remove("plannotate-native-content-hidden");
    }
    if (tab) restoreTab(tab);
    state.nativeContent = null;
    state.nativeContentWasHidden = false;
    state.open = false;
  }

  function removeWorkspace() {
    closeWorkspace();
    document.getElementById(TAB_ID)?.remove();
    document.getElementById(WORKSPACE_ID)?.remove();
    state.contextKey = null;
  }

  function sync() {
    const context = pullContext(location.href);
    if (!context) return removeWorkspace();
    const mount = findMount(context);
    if (!mount) {
      if (state.open) {
        const workspace = document.getElementById(WORKSPACE_ID);
        if (workspace) {
          workspace.classList.remove("plannotate-native-content-hidden");
          workspace.hidden = false;
        }
        if (state.nativeContent && state.nativeContent.isConnected) {
          state.nativeContent.classList.add("plannotate-native-content-hidden");
          state.nativeContent.hidden = true;
        }
      }
      return;
    }
    installStyles();
    const contextKey = context.owner + "/" + context.repo + "#" + context.pull;
    if (state.contextKey && state.contextKey !== contextKey) removeWorkspace();
    state.contextKey = contextKey;
    let tab = document.getElementById(TAB_ID);
    if (!tab) {
      tab = makeTab(mount.fileLink);
      mount.navList.appendChild(tab);
    }
    let workspace = document.getElementById(WORKSPACE_ID);
    if (!workspace) {
      workspace = makeWorkspace(context);
      mount.header.insertAdjacentElement("afterend", workspace);
    }
    if (state.open) {
      workspace.classList.remove("plannotate-native-content-hidden");
      workspace.hidden = false;
      mount.content.classList.add("plannotate-native-content-hidden");
      mount.content.hidden = true;
    }
  }

  window.addEventListener("message", (event) => {
    const frame = document.getElementById(FRAME_ID);
    const message = event.data || {};
    if (!frame || event.source !== frame.contentWindow
        || message.source !== "plannotate-viewer") return;
    if (message.type === "close") closeWorkspace();
    if (message.type === "open-pending-review") {
      const target = pendingReviewUrl(pullContext(location.href));
      if (target) chrome.runtime.sendMessage({ type: "open-pending-review", url: target });
    }
  });

  sync();
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      sync();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
}());
