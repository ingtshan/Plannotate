(function () {
  "use strict";

  const BUTTON_ID = "plannotate-open";

  function isPullRequest() {
    return /^\/[^/]+\/[^/]+\/pull\/[1-9]\d+/.test(location.pathname);
  }

  function syncButton() {
    const existing = document.getElementById(BUTTON_ID);
    if (!isPullRequest()) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.textContent = "Review rendered plan";
    Object.assign(button.style, {
      position: "fixed",
      right: "18px",
      bottom: "74px",
      zIndex: "2147483646",
      border: "1px solid #0969da",
      borderRadius: "8px",
      padding: "8px 12px",
      color: "#fff",
      background: "#0969da",
      boxShadow: "0 3px 12px rgba(27,31,36,.2)",
      font: "600 13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      cursor: "pointer",
    });
    button.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "open-plannotate", url: location.href });
    });
    document.body.appendChild(button);
  }

  syncButton();
  let previousUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== previousUrl) previousUrl = location.href;
    syncButton();
  }).observe(document.documentElement, { childList: true, subtree: true });
}());
