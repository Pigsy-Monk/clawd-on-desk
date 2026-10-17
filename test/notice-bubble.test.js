"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const vm = require("node:vm");
const { describe, it } = require("node:test");
const { parseDocument } = require("htmlparser2");

// Only the Electron window boundary is replaced: the geometry, the store
// subscription and the IPC contract run for real, with no GUI.
const windows = new Map();

class FakeBrowserWindow {
  constructor(options) {
    this.options = options;
    this.bounds = null;
    this.visible = false;
    this.destroyed = false;
    this.sent = [];
    this.loadedFile = null;
    const self = this;
    this.webContents = {
      isLoading: () => false,
      isDestroyed: () => self.destroyed,
      insertCSS: () => Promise.resolve("key"),
      removeInsertedCSS: () => Promise.resolve(),
      setZoomFactor: () => {},
      send: (channel, payload) => self.sent.push({ channel, payload }),
      once: () => {},
      on: () => {},
    };
    windows.set(this.webContents, this);
  }

  static fromWebContents(contents) { return windows.get(contents) || null; }
  isDestroyed() { return this.destroyed; }
  loadFile(file) { this.loadedFile = file; }
  setAlwaysOnTop() {}
  setBounds(bounds) { this.bounds = bounds; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  destroy() { this.destroyed = true; }
  on() {}
}

const originalLoad = Module._load;
let initNoticeBubble;
try {
  Module._load = function (request) {
    if (request === "electron") return { BrowserWindow: FakeBrowserWindow };
    return originalLoad.apply(this, arguments);
  };
  initNoticeBubble = require("../src/notice-bubble");
} finally {
  Module._load = originalLoad;
}
const { registerNoticeBubbleIpc } = initNoticeBubble;
const { estimateNoticeStackHeight } = initNoticeBubble.__test;

function createFakeStore() {
  const listeners = new Set();
  let notices = [];
  function emit() {
    for (const listener of [...listeners]) listener(notices.slice());
  }
  return {
    list: () => notices.slice(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push(notice) {
      notices = notices.concat([notice]);
      emit();
    },
    clear() {
      notices = [];
      emit();
    },
    remove(id) {
      const next = notices.filter((notice) => notice.id !== id);
      if (next.length === notices.length) return false;
      notices = next;
      emit();
      return true;
    },
  };
}

function notice(id, overrides = {}) {
  return {
    id,
    title: "Title",
    body: "Body",
    level: "info",
    createdAt: 0,
    expiresAt: 10 ** 12,
    ttl: 60_000,
    ...overrides,
  };
}

function createCtx(overrides = {}) {
  return {
    win: { isDestroyed: () => false },
    bubbleFollowPet: true,
    bubbleFollowPreference: "auto",
    bubbleFixedCorner: "bottom-right",
    petHidden: false,
    getPetWindowBounds: () => ({ x: 300, y: 60, width: 120, height: 120 }),
    getBubbleWorkArea: () => ({ x: 0, y: 0, width: 800, height: 900 }),
    getHitRectScreen: () => ({ left: 320, top: 88, right: 400, bottom: 168 }),
    getUpdateBubbleAnchorRect: () => ({ left: 320, top: 88, right: 400, bottom: 168 }),
    getTextScale: () => 1,
    getPermissionBubbleBounds: () => [],
    getSessionHudBounds: () => [],
    noticeStore: createFakeStore(),
    ...overrides,
  };
}

describe("notice stack height estimate", () => {
  it("is zero for an empty list and one base card for a single notice", () => {
    assert.equal(estimateNoticeStackHeight([]), 0);
    assert.equal(estimateNoticeStackHeight(null), 0);
    assert.equal(estimateNoticeStackHeight([notice("n1")]), 150);
  });

  it("adds one line per extra wrapped body line and a gap between cards", () => {
    const one = estimateNoticeStackHeight([notice("n1")]);
    const hardLines = estimateNoticeStackHeight([notice("n1", { body: "a\nb\nc" })]);
    assert.equal(hardLines - one, 32);
    const two = estimateNoticeStackHeight([notice("n1"), notice("n2")]);
    assert.equal(two - one * 2, 8);
  });

  it("estimates a trend notice taller than a text one, one row per series", () => {
    const text = estimateNoticeStackHeight([notice("n1")]);
    const oneSeries = estimateNoticeStackHeight([
      notice("n1", { kind: "trend", series: [{ name: "cpu", points: [1, 2], value: 2, unit: "%" }] }),
    ]);
    const threeSeries = estimateNoticeStackHeight([
      notice("n1", {
        kind: "trend",
        series: [
          { name: "a", points: [1], value: 1, unit: "" },
          { name: "b", points: [2], value: 2, unit: "" },
          { name: "c", points: [3], value: 3, unit: "" },
        ],
      }),
    ]);
    assert.equal(oneSeries - text, 30, "one series row on top of the text card");
    assert.equal(threeSeries - oneSeries, 60, "one row per extra series");
  });

  it("survives a trend notice with no series list at all", () => {
    assert.equal(estimateNoticeStackHeight([notice("n1", { kind: "trend" })]), 150);
    assert.equal(estimateNoticeStackHeight([notice("n1", { kind: "trend", series: null })]), 150);
  });
});

describe("notice bubble contract", () => {
  it("returns every method main.js wires, mirroring update-bubble", () => {
    const bubble = initNoticeBubble(createCtx());
    for (const name of [
      "showNoticeBubble",
      "hideNoticeBubble",
      "repositionNoticeBubble",
      "handleNoticeBubbleHeight",
      "handleNoticeBubbleDismiss",
      "handleNoticeBubbleExpand",
      "syncVisibility",
      "suspendForPetHidden",
      "suspendForFullscreen",
      "resumeFromFullscreen",
      "cleanup",
      "getBubbleWindow",
    ]) {
      assert.equal(typeof bubble[name], "function", `${name} must be a function`);
    }
    assert.equal(bubble.getBubbleWindow(), null);
    bubble.cleanup();
  });

  it("creates the window lazily from the store snapshot and hides on an empty one", () => {
    const ctx = createCtx();
    const bubble = initNoticeBubble(ctx);
    assert.equal(bubble.getBubbleWindow(), null, "no window before the first notice");

    ctx.noticeStore.push(notice("n1", { title: "Build failed", level: "error" }));
    const win = bubble.getBubbleWindow();
    assert.ok(win, "the first notice creates the window");
    assert.equal(path.basename(win.options.webPreferences.preload), "preload-notice-bubble.js");
    assert.equal(path.basename(win.loadedFile), "notice-bubble.html");
    assert.equal(win.options.transparent, true);
    assert.equal(win.options.focusable, false);
    assert.equal(win.visible, true);

    const shown = win.sent.filter((entry) => entry.channel === "notice-bubble-show");
    assert.ok(shown.length >= 1);
    // The show payload is an object now: the notices plus the presentation
    // hints (theme fill, tail side) the renderer cannot work out for itself.
    assert.deepEqual(shown[shown.length - 1].payload.notices.map((n) => n.id), ["n1"]);
    assert.equal(shown[shown.length - 1].payload.themeId, "clawd", "no theme getter → clawd");
    assert.equal(shown[shown.length - 1].payload.tailSide, null, "no tail getter → no tail");

    ctx.noticeStore.push(notice("n2"));
    assert.deepEqual(
      win.sent[win.sent.length - 1].payload.notices.map((n) => n.id),
      ["n1", "n2"],
      "oldest → newest"
    );

    ctx.noticeStore.clear();
    assert.ok(win.sent.some((entry) => entry.channel === "notice-bubble-hide"));
    bubble.cleanup();
    assert.equal(bubble.getBubbleWindow(), null);
    assert.equal(win.destroyed, true);
  });

  it("sends the theme id and the tail side next to the notices", () => {
    const ctx = createCtx({
      getThemeId: () => "calico",
      getNoticeBubbleTailSide: () => "left",
    });
    const bubble = initNoticeBubble(ctx);
    ctx.noticeStore.push(notice("n1"));
    const win = bubble.getBubbleWindow();
    const payload = win.sent[win.sent.length - 1].payload;
    assert.equal(payload.themeId, "calico");
    assert.equal(payload.tailSide, "left");
    assert.deepEqual(payload.notices, ctx.noticeStore.list());
    bubble.cleanup();
  });

  it("normalizes an unusable theme id and tail side instead of passing them on", () => {
    const ctx = createCtx({
      getThemeId: () => "",
      getNoticeBubbleTailSide: () => "diagonal",
    });
    const bubble = initNoticeBubble(ctx);
    ctx.noticeStore.push(notice("n1"));
    const win = bubble.getBubbleWindow();
    const payload = win.sent[win.sent.length - 1].payload;
    assert.equal(payload.themeId, "clawd", "an empty theme id falls back to clawd");
    assert.equal(payload.tailSide, null, "an unknown edge is not a tail side");
    bubble.cleanup();
  });

  it("sends the bubble style, falling back to pixel for anything unknown", () => {
    for (const [given, expected] of [["comic", "comic"], ["card", "card"], ["pixel", "pixel"], ["neon", "pixel"], [undefined, "pixel"]]) {
      const ctx = createCtx(given === undefined ? {} : { getNoticeStyle: () => given });
      const bubble = initNoticeBubble(ctx);
      ctx.noticeStore.push(notice("n1"));
      const win = bubble.getBubbleWindow();
      assert.equal(win.sent[win.sent.length - 1].payload.style, expected, `style ${String(given)}`);
      bubble.cleanup();
    }
  });

  it("refreshPresentation re-sends the current stack only while presenting", () => {
    let style = "pixel";
    const ctx = createCtx({ getNoticeStyle: () => style });
    const bubble = initNoticeBubble(ctx);
    assert.equal(bubble.refreshPresentation(), false, "no window yet");
    ctx.noticeStore.push(notice("n1"));
    const win = bubble.getBubbleWindow();
    style = "comic";
    const before = win.sent.length;
    assert.equal(bubble.refreshPresentation(), true);
    assert.equal(win.sent.length, before + 1);
    assert.equal(win.sent[win.sent.length - 1].channel, "notice-bubble-show");
    assert.equal(win.sent[win.sent.length - 1].payload.style, "comic");
    bubble.suspendForFullscreen();
    assert.equal(bubble.refreshPresentation(), false, "a suspended bubble waits for its restore");
    bubble.cleanup();
  });

  it("re-sends the presentation when a measured height flips the tail side", () => {
    let side = "top";
    const ctx = createCtx({ getNoticeBubbleTailSide: () => side });
    const bubble = initNoticeBubble(ctx);
    ctx.noticeStore.push(notice("n1"));
    const win = bubble.getBubbleWindow();
    const shows = () => win.sent.filter((entry) => entry.channel === "notice-bubble-show");
    const before = shows().length;
    bubble.handleNoticeBubbleHeight({ sender: win.webContents }, 220);
    assert.equal(shows().length, before, "same side: no re-send");
    side = "bottom";
    bubble.handleNoticeBubbleHeight({ sender: win.webContents }, 260);
    assert.equal(shows().length, before + 1, "the side changed: the tail is told");
    assert.equal(shows()[shows().length - 1].payload.tailSide, "bottom");
    bubble.cleanup();
  });

  it("repositions from the renderer's measured height and clamps it to the work area", () => {
    const ctx = createCtx();
    const bubble = initNoticeBubble(ctx);
    ctx.noticeStore.push(notice("n1"));
    const win = bubble.getBubbleWindow();

    bubble.handleNoticeBubbleHeight({ sender: win.webContents }, 316);
    assert.equal(win.bounds.height, 316);

    bubble.handleNoticeBubbleHeight({ sender: win.webContents }, 5000);
    assert.equal(win.bounds.height, 810, "900 * 0.9 work-area cap");

    bubble.handleNoticeBubbleHeight({ sender: win.webContents }, 0);
    assert.equal(win.bounds.height, 810, "a non-positive height is ignored");

    const before = { ...win.bounds };
    bubble.handleNoticeBubbleHeight({ sender: {} }, 240);
    assert.deepEqual(win.bounds, before, "a foreign sender is ignored");
    bubble.cleanup();
  });

  it("stacks below the permission bubble and the update bubble when following the pet", () => {
    const ctx = createCtx({
      getPermissionBubbleBounds: () => [{ x: 190, y: 174, width: 340, height: 150 }],
      // The update bubble is accepted as a window-like value too.
      getUpdateBubbleBounds: () => ({ getBounds: () => ({ x: 190, y: 330, width: 340, height: 150 }) }),
    });
    const bubble = initNoticeBubble(ctx);
    ctx.noticeStore.push(notice("n1"));
    assert.deepEqual(bubble.getBubbleWindow().bounds, { x: 190, y: 486, width: 340, height: 150 });
    bubble.cleanup();
  });

  it("respects petHidden, fullscreen and the hide/show visibility layers", () => {
    const ctx = createCtx();
    const bubble = initNoticeBubble(ctx);
    ctx.noticeStore.push(notice("n1"));
    const win = bubble.getBubbleWindow();

    assert.equal(bubble.syncVisibility(true), false);
    assert.equal(win.visible, false);
    assert.equal(bubble.syncVisibility(false), true);
    assert.equal(win.visible, true);

    assert.equal(bubble.suspendForFullscreen(), true);
    assert.equal(win.visible, false);
    assert.equal(bubble.resumeFromFullscreen(), true);
    assert.equal(win.visible, true);

    assert.equal(bubble.suspendForPetHidden(), true);
    assert.equal(win.visible, false);
    bubble.cleanup();
  });
});

describe("cards held back for the notice sign", () => {
  function lastShown(win) {
    const shown = win.sent.filter((entry) => entry.channel === "notice-bubble-show");
    return shown.length ? shown[shown.length - 1].payload.notices.map((n) => n.id) : null;
  }

  it("holds a new notice back while the sign shows it, and shows it on reveal", () => {
    let hold = true;
    const asked = [];
    const ctx = createCtx({
      shouldHoldNewNotices: (fresh) => { asked.push(fresh.map((n) => n.id)); return hold; },
    });
    const bubble = initNoticeBubble(ctx);
    ctx.noticeStore.push(notice("n1"));
    assert.deepEqual(asked, [["n1"]]);
    assert.equal(bubble.getBubbleWindow(), null, "no card while the sign has it");
    assert.equal(bubble.hasHeldNotices(), true);

    assert.equal(bubble.revealHeldNotices(), 1);
    const win = bubble.getBubbleWindow();
    assert.deepEqual(lastShown(win), ["n1"]);
    assert.equal(win.visible, true);
    assert.equal(bubble.revealHeldNotices(), 0, "revealing twice is a no-op");

    // A notice the sign does not take shows at once, next to the revealed one.
    hold = false;
    ctx.noticeStore.push(notice("n2"));
    assert.deepEqual(lastShown(win), ["n1", "n2"]);
    bubble.cleanup();
  });

  it("asks only about new notices, never about a keyed refresh or the baseline", () => {
    const ctx = createCtx();
    ctx.noticeStore.push(notice("old"));
    const asked = [];
    ctx.shouldHoldNewNotices = (fresh) => { asked.push(fresh.map((n) => n.id)); return true; };
    const bubble = initNoticeBubble(ctx);
    assert.deepEqual(lastShown(bubble.getBubbleWindow()), ["old"], "the baseline shows as before");

    ctx.noticeStore.push(notice("n1"));
    assert.deepEqual(asked, [["n1"]]);
    assert.deepEqual(lastShown(bubble.getBubbleWindow()), ["old"], "n1 is held");
    // A keyed re-push keeps its id: still held, not asked again.
    ctx.noticeStore.remove("n1");
    ctx.noticeStore.push(notice("n1", { title: "refreshed" }));
    assert.equal(asked.length, 1 + 1, "the re-push after a removal is new again");
    bubble.cleanup();
  });

  it("forgets a held card the store dropped and stays hidden if nothing is left", () => {
    const ctx = createCtx({ shouldHoldNewNotices: () => true });
    const bubble = initNoticeBubble(ctx);
    ctx.noticeStore.push(notice("n1"));
    ctx.noticeStore.remove("n1");
    assert.equal(bubble.hasHeldNotices(), false);
    assert.equal(bubble.revealHeldNotices(), 0);
    assert.equal(bubble.getBubbleWindow(), null);
    bubble.cleanup();
  });

  it("shows the card when the hold predicate throws", () => {
    const ctx = createCtx({ shouldHoldNewNotices: () => { throw new Error("boom"); } });
    const bubble = initNoticeBubble(ctx);
    ctx.noticeStore.push(notice("n1"));
    assert.deepEqual(lastShown(bubble.getBubbleWindow()), ["n1"]);
    bubble.cleanup();
  });

  it("does not copy a held card's text", () => {
    const ctx = createCtx({
      shouldHoldNewNotices: (fresh) => fresh.some((n) => n.id === "n2"),
      writeClipboard: () => {},
    });
    const bubble = initNoticeBubble(ctx);
    ctx.noticeStore.push(notice("n1"));
    ctx.noticeStore.push(notice("n2"));
    const win = bubble.getBubbleWindow();
    const event = { sender: win.webContents };
    assert.equal(bubble.handleNoticeBubbleCopy(event, "n2"), false);
    assert.equal(bubble.handleNoticeBubbleCopy(event, "n1"), true);
    bubble.cleanup();
  });
});

describe("renderer-driven dismissal and expand", () => {
  it("removes the notice the bubble's own renderer dismisses", () => {
    const ctx = createCtx();
    const bubble = initNoticeBubble(ctx);
    ctx.noticeStore.push(notice("n1"));
    ctx.noticeStore.push(notice("n2"));
    const win = bubble.getBubbleWindow();

    assert.equal(bubble.handleNoticeBubbleDismiss({ sender: win.webContents }, "n1"), true);
    assert.deepEqual(ctx.noticeStore.list().map((n) => n.id), ["n2"]);
    bubble.cleanup();
  });

  it("ignores a foreign sender, a non-string id and a store without remove", () => {
    const ctx = createCtx();
    const bubble = initNoticeBubble(ctx);
    ctx.noticeStore.push(notice("n1"));
    const win = bubble.getBubbleWindow();

    assert.equal(bubble.handleNoticeBubbleDismiss({ sender: {} }, "n1"), false);
    assert.equal(bubble.handleNoticeBubbleDismiss({ sender: win.webContents }, 7), false);
    assert.equal(bubble.handleNoticeBubbleDismiss({ sender: win.webContents }, ""), false);
    assert.deepEqual(ctx.noticeStore.list().map((n) => n.id), ["n1"], "nothing was removed");

    const bare = createCtx({ noticeStore: {} });
    const bareBubble = initNoticeBubble(bare);
    bareBubble.showNoticeBubble([notice("n1")]);
    assert.equal(
      bareBubble.handleNoticeBubbleDismiss({ sender: bareBubble.getBubbleWindow().webContents }, "n1"),
      false,
      "a store without remove() is a no-op, not a throw"
    );
    bubble.cleanup();
    bareBubble.cleanup();
  });

  it("records the expand request from the bubble's own renderer", () => {
    const ctx = createCtx();
    const bubble = initNoticeBubble(ctx);
    ctx.noticeStore.push(notice("n1", { kind: "trend" }));
    const win = bubble.getBubbleWindow();

    assert.equal(bubble.getExpandedNoticeId(), null);
    assert.equal(bubble.handleNoticeBubbleExpand({ sender: win.webContents }, "n1"), true);
    assert.equal(bubble.getExpandedNoticeId(), "n1");
    assert.equal(bubble.handleNoticeBubbleExpand({ sender: {} }, "n2"), false);
    assert.equal(bubble.getExpandedNoticeId(), "n1", "a foreign sender changes nothing");
    bubble.cleanup();
    assert.equal(bubble.getExpandedNoticeId(), null, "cleanup drops the recorded id");
  });

  it("copies a card's text from the store, only for its own renderer", () => {
    const written = [];
    const ctx = createCtx({ writeClipboard: (text) => written.push(text) });
    const bubble = initNoticeBubble(ctx);
    ctx.noticeStore.push(notice("n1", { title: "推送被拒了", body: "member_check 拦下了" }));
    ctx.noticeStore.push(notice("n2", {
      title: "引擎发布监控", body: "", kind: "trend",
      series: [
        { name: "耗时", points: [150, 174], value: 174, unit: "ms" },
        { name: "失败率", points: [0.08, 0.18], value: null, unit: "%" },
      ],
    }));
    const win = bubble.getBubbleWindow();

    assert.equal(bubble.handleNoticeBubbleCopy({ sender: win.webContents }, "n1"), true);
    assert.equal(written.pop(), "推送被拒了\nmember_check 拦下了");
    assert.equal(bubble.handleNoticeBubbleCopy({ sender: win.webContents }, "n2"), true);
    assert.equal(written.pop(), "引擎发布监控\n耗时 174ms\n失败率 0.18%", "a null value falls back to the last point");

    assert.equal(bubble.handleNoticeBubbleCopy({ sender: {} }, "n1"), false, "a foreign sender copies nothing");
    assert.equal(bubble.handleNoticeBubbleCopy({ sender: win.webContents }, "gone"), false, "an unknown id copies nothing");
    assert.equal(bubble.handleNoticeBubbleCopy({ sender: win.webContents }, ""), false);
    assert.equal(written.length, 0);

    const failing = initNoticeBubble(createCtx({ writeClipboard: () => { throw new Error("busy"); } }));
    failing.showNoticeBubble([notice("n3")]);
    assert.equal(failing.handleNoticeBubbleCopy({ sender: failing.getBubbleWindow().webContents }, "n3"), false,
      "a clipboard failure is reported, not thrown");
    failing.cleanup();
    bubble.cleanup();
  });
});

describe("registerNoticeBubbleIpc", () => {
  it("registers the height, dismiss, expand and copy channels and disposes them", () => {
    const channels = [];
    const removed = [];
    const ipcMain = {
      on: (channel, listener) => channels.push({ channel, listener }),
      removeListener: (channel) => removed.push(channel),
    };
    const forwarded = [];
    const registration = registerNoticeBubbleIpc({
      ipcMain,
      noticeBubble: {
        handleNoticeBubbleHeight: (event, height) => { forwarded.push(["height", event, height]); },
        handleNoticeBubbleDismiss: (event, id) => { forwarded.push(["dismiss", event, id]); },
        handleNoticeBubbleExpand: (event, id) => { forwarded.push(["expand", event, id]); },
        handleNoticeBubbleCopy: (event, id) => { forwarded.push(["copy", event, id]); },
      },
    });
    assert.deepEqual(
      channels.map((entry) => entry.channel),
      ["notice-bubble-height", "notice-bubble-dismiss", "notice-bubble-expand", "notice-bubble-copy"]
    );
    for (const entry of channels) entry.listener("evt", 120);
    assert.deepEqual(forwarded, [
      ["height", "evt", 120],
      ["dismiss", "evt", 120],
      ["expand", "evt", 120],
      ["copy", "evt", 120],
    ]);
    registration.dispose();
    // dispose() unwinds its disposers LIFO, so compare as a set.
    assert.deepEqual(
      removed.slice().sort(),
      ["notice-bubble-copy", "notice-bubble-dismiss", "notice-bubble-expand", "notice-bubble-height"]
    );
  });

  it("requires ipcMain and every handler the bubble exposes", () => {
    const handlers = {
      handleNoticeBubbleHeight() {},
      handleNoticeBubbleDismiss() {},
      handleNoticeBubbleExpand() {},
      handleNoticeBubbleCopy() {},
    };
    assert.throws(() => registerNoticeBubbleIpc({}), /registerNoticeBubbleIpc requires ipcMain/);
    assert.throws(
      () => registerNoticeBubbleIpc({ ipcMain: { on() {}, removeListener() {} } }),
      /registerNoticeBubbleIpc requires noticeBubble/
    );
    assert.throws(
      () => registerNoticeBubbleIpc({ ipcMain: { on() {}, removeListener() {} }, noticeBubble: {} }),
      /registerNoticeBubbleIpc requires noticeBubble.handleNoticeBubbleHeight/
    );
    assert.throws(
      () => registerNoticeBubbleIpc({
        ipcMain: { on() {}, removeListener() {} },
        noticeBubble: { handleNoticeBubbleHeight() {} },
      }),
      /registerNoticeBubbleIpc requires noticeBubble.handleNoticeBubbleDismiss/
    );
    assert.throws(
      () => registerNoticeBubbleIpc({
        ipcMain: { on() {}, removeListener() {} },
        noticeBubble: { handleNoticeBubbleHeight() {}, handleNoticeBubbleDismiss() {} },
      }),
      /registerNoticeBubbleIpc requires noticeBubble.handleNoticeBubbleExpand/
    );
    assert.throws(
      () => registerNoticeBubbleIpc({
        ipcMain: { on() {}, removeListener() {} },
        noticeBubble: { handleNoticeBubbleHeight() {}, handleNoticeBubbleDismiss() {}, handleNoticeBubbleExpand() {} },
      }),
      /registerNoticeBubbleIpc requires noticeBubble.handleNoticeBubbleCopy/
    );
    const registration = registerNoticeBubbleIpc({
      ipcMain: { on() {}, removeListener() {} },
      noticeBubble: handlers,
    });
    assert.equal(typeof registration.dispose, "function");
  });
});

describe("notice-bubble.html", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "notice-bubble.html"), "utf8");
  const document = parseDocument(html);

  function findAll(node, predicate, found) {
    const out = found || [];
    if (predicate(node)) out.push(node);
    for (const child of node.children || []) findAll(child, predicate, out);
    return out;
  }

  function textOf(node) {
    if (node.type === "text") return node.data || "";
    let text = "";
    for (const child of node.children || []) text += textOf(child);
    return text;
  }

  it("carries exactly one inline script, and it compiles", () => {
    const scripts = findAll(document, (node) => node.name === "script");
    assert.equal(scripts.length, 1, "exactly one <script>");
    assert.ok(!scripts[0].attribs || !scripts[0].attribs.src, "the script is inline");
    const source = textOf(scripts[0]);
    assert.ok(source.trim().length > 0, "the inline script has a body");
    assert.doesNotThrow(() => new vm.Script(source, { filename: "notice-bubble.html" }));
  });

  it("pulls in nothing external", () => {
    const external = findAll(document, (node) => !!(node.attribs && (node.attribs.src || node.attribs.href)));
    assert.deepEqual(external.map((node) => node.name), [], "no src/href attributes");
    const links = findAll(document, (node) => node.name === "link" || node.name === "iframe" || node.name === "img");
    assert.deepEqual(links.map((node) => node.name), []);
  });

  it("never assigns notice-derived text through the HTML parser", () => {
    const source = textOf(findAll(document, (node) => node.name === "script")[0]);
    assert.doesNotMatch(source, /innerHTML/);
    assert.doesNotMatch(source, /outerHTML/);
    assert.doesNotMatch(source, /insertAdjacentHTML/);
    assert.doesNotMatch(source, /document\.write/);
  });

  it("routes dismiss and expand through the preload bridge", () => {
    const source = textOf(findAll(document, (node) => node.name === "script")[0]);
    assert.match(source, /window\.noticeBubbleAPI\.dismiss\(/);
    assert.match(source, /window\.noticeBubbleAPI\.expand\(/);
  });

  it("copies on right-click through the bridge, leaving left-click alone", () => {
    const source = textOf(findAll(document, (node) => node.name === "script")[0]);
    const handler = source.match(/card\.addEventListener\("contextmenu", \(event\) => \{([\s\S]*?)\n  \}\);/);
    assert.ok(handler, "the card listens for contextmenu");
    assert.match(handler[1], /event\.preventDefault\(\);/, "no native menu");
    assert.match(handler[1], /window\.noticeBubbleAPI\.copy\(id\);/, "only the id crosses the bridge");
    assert.doesNotMatch(handler[1], /dismiss|expand/, "a right-click never closes or expands");
    assert.doesNotMatch(source, /navigator\.clipboard|document\.execCommand/, "the page never touches the clipboard");
    const preload = fs.readFileSync(path.join(__dirname, "..", "src", "preload-notice-bubble.js"), "utf8");
    assert.match(preload, /copy: \(id\) => ipcRenderer\.send\("notice-bubble-copy", id\)/);
  });

  // The card was a generic soft-UI panel: hairline border, big radius, blurred
  // shadow, pastel fill. These assert the pet's own vocabulary instead.
  it("dresses the card in the pet's outline, flat fill and hard shadow", () => {
    const css = textOf(findAll(document, (node) => node.name === "style")[0]);
    assert.match(css, /border: 2\.5px solid #000;/);
    assert.match(css, /border-radius: 9px;/);
    assert.match(css, /box-shadow: 2px 2px 0 rgba\(0, 0, 0, 0\.22\);/);
    assert.match(css, /background: var\(--card-fill, #DE886D\);/);
    assert.match(css, /\.level-bar \{[\s\S]*?width: 3px;/);
    assert.doesNotMatch(css, /--card-bg|--card-border|--card-inset|linear-gradient/);
  });

  it("takes the fill from the active theme and keeps the text dark", () => {
    const css = textOf(findAll(document, (node) => node.name === "style")[0]);
    const source = textOf(findAll(document, (node) => node.name === "script")[0]);
    assert.match(css, /\.card\[data-theme="clawd"\]\s+\{ --card-fill: #DE886D; \}/);
    assert.match(css, /\.card\[data-theme="calico"\]\s+\{ --card-fill: #E8A354; \}/);
    assert.match(css, /\.card\[data-theme="cloudling"\]\s+\{ --card-fill: #B1A7FF; \}/);
    assert.match(css, /--header-color: #1a1a1f;/);
    assert.match(css, /--text-main: #3a3a42;/);
    assert.match(source, /element\.dataset\.theme = presentation\.themeId;/);
  });

  it("prefixes a level glyph to the first line, never to the corner", () => {
    const source = textOf(findAll(document, (node) => node.name === "script")[0]);
    const glyphs = source.match(/const LEVEL_GLYPHS = \{([^}]*)\};/);
    assert.ok(glyphs, "the level glyph map is declared");
    assert.match(glyphs[1], /info: "ℹ"/);
    assert.match(glyphs[1], /success: "✓"/);
    assert.match(glyphs[1], /warn: "⚠"/);
    assert.match(glyphs[1], /error: "✗"/);
    assert.match(
      source,
      /firstLine\.insertBefore\(buildLevelGlyph\(level\), firstLine\.firstChild\)/,
      "the glyph leads the title line rather than the card"
    );
    assert.match(
      textOf(findAll(document, (node) => node.name === "style")[0]),
      /\.level-glyph \{[\s\S]*?color: var\(--header-color\);[\s\S]*?opacity: 0\.5;/,
      "the glyph is a muted title, not a second dismiss button"
    );
  });

  it("builds a three-circle tail that curves, only for a short stack", () => {
    const source = textOf(findAll(document, (node) => node.name === "script")[0]);
    const css = textOf(findAll(document, (node) => node.name === "style")[0]);
    const circles = source.match(/const TAIL_CIRCLES = \[([\s\S]*?)\];/);
    assert.ok(circles, "the tail circles are declared");
    const entries = circles[1].match(/\{ cx: ([\d.]+), cy: ([\d.]+), r: ([\d.]+) \}/g);
    assert.equal(entries.length, 3, "three tapering circles");
    const points = entries.map((entry) => entry.match(/[\d.]+/g).map(Number));
    // Tapering: each circle is smaller than the one nearer the card.
    assert.ok(points[0][2] > points[1][2] && points[1][2] > points[2][2], "radii taper");
    // Curved: the middle circle sits off the chord between the other two, so the
    // trail arcs outward instead of stacking in a straight line — while still
    // travelling away from the card.
    const chordMidX = (points[0][0] + points[2][0]) / 2;
    assert.ok(Math.abs(points[1][0] - chordMidX) >= 1, "the tail arcs along X");
    assert.ok(
      points[1][1] > points[0][1] && points[1][1] < points[2][1],
      "and keeps travelling away from the card"
    );
    assert.match(source, /createElementNS\(SVG_NS, "circle"\)/);
    assert.match(source, /next\.length <= MAX_TAIL_CARDS/, "a long stack drops the tail");
    assert.match(css, /\.tail circle \{[\s\S]*?fill: var\(--card-fill, #DE886D\);[\s\S]*?stroke: #000;[\s\S]*?stroke-width: 2\.5;/);
    for (const side of ["top", "right", "bottom", "left"]) {
      assert.ok(css.includes(`.card[data-tail="${side}"] .tail`), `${side} tail rule`);
    }
    // The gutter the tail pokes into is padding on the stack, not the body: the
    // stack is a scroll container and clips anything outside its padding box.
    assert.match(css, /\.stack \{[\s\S]*?padding: var\(--gutter-top\) var\(--gutter-right\)/);
    assert.match(css, /body\[data-tail="bottom"\] \{ --gutter-bottom: 20px; \}/);
    assert.match(source, /document\.body\.dataset\.tail = side;/);
    assert.match(source, /delete document\.body\.dataset\.tail;/);
  });

  it("gives the tail an entrance wiggle and a per-level pose", () => {
    const source = textOf(findAll(document, (node) => node.name === "script")[0]);
    const css = textOf(findAll(document, (node) => node.name === "style")[0]);
    assert.match(source, /createElementNS\(SVG_NS, "g"\)/);
    assert.match(source, /setAttribute\("class", "tail-swing"\)/);
    assert.match(source, /setAttribute\("class", "tail-pose"\)/);
    // The wiggle runs once and stops; only the warn pose keeps moving.
    assert.match(css, /\.tail-swing \{ animation: tail-wiggle 1000ms var\(--ease-back\) 1 forwards; \}/);
    assert.match(css, /25% \{ transform: rotate\(-14deg\); \}/);
    assert.match(css, /75% \{ transform: rotate\(10deg\); \}/);
    assert.match(css, /\.card\[data-level="success"\] \.tail-pose \{ transform: rotate\(28deg\); \}/);
    assert.match(css, /\.card\[data-level="error"\] \.tail-pose \{ transform: rotate\(-28deg\); \}/);
    assert.match(css, /\.card\[data-level="warn"\] \.tail-pose \{ animation: tail-sway 500ms ease-in-out 1000ms infinite; \}/);
    // Both groups pivot on the circle nearest the card.
    assert.match(css, /transform-origin: 5px 5px;/);
  });

  it("gives the card a pair of eyes, never in the dismiss corner", () => {
    const source = textOf(findAll(document, (node) => node.name === "script")[0]);
    const css = textOf(findAll(document, (node) => node.name === "style")[0]);
    assert.match(source, /const EYE_COUNT = 2;/);
    assert.match(source, /element\.dataset\.eyes = face \? "on" : "off";/);
    assert.match(source, /const face = elements\.length > 0 && elements\.length <= MAX_TAIL_CARDS;/);
    assert.match(css, /\.eye \{[\s\S]*?width: 4px;[\s\S]*?height: 4px;[\s\S]*?border: 2\.5px solid #000;[\s\S]*?border-radius: 50%;/);
    assert.match(css, /\.card-eyes \{[\s\S]*?top: 7px;[\s\S]*?left: 8px;/);
    assert.doesNotMatch(css, /\.card-eyes \{[\s\S]{0,200}?right:/, "the eyes stay out of the top-right corner");
    // The blink: closed for the tail end of every 2.1s cycle.
    assert.match(css, /\.eye \{[\s\S]*?animation: card-blink 2\.1s infinite;/);
    assert.match(css, /86%, 100% \{ clip-path: inset\(45% 0\); \}/);
    // The gaze follows the side the pet is on, and stays centred otherwise.
    assert.match(source, /const gaze = side === "left" \|\| side === "right" \? side : "center";/);
    assert.match(css, /\.card\[data-gaze="right"\] \.card-eyes \{ transform: translateX\(1px\); \}/);
    assert.match(css, /\.card\[data-gaze="left"\] \.card-eyes \{ transform: translateX\(-1px\); \}/);
  });

  it("bounces a card on its first render only", () => {
    const source = textOf(findAll(document, (node) => node.name === "script")[0]);
    const css = textOf(findAll(document, (node) => node.name === "style")[0]);
    assert.match(css, /\.card\.entering \{ animation: card-enter 400ms var\(--ease-bounce\); \}/);
    assert.match(css, /from \{ transform: translateX\(16px\) scale\(0\.94\); opacity: 0; \}/);
    assert.match(css, /to \{ transform: translateX\(0\) scale\(1\); opacity: 1; \}/);
    // The class goes on in the branch that creates the element — the diff keeps
    // every other card, so a reorder cannot re-bounce the stack.
    assert.match(
      source,
      /if \(!element\) \{\s*element = buildCard\(entry\.notice\);\s*\/\/[\s\S]*?\n\s*if \(desired\.length <= MAX_TAIL_CARDS\) element\.classList\.add\("entering"\);/
    );
  });

  it("switches style through one body attribute and keeps the card style intact", () => {
    const source = textOf(findAll(document, (node) => node.name === "script")[0]);
    const css = textOf(findAll(document, (node) => node.name === "style")[0]);
    assert.match(source, /const NOTICE_STYLES = new Set\(\["pixel", "comic", "card"\]\);/);
    assert.match(source, /document\.body\.dataset\.noticeStyle = NOTICE_STYLES\.has\(data\.style\) \? data\.style : DEFAULT_NOTICE_STYLE;/);
    assert.match(source, /const DEFAULT_NOTICE_STYLE = "pixel";/);
    // Every rule after the style marker is scoped to a non-card style, so the
    // sticker card above it is exactly what it was.
    assert.ok(css.includes("/* ── Notice styles"), "the style section is declared");
    const tail = css.slice(css.indexOf("/* ── Notice styles")).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of tail.match(/^[^@{}\n/][^{}]*\{/gm) || []) {
      if (/^\s*(from|to|\d+%)/.test(rule) || /^\s*\.skin-/.test(rule)) continue;
      assert.match(rule, /body\[data-notice-style/, `scoped: ${rule.trim()}`);
      assert.doesNotMatch(rule, /data-notice-style="card"/, "the card style gets no overrides");
    }
  });

  it("bundles its display fonts locally and lets the CSP load them", () => {
    const css = textOf(findAll(document, (node) => node.name === "style")[0]);
    const csp = findAll(document, (node) => node.name === "meta" && node.attribs["http-equiv"] === "Content-Security-Policy")[0];
    assert.match(csp.attribs.content, /font-src 'self' file:/);
    assert.match(csp.attribs.content, /img-src data:/);
    for (const file of css.match(/url\("fonts\/[^"]+"\)/g) || []) {
      const name = file.slice(5, -2);
      assert.ok(fs.existsSync(path.join(__dirname, "..", "src", name)), `${name} is shipped`);
    }
    assert.equal((css.match(/@font-face/g) || []).length, 3);
  });

  it("stands still for prefers-reduced-motion", () => {
    const css = textOf(findAll(document, (node) => node.name === "style")[0]);
    const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/);
    assert.ok(block, "the reduced-motion block is declared");
    assert.match(block[1], /\.card\.entering \{ animation: none; \}/);
    assert.match(block[1], /\.tail-swing,\s*\n\s*\.tail-pose \{ animation: none; transition: none; \}/);
    assert.match(block[1], /\.eye \{ animation: none; \}/);
    assert.match(block[1], /\.card\[data-eyes="on"\] \.card-eyes \{ display: none; \}/);
  });
});
