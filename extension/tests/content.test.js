"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "content.js"), "utf8"
);

function runContentScript(pathname) {
  const elements = new Map();
  const messages = [];
  const document = {
    body: {
      appendChild(element) {
        elements.set(element.id, element);
      },
    },
    documentElement: {},
    createElement(tagName) {
      return {
        tagName: tagName.toUpperCase(),
        style: {},
        addEventListener(type, listener) {
          this.listeners = this.listeners || {};
          this.listeners[type] = listener;
        },
        remove() {
          elements.delete(this.id);
        },
      };
    },
    getElementById(id) {
      return elements.get(id) || null;
    },
  };
  class MutationObserver {
    observe() {}
  }
  const context = vm.createContext({
    chrome: { runtime: { sendMessage: (message) => messages.push(message) } },
    document,
    location: { href: "https://github.com" + pathname, pathname },
    MutationObserver,
  });

  vm.runInContext(SOURCE, context);
  return { button: elements.get("plannotate-open"), messages };
}

test("injects the review button for a single-digit pull request", () => {
  const result = runContentScript("/owner/repository/pull/1");

  assert.equal(result.button.textContent, "Review rendered plan");
  result.button.listeners.click();
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].type, "open-plannotate");
  assert.equal(
    result.messages[0].url,
    "https://github.com/owner/repository/pull/1"
  );
});

test("does not inject the review button outside pull requests", () => {
  const result = runContentScript("/owner/repository/issues/1");

  assert.equal(result.button, undefined);
});
