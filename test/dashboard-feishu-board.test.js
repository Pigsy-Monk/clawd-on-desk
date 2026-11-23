"use strict";

// The Dashboard's Feishu tab, driven through the real dashboard-renderer.js in
// a minimal fake DOM (same approach as dashboard-notices.test.js). What this
// pins down: unread before read, time windows inside each, newest first, and
// the two per-row actions — open in Feishu, hand the conversation to an agent.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { describe, it } = require("node:test");
const { i18n } = require("../src/i18n");

const RENDERER = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8");
const en = i18n.en;

class FakeClassList {
  constructor(el) { this.el = el; }
  get items() { return new Set(this.el.className.split(/\s+/).filter(Boolean)); }
  add(...names) { this.el.className = [...new Set([...this.items, ...names])].join(" "); }
  remove(...names) { this.el.className = [...this.items].filter((n) => !names.includes(n)).join(" "); }
  toggle(name, force) { if (force ?? !this.contains(name)) this.add(name); else this.remove(name); }
  contains(name) { return this.items.has(name); }
}

class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.className = "";
    this.classList = new FakeClassList(this);
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.scrollTop = 0;
    this.style = {};
    this.tabIndex = 0;
    this.dataset = {};
  }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...nodes) {
    this.children = nodes.flatMap((node) => (node && node.tagName === "FRAGMENT" ? node.children : [node]));
  }
  remove() {
    for (const parent of [this.ownerDocument.bodyEl, ...this.ownerDocument.allElements()]) {
      if (parent && parent.children && parent.children.includes(this)) {
        parent.children = parent.children.filter((child) => child !== this);
      }
    }
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
  }
  async dispatch(name, extra = {}) {
    const event = {
      key: "",
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...extra,
    };
    for (const fn of this.listeners.get(name) || []) await fn(event);
    return event;
  }
  descendants() {
    return this.children.flatMap((child) => [child, ...(child.descendants ? child.descendants() : [])]);
  }
  contains(node) { return node === this || this.descendants().includes(node); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  focus() { this.ownerDocument.activeElement = this; }
  select() {}
}

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function textOf(node) {
  const own = typeof node.textContent === "string" ? node.textContent : "";
  return [own, ...(node.children || []).map(textOf)].join(" ").replace(/\s+/g, " ").trim();
}

function byClass(root, className) {
  return root.descendants().filter((el) => el.classList && el.classList.contains(className));
}

const pad2 = (value) => String(value).padStart(2, "0");

// The same "YYYY-MM-DD HH:MM" shape the skill emits.
function stamp(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    + ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3600_000);
}

function daysAgo(days) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 12, 0);
}

function row(overrides = {}) {
  return {
    tag: "回",
    who: "someone",
    where: "a chat",
    text: "hello",
    href: "",
    createTime: "",
    chatId: "",
    messageId: "",
    messageIds: [],
    read: false,
    count: 1,
    ...overrides,
  };
}

function loadDashboard(options = {}) {
  const elements = new Map();
  const document = {
    title: "",
    activeElement: null,
    bodyEl: null,
    createElement: (tag) => new FakeElement(tag, document),
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    createDocumentFragment: () => new FakeElement("fragment", document),
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, new FakeElement(id === "feishuPanel" ? "section" : "div", document));
      return elements.get(id);
    },
    addEventListener: () => {},
    contains: () => true,
    allElements: () => [...elements.values()],
  };
  document.getElementById("feishuPanel").hidden = true;
  document.getElementById("dashboardTabs").hidden = true;

  const calls = { openLink: [], followUp: [] };
  const api = {
    getI18n: async () => ({ lang: "en", translations: { ...en } }),
    getSnapshot: async () => ({ sessions: [], groups: [] }),
    getKimiQuotaStatus: async () => null,
    getSessionHistory: async () => [],
    onLangChange: () => {},
    onSessionSnapshot: () => {},
    quickPending: async () => ({ status: "ok", revision: 0 }),
    quickEnter: async (payload) => ({ status: "empty", revision: payload.revision }),
    quickReady: async () => ({ status: "ok" }),
    quickDismiss: async () => ({ status: "ok" }),
    onQuickIntent: () => {},
    onQuickEntries: () => {},
    onQuickDismissed: () => {},
    getFeishuBoard: async () => ({ status: "ready", rows: options.rows || [] }),
    // The tab bar (Feishu included) only exists alongside the Notices tab, so
    // the harness must look like a main that has notice history.
    getNoticeHistory: async () => ({ enabled: false, retentionDays: 7, entries: [] }),
    copyNotice: async () => ({ status: "ok" }),
    clearNoticeHistory: async () => ({ status: "ok", removed: 0 }),
    onNoticeHistoryChanged: () => {},
    openLink: (href) => calls.openLink.push(href),
    followUpFeishu: (payload) => calls.followUp.push(payload),
  };

  const context = vm.createContext({
    window: {
      dashboardAPI: api,
      addEventListener: () => {},
      getSelection: () => null,
    },
    document,
    console,
    Intl,
    Date,
    setInterval: () => 1,
    setTimeout: () => 0,
    clearTimeout: () => {},
    requestAnimationFrame: (fn) => fn(),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "session-focus-unavailable.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "language-picker.js"), "utf8"), context);
  vm.runInContext(RENDERER, context);

  const el = (id) => document.getElementById(id);
  return {
    calls,
    el,
    body: () => el("feishuBoardBody"),
    openBoard: async () => {
      // Let init() finish first: it is what primes the i18n payload.
      await flush();
      await el("tabFeishu").dispatch("click");
      await flush();
    },
  };
}

describe("dashboard Feishu board", () => {
  it("keeps unread above read and buckets each into today / yesterday / earlier", async () => {
    const app = loadDashboard({
      rows: [
        row({ text: "read today", read: true, href: "https://applink.feishu.cn/client/chat/open?openChatId=oc_a",
          createTime: stamp(hoursAgo(1)) }),
        row({ text: "unread older", read: false, createTime: stamp(daysAgo(4)) }),
        row({ text: "unread yesterday", read: false, createTime: stamp(daysAgo(1)) }),
        row({ text: "unread today", read: false, createTime: stamp(hoursAgo(2)) }),
      ],
    });
    await app.openBoard();

    const body = app.body();
    const headings = byClass(body, "feishu-board-heading").map(textOf);
    assert.deepEqual(headings, ["Unread · 3", "Read · 1"]);

    const subheadings = byClass(body, "feishu-board-subheading").map(textOf);
    assert.deepEqual(subheadings, ["Today · 1", "Yesterday · 1", "Earlier · 1", "Today · 1"]);

    const order = byClass(body, "feishu-board-text").map(textOf);
    // Unread newest first, then read.
    assert.deepEqual(order, [
      "unread today", "unread yesterday", "unread older", "read today",
    ]);
  });

  it("sorts rows inside one window newest first", async () => {
    const app = loadDashboard({
      rows: [
        row({ text: "older today", createTime: stamp(hoursAgo(6)) }),
        row({ text: "newer today", createTime: stamp(hoursAgo(1)) }),
      ],
    });
    await app.openBoard();

    assert.deepEqual(byClass(app.body(), "feishu-board-text").map(textOf), ["newer today", "older today"]);
  });

  it("opens the message in Feishu on click and hands the chat to an agent on the robot", async () => {
    const app = loadDashboard({
      rows: [
        row({
          text: "please look",
          href: "https://applink.feishu.cn/client/chat/open?openChatId=oc_1",
          chatId: "oc_1",
          messageId: "om_1",
          messageIds: ["om_1", "om_2"],
          createTime: stamp(hoursAgo(1)),
        }),
      ],
    });
    await app.openBoard();

    const body = app.body();
    const node = byClass(body, "feishu-board-row")[0];
    assert.ok(node.classList.contains("is-openable"));

    await node.dispatch("click");
    assert.deepEqual(app.calls.openLink, ["https://applink.feishu.cn/client/chat/open?openChatId=oc_1"]);

    const go = byClass(body, "feishu-board-go")[0];
    const robot = await go.dispatch("click");
    assert.equal(robot.propagationStopped, true, "the robot must not also open the message");
    assert.equal(app.calls.openLink.length, 1);
    // The payload is built inside the vm realm, so compare its shape, not its
    // prototype.
    assert.deepEqual(JSON.parse(JSON.stringify(app.calls.followUp)), [{
      chatId: "oc_1",
      messageId: "om_1",
      messageIds: ["om_1", "om_2"],
      who: "someone",
      where: "a chat",
      text: "please look",
    }]);
    assert.equal(byClass(body, "feishu-board-row").length, 0, "a handed-off row leaves the list");
  });

  it("keeps a row without a link readable but not clickable", async () => {
    const app = loadDashboard({
      rows: [row({ text: "no link here", href: "", createTime: stamp(hoursAgo(1)) })],
    });
    await app.openBoard();

    const node = byClass(app.body(), "feishu-board-row")[0];
    assert.equal(node.classList.contains("is-openable"), false);
    assert.equal(node.getAttribute("role"), null);
    await node.dispatch("click");
    assert.deepEqual(app.calls.openLink, []);
  });
});
