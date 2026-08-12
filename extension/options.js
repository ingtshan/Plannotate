"use strict";

const form = document.getElementById("settings-form");
const tokenInput = document.getElementById("github-token");
const status = document.getElementById("settings-status");
const showToken = document.getElementById("show-token");

chrome.storage.local.get(["githubToken"]).then(
  (values) => { tokenInput.value = values.githubToken || ""; },
  (error) => { status.textContent = "读取失败：" + error.message; }
);

showToken.addEventListener("change", () => {
  tokenInput.type = showToken.checked ? "text" : "password";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = tokenInput.value.trim();
  if (!token) return;
  try {
    await chrome.storage.local.set({ githubToken: token });
    status.textContent = "已保存。";
  } catch (error) {
    status.textContent = "保存失败：" + error.message;
  }
});

document.getElementById("clear-token").addEventListener("click", async () => {
  try {
    await chrome.storage.local.remove(["githubToken"]);
    tokenInput.value = "";
    status.textContent = "已清除。";
  } catch (error) {
    status.textContent = "清除失败：" + error.message;
  }
});
