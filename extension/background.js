"use strict";

function pullContext(url) {
  const match = String(url || "").match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)/
  );
  if (!match) return null;
  return { owner: match[1], repo: match[2], pull: match[3] };
}

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
  if (!message || message.type !== "open-plannotate") return false;
  openViewer(message.url || (sender.tab && sender.tab.url)).then(
    () => sendResponse({ ok: true }),
    (error) => sendResponse({ ok: false, error: error.message })
  );
  return true;
});
