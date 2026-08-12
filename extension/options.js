"use strict";

const form = document.getElementById("settings-form");
const tokenInput = document.getElementById("github-token");
const status = document.getElementById("settings-status");
const showToken = document.getElementById("show-token");
const verifyButton = document.getElementById("verify-token");
const github = window.PlannotateGitHub;
let currentContext = null;

function refFromContext(value) {
  if (!value || typeof value !== "object" || !value.owner || !value.repo) return null;
  const number = Number(value.number || value.pull);
  return {
    owner: String(value.owner), repo: String(value.repo),
    number: Number.isInteger(number) && number > 0 ? number : null,
  };
}

function renderContext() {
  const target = document.getElementById("token-target");
  const owner = currentContext && currentContext.owner;
  const repository = currentContext && currentContext.owner + "/" + currentContext.repo;
  document.getElementById("create-token").href = github.tokenTemplateUrl(owner);
  if (!currentContext) return;
  target.textContent = "当前目标：" + repository
    + (currentContext.number ? "#" + currentContext.number : "");
  document.getElementById("owner-guidance").textContent = "选择 " + owner;
  document.getElementById("repository-guidance").textContent =
    "选择 Only select repositories，并加入 " + repository;
}

function renderStatus(kind, title, items) {
  status.className = "verification-status " + (kind || "");
  const heading = document.createElement("strong");
  heading.textContent = title;
  const list = document.createElement("ul");
  (items || []).forEach((value) => {
    const item = document.createElement("li");
    item.textContent = value;
    list.appendChild(item);
  });
  status.replaceChildren(heading, list);
}

function renderError(error) {
  const help = github.errorHelp(error, currentContext);
  if (help) {
    renderStatus("error", help.title, [help.summary].concat(help.steps));
    return;
  }
  if (error && error.status === 404 && currentContext) {
    renderStatus("error", "当前 token 无法访问目标仓库", [
      "Resource owner 应为 " + currentContext.owner,
      "Repository access 必须包含 " + currentContext.owner + "/" + currentContext.repo,
      "如果是组织仓库，请检查 token 是否仍在 pending approval",
    ]);
    return;
  }
  renderStatus("error", "检查失败", [error.message]);
}

async function verifyToken(token) {
  renderStatus("checking", "正在检查 token…", ["不会创建、修改或删除任何 GitHub 评论"]);
  verifyButton.disabled = true;
  try {
    const api = new github.GitHubApi(token);
    const user = await api.getAuthenticatedUser();
    const checks = ["身份验证通过：@" + user.login];
    if (currentContext) {
      const repository = await api.getRepository(currentContext);
      checks.push("仓库访问通过：" + repository.full_name);
      if (currentContext.number) {
        const pull = await api.getPull(currentContext);
        checks.push("Pull request 读取通过：#" + pull.number);
        const files = await api.listPullFiles(currentContext);
        const planKeys = github.discoverPlanKeys(files);
        if (planKeys.length) {
          await github.loadBundle(api, currentContext, planKeys[0]);
          checks.push("Contents 读取与 plan 完整性校验通过：" + planKeys[0]);
        } else {
          checks.push("当前 PR 没有可用于 Contents 校验的 .plannotate manifest");
        }
      }
    }
    checks.push("评论创建/回复需要 Pull requests = Read and write");
    if (api.tokenKind === "fine-grained") {
      checks.push("解决/重新打开将使用当前 PR 的 GitHub 原生 review（无需扩大 token 权限）");
    }
    renderStatus("success", "读取检查通过", checks);
    return true;
  } catch (error) {
    renderError(error);
    return false;
  } finally {
    verifyButton.disabled = false;
  }
}

chrome.storage.local.get(["githubToken", "lastPullContext"]).then(
  (values) => {
    tokenInput.value = values.githubToken || "";
    currentContext = refFromContext(values.lastPullContext);
    renderContext();
  },
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
    await verifyToken(token);
  } catch (error) {
    renderStatus("error", "保存失败", [error.message]);
  }
});

verifyButton.addEventListener("click", () => {
  const token = tokenInput.value.trim();
  if (!token) return renderStatus("error", "尚未填写 token", []);
  verifyToken(token);
});

document.getElementById("clear-token").addEventListener("click", async () => {
  try {
    await chrome.storage.local.remove(["githubToken"]);
    tokenInput.value = "";
    renderStatus("success", "已清除", ["Plannotate 不再保存 GitHub token"]);
  } catch (error) {
    renderStatus("error", "清除失败", [error.message]);
  }
});
