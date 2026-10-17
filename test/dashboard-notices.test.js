"use strict";

// The Dashboard's Notices tab, driven through the real dashboard-renderer.js
// in a minimal fake DOM (same approach as dashboard-session-history.test.js;
// its own harness so a drift in another file's node model cannot mask a
// regression here).

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
  }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...nodes) {
    this.children = nodes.flatMap((node) => (node && node.tagName === "FRAGMENT" ? node.children : [node]));
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
  }
  async dispatch(name, extra = {}) {
    const event = { key: "", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
    for (const fn of this.listeners.get(name) || []) await fn(event);
    return event;
  }
  descendants() {
    return this.children.flatMap((child) => [child, ...(child.descendants ? child.descendants() : [])]);
  }
  contains(node) { return node === this || this.descendants().includes(node); }
  querySelector() { return null; }
  querySelectorAll(selector) {
    const match = /^\[([\w-]+)\]$/.exec(selector);
    return match ? this.descendants().filter((el) => el.getAttribute && el.getAttribute(match[1]) !== null) : [];
  }
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

function entry(id, overrides = {}) {
  return {
    id: `run123:${id}`,
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 60_000,
    level: "info",
    kind: "text",
    title: `Title ${id}`,
    body: `Body ${id}`,
    key: "",
    series: [],
    hasImage: false,
    live: false,
    ...overrides,
  };
}

function loadDashboard(options = {}) {
  const elements = new Map();
  const documentListeners = new Map();
  let selection = null;
  const document = {
    title: "",
    activeElement: null,
    createElement: (tag) => new FakeElement(tag, document),
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    createDocumentFragment: () => new FakeElement("fragment", document),
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, new FakeElement(id === "noticesPanel" ? "section" : "div", document));
      return elements.get(id);
    },
    addEventListener: (name, fn) => {
      if (!documentListeners.has(name)) documentListeners.set(name, []);
      documentListeners.get(name).push(fn);
    },
    contains: () => true,
  };
  // The real page starts with Notices hidden and the tab bar hidden.
  document.getElementById("noticesPanel").hidden = true;
  document.getElementById("dashboardTabs").hidden = true;

  const calls = { history: 0, copy: [], clear: 0 };
  let history = options.history || { enabled: true, retentionDays: 7, entries: [] };
  const listeners = {};
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
    onQuickIntent: (fn) => { listeners.intent = fn; },
    onQuickEntries: () => {},
    onQuickDismissed: () => {},
  };
  if (options.withNotices !== false) {
    Object.assign(api, {
      getNoticeHistory: async () => { calls.history += 1; return history; },
      copyNotice: async (id) => { calls.copy.push(id); return { status: "ok" }; },
      clearNoticeHistory: async () => {
        calls.clear += 1;
        history = { ...history, entries: [] };
        return { status: "ok", removed: 1 };
      },
      onNoticeHistoryChanged: (fn) => { listeners.changed = fn; },
    });
  }

  let tick = null;
  const context = vm.createContext({
    window: {
      dashboardAPI: api,
      addEventListener: () => {},
      getSelection: () => selection,
    },
    document,
    console,
    Intl,
    Date,
    setInterval: (fn) => { tick = fn; return 1; },
    setTimeout: () => 0,
    clearTimeout: () => {},
    requestAnimationFrame: (fn) => fn(),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "session-focus-unavailable.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "language-picker.js"), "utf8"), context);
  vm.runInContext(RENDERER, context);

  const el = (id) => document.getElementById(id);
  return {
    document,
    calls,
    el,
    body: () => el("noticesBody"),
    setHistory: (next) => { history = next; },
    changed: () => listeners.changed && listeners.changed(),
    intent: (revision) => listeners.intent && listeners.intent({ revision }),
    tick: () => tick && tick(),
    select: (node) => { selection = node ? { isCollapsed: false, rangeCount: 1, anchorNode: node } : null; },
    selectionChanged: () => (documentListeners.get("selectionchange") || []).forEach((fn) => fn()),
    openNotices: async () => { await el("tabNotices").dispatch("click"); await flush(); },
  };
}

describe("dashboard notices tab", () => {
  it("keeps the page a plain Sessions view when main offers no notice history", async () => {
    const app = loadDashboard({ withNotices: false });
    await flush();
    assert.equal(app.el("dashboardTabs").hidden, true);
    await app.el("tabNotices").dispatch("click");
    assert.equal(app.el("noticesPanel").hidden, true);
    assert.equal(app.el("content").hidden, false);
  });

  it("is a real tablist: one selected tab, roving tabindex, arrow keys move and activate", async () => {
    const app = loadDashboard();
    await flush();
    const tabs = app.el("dashboardTabs");
    assert.equal(tabs.hidden, false);
    assert.equal(tabs.getAttribute("aria-label"), en.dashboardTabsLabel);
    assert.equal(app.el("tabSessions").textContent, en.dashboardTabSessions);
    assert.equal(app.el("tabNotices").textContent, en.dashboardTabNotices);

    const key = await tabs.dispatch("keydown", { key: "ArrowRight" });
    await flush();
    assert.equal(key.defaultPrevented, true);
    assert.equal(app.el("tabNotices").getAttribute("aria-selected"), "true");
    assert.equal(app.el("tabNotices").getAttribute("tabindex"), "0");
    assert.equal(app.el("tabSessions").getAttribute("aria-selected"), "false");
    assert.equal(app.el("tabSessions").getAttribute("tabindex"), "-1");
    assert.equal(app.document.activeElement, app.el("tabNotices"), "focus follows the selection");
    assert.equal(app.el("noticesPanel").hidden, false);
    assert.equal(app.el("content").hidden, true);

    await tabs.dispatch("keydown", { key: "Home" });
    assert.equal(app.el("tabSessions").getAttribute("aria-selected"), "true");
    assert.equal(app.el("content").hidden, false);
    await tabs.dispatch("keydown", { key: "End" });
    assert.equal(app.el("tabNotices").getAttribute("aria-selected"), "true");
    await tabs.dispatch("keydown", { key: "ArrowLeft" });
    assert.equal(app.el("tabSessions").getAttribute("aria-selected"), "true");
    const ignored = await tabs.dispatch("keydown", { key: "ArrowDown" });
    assert.equal(ignored.defaultPrevented, false, "vertical keys stay with the page");
  });

  it("reads history only while the Notices tab shows, never on the Sessions tick", async () => {
    const app = loadDashboard({ history: { enabled: true, retentionDays: 7, entries: [entry("notice-1")] } });
    await flush();
    assert.equal(app.calls.history, 0, "a hidden tab costs nothing");
    app.changed();
    app.tick();
    await flush();
    assert.equal(app.calls.history, 0);

    await app.openNotices();
    assert.equal(app.calls.history, 1);
    app.tick();
    app.tick();
    await flush();
    assert.equal(app.calls.history, 1, "the one-second Sessions tick never re-reads");
    app.changed();
    await flush();
    assert.equal(app.calls.history, 2, "a change signal re-reads while showing");

    await app.el("tabSessions").dispatch("click");
    app.changed();
    await flush();
    assert.equal(app.calls.history, 2);
    await app.openNotices();
    assert.equal(app.calls.history, 3, "a change missed while hidden is picked up on return");
  });

  it("shows each row's time, level as glyph + word, title, clamped body and series values", async () => {
    const longBody = "line\n".repeat(8) + "end";
    const app = loadDashboard({ history: { enabled: true, retentionDays: 7, entries: [
      entry("notice-2", { level: "error", title: "Deploy failed", body: longBody, live: true }),
      entry("notice-1", {
        level: "warn", kind: "trend", title: "CPU", body: "",
        series: [{ name: "cpu", value: 93, unit: "%" }, { name: "mem", value: null, unit: "" }],
        hasImage: true,
      }),
    ] } });
    await app.openNotices();
    const rows = byClass(app.body(), "notice-row");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].tagName, "LI", "rows are list items of a list");
    assert.ok(rows[0].classList.contains("level-error"));
    const badge = byClass(rows[0], "notice-level")[0];
    assert.equal(textOf(badge), `× ${en.dashboardNoticesLevelError}`,
      "the level is a word, not only a colour");
    assert.ok(byClass(rows[0], "notice-time")[0].textContent.length > 0);
    assert.equal(byClass(rows[0], "notice-title")[0].textContent, "Deploy failed");
    assert.ok(textOf(rows[0]).includes(en.dashboardNoticesLive));

    const body = byClass(rows[0], "notice-body")[0];
    assert.ok(body.classList.contains("is-clamped"));
    const toggle = byClass(rows[0], "notice-toggle")[0];
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    await toggle.dispatch("click");
    const reopened = byClass(byClass(app.body(), "notice-row")[0], "notice-body")[0];
    assert.equal(reopened.classList.contains("is-clamped"), false, "Show more reveals the whole body");
    assert.equal(byClass(app.body(), "notice-toggle")[0].getAttribute("aria-expanded"), "true");

    assert.deepEqual(byClass(rows[1], "notice-series-value").map((el) => el.textContent), ["93%", "—"]);
    assert.ok(textOf(rows[1]).includes(en.dashboardNoticesImageOmitted));
    assert.ok(textOf(app.body()).includes(en.dashboardNoticesRetention.replace("{days}", 7)));
  });

  it("filters by level with pressed-state buttons and says when a level is empty", async () => {
    const app = loadDashboard({ history: { enabled: true, retentionDays: 7, entries: [
      entry("notice-2", { level: "error" }),
      entry("notice-1", { level: "info" }),
    ] } });
    await app.openNotices();
    const filters = byClass(app.body(), "notices-filter-button");
    assert.deepEqual(filters.map((el) => el.textContent), [
      en.dashboardNoticesFilterAll,
      en.dashboardNoticesLevelInfo,
      en.dashboardNoticesLevelSuccess,
      en.dashboardNoticesLevelWarn,
      en.dashboardNoticesLevelError,
    ]);
    await filters[4].dispatch("click");
    assert.deepEqual(byClass(app.body(), "notice-title").map((el) => el.textContent), ["Title notice-2"]);
    assert.equal(byClass(app.body(), "notices-filter-button")[4].getAttribute("aria-pressed"), "true");
    await byClass(app.body(), "notices-filter-button")[2].dispatch("click");
    assert.ok(textOf(app.body()).includes(en.dashboardNoticesEmptyFiltered));
  });

  it("shows an empty state, and says so when recording is off", async () => {
    const app = loadDashboard({ history: { enabled: false, retentionDays: 7, entries: [] } });
    await app.openNotices();
    const text = textOf(app.body());
    assert.ok(text.includes(en.dashboardNoticesEmpty));
    assert.ok(text.includes(en.dashboardNoticesDisabled));
    assert.equal(byClass(app.body(), "notices-clear-button")[0].disabled, true);
  });

  it("copies a row by button or right-click, sending only its id", async () => {
    const app = loadDashboard({ history: { enabled: true, retentionDays: 7, entries: [entry("notice-1")] } });
    await app.openNotices();
    const row = byClass(app.body(), "notice-row")[0];
    await byClass(row, "notices-row-action")[0].dispatch("click");
    const menu = await row.dispatch("contextmenu");
    await flush();
    assert.equal(menu.defaultPrevented, true);
    assert.deepEqual(app.calls.copy, ["run123:notice-1", "run123:notice-1"]);
    assert.equal(app.el("noticesStatus").textContent, en.dashboardNoticesCopied);
    assert.match(byClass(row, "notices-row-action")[0].getAttribute("aria-label"), /Title notice-1/,
      "each row's copy button names what it copies");
  });

  it("clears only after an explicit confirmation", async () => {
    const app = loadDashboard({ history: { enabled: true, retentionDays: 7, entries: [entry("notice-1")] } });
    await app.openNotices();
    await byClass(app.body(), "notices-clear-button")[0].dispatch("click");
    assert.ok(textOf(app.body()).includes(en.dashboardNoticesClearConfirm));
    assert.equal(app.document.activeElement, byClass(app.body(), "notices-confirm-cancel")[0],
      "the safe choice gets the focus");
    await byClass(app.body(), "notices-confirm")[0].dispatch("keydown", { key: "Escape" });
    assert.equal(byClass(app.body(), "notices-confirm").length, 0);
    assert.equal(app.calls.clear, 0, "cancelling deletes nothing");

    await byClass(app.body(), "notices-clear-button")[0].dispatch("click");
    await byClass(app.body(), "notices-confirm-delete")[0].dispatch("click");
    await flush();
    assert.equal(app.calls.clear, 1);
    assert.equal(byClass(app.body(), "notice-row").length, 0);
    assert.ok(textOf(app.body()).includes(en.dashboardNoticesEmpty));
    assert.equal(app.el("noticesStatus").textContent, en.dashboardNoticesCleared);
  });

  it("holds a live refresh while the user is selecting text in a row", async () => {
    const app = loadDashboard({ history: { enabled: true, retentionDays: 7, entries: [entry("notice-1")] } });
    await app.openNotices();
    const title = byClass(app.body(), "notice-title")[0];
    app.select(title);
    app.setHistory({ enabled: true, retentionDays: 7, entries: [entry("notice-2"), entry("notice-1")] });
    app.changed();
    await flush();
    assert.equal(byClass(app.body(), "notice-title")[0], title, "the selected node survives");
    app.select(null);
    app.selectionChanged();
    assert.equal(byClass(app.body(), "notice-row").length, 2, "the held refresh lands afterwards");
  });

  it("returns to Sessions when keyboard mode starts, and keeps Notices closed during it", async () => {
    const app = loadDashboard();
    await app.openNotices();
    assert.equal(app.el("noticesPanel").hidden, false);
    await app.intent(1);
    await flush();
    assert.equal(app.el("tabSessions").getAttribute("aria-selected"), "true");
    assert.equal(app.el("content").hidden, false);
    assert.equal(app.el("noticesPanel").hidden, true);
    await app.el("tabNotices").dispatch("click");
    assert.equal(app.el("noticesPanel").hidden, true, "no tab switch while a round is running");
  });
});
