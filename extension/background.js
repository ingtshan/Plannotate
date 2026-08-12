"use strict";

function pullContext(url) {
  const match = String(url || "").match(
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)(?:[/?#].*)?$/
  );
  if (!match) return null;
  return { owner: match[1], repo: match[2], pull: match[3] };
}

function pendingReviewUrl(value) {
  let url;
  try { url = new URL(String(value || "")); } catch (_error) { return null; }
  if (url.protocol !== "https:" || url.hostname !== "github.com"
      || url.search || url.hash) return null;
  const context = pullContext(url.href);
  if (!context || !url.pathname.endsWith("/files")) return null;
  const expected = "https://github.com/" + context.owner + "/" + context.repo
    + "/pull/" + context.pull + "/files";
  return url.href === expected ? expected : null;
}

if (typeof module === "object" && module.exports) {
  module.exports = { pendingReviewUrl, pullContext };
}

if (typeof chrome !== "undefined") {

async function openViewer(url) {
  const context = pullContext(url);
  if (!context) {
    await chrome.runtime.openOptionsPage();
    return;
  }
  const query = new URLSearchParams(context);
  await chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") + "?" + query });
}

chrome.action.onClicked.addListener((tab) => {
  openViewer(tab.url).catch((error) => console.error("plannotate:", error));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;
  if (message.type === "open-pending-review") {
    const url = pendingReviewUrl(message.url);
    if (!url) {
      sendResponse({ ok: false, error: "invalid pending review URL" });
      return false;
    }
    chrome.tabs.create({ url }).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }
  if (message.type !== "open-plannotate") return false;
  openViewer(message.url || (sender.tab && sender.tab.url)).then(
    () => sendResponse({ ok: true }),
    (error) => sendResponse({ ok: false, error: error.message })
  );
  return true;
});
}
