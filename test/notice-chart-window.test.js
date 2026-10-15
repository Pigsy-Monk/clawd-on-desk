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
    this.windowListeners = new Map();
    this.webContentsListeners = new Map();
    const self = this;
    this.webContents = {
      isLoading: () => false,
      isDestroyed: () => self.destroyed,
      insertCSS: () => Promise.resolve("key"),
      removeInsertedCSS: () => Promise.resolve(),
      setZoomFactor: () => {},
      send: (channel, payload) => self.sent.push({ channel, payload }),
      once: () => {},
      on: (channel, listener) => {
        const list = self.webContentsListeners.get(channel) || [];
        list.push(listener);
        self.webContentsListeners.set(channel, list);
      },
    };
    windows.set(this.webContents, this);
  }

  static fromWebContents(contents) { return windows.get(contents) || null; }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  getBounds() { return this.bounds; }
  loadFile(file) { this.loadedFile = file; }
  setAlwaysOnTop() {}
  setBounds(bounds) { this.bounds = bounds; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  destroy() { this.destroyed = true; }
  on(channel, listener) {
    const list = this.windowListeners.get(channel) || [];
    list.push(listener);
    this.windowListeners.set(channel, list);
  }
}

const originalLoad = Module._load;
let initNoticeChartWindow;
try {
  Module._load = function (request) {
    if (request === "electron") return { BrowserWindow: FakeBrowserWindow };
    return originalLoad.apply(this, arguments);
  };
  initNoticeChartWindow = require("../src/notice-chart-window");
} finally {
  Module._load = originalLoad;
}
const { registerNoticeChartIpc } = initNoticeChartWindow;
const { readPngSize, computeChartWindowSize } = initNoticeChartWindow.__test;

// A real PNG header: signature, the IHDR chunk (length, type, width, height,
// bit depth / colour type / compression / filter / interlace) and its CRC.
function pngData(width, height) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  header[25] = 6;
  return header.toString("base64");
}

const SOURCE_CHART = { width: 1430, height: 1105 };

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
      return notice;
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

function trendNotice(id, overrides = {}) {
  return {
    id,
    title: "CPU trend",
    body: "",
    level: "warn",
    kind: "trend",
    series: [{ name: "cpu", points: [1, 2], value: 2, unit: "%" }],
    image: { mime: "image/png", data: pngData(SOURCE_CHART.width, SOURCE_CHART.height) },
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
    getPetWindowBounds: () => ({ x: 900, y: 400, width: 120, height: 120 }),
    getBubbleWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => ({ left: 920, top: 428, right: 1000, bottom: 508 }),
    getUpdateBubbleAnchorRect: () => ({ left: 920, top: 428, right: 1000, bottom: 508 }),
    getTextScale: () => 1,
    getPermissionBubbleBounds: () => [],
    getSessionHudBounds: () => [],
    noticeStore: createFakeStore(),
    ...overrides,
  };
}

describe("PNG header sizing", () => {
  it("reads the natural pixel size out of a PNG's IHDR chunk", () => {
    assert.deepEqual(readPngSize({ data: pngData(1430, 1105) }), { width: 1430, height: 1105 });
    assert.deepEqual(readPngSize({ data: pngData(1, 1) }), { width: 1, height: 1 });
  });

  it("degrades to unknown rather than throwing on anything unexpected", () => {
    assert.equal(readPngSize(null), null);
    assert.equal(readPngSize({}), null);
    assert.equal(readPngSize({ data: 42 }), null);
    assert.equal(readPngSize({ data: "AAAA" }), null, "too short to hold a header");
    assert.equal(
      readPngSize({ data: Buffer.alloc(33).toString("base64") }),
      null,
      "no PNG signature"
    );

    const wrongChunk = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(wrongChunk, 0);
    wrongChunk.writeUInt32BE(13, 8);
    wrongChunk.write("IDAT", 12, "latin1");
    assert.equal(readPngSize({ data: wrongChunk.toString("base64") }), null, "first chunk is not IHDR");

    const zeroWidth = Buffer.from(pngData(1430, 1105), "base64");
    zeroWidth.writeUInt32BE(0, 16);
    assert.equal(readPngSize({ data: zeroWidth.toString("base64") }), null);
  });
});

describe("chart window sizing", () => {
  const big = { x: 0, y: 0, width: 1920, height: 1080 };

  it("fits the source chart's aspect ratio at the comfortable target width", () => {
    assert.deepEqual(
      computeChartWindowSize({ natural: SOURCE_CHART, workArea: big, scale: 1 }),
      { width: 900, height: 768 }
    );
  });

  it("never blows a small chart up past its own pixels", () => {
    assert.deepEqual(
      computeChartWindowSize({ natural: { width: 400, height: 300 }, workArea: big, scale: 1 }),
      { width: 400, height: 372 }
    );
  });

  it("opens at the placeholder size while the image's size is unknown", () => {
    assert.deepEqual(
      computeChartWindowSize({ natural: null, workArea: big, scale: 1 }),
      { width: 900, height: 640 }
    );
  });

  it("squeezes the width rather than exceeding 85% of a small work area", () => {
    const size = computeChartWindowSize({
      natural: SOURCE_CHART,
      workArea: { x: 0, y: 0, width: 800, height: 600 },
      scale: 1,
    });
    assert.deepEqual(size, { width: 566, height: 510 });
    assert.ok(size.width <= 800 * 0.85 && size.height <= 600 * 0.85);
  });

  it("tracks the text scale without ever upscaling the image", () => {
    const size = computeChartWindowSize({ natural: SOURCE_CHART, workArea: big, scale: 1.6 });
    assert.deepEqual(size, { width: 1037, height: 918 });
    assert.ok(size.width <= SOURCE_CHART.width, "capped at the image's own pixels");
    assert.ok(size.height <= big.height * 0.85);
  });
});

describe("notice chart contract", () => {
  it("returns every method main.js wires", () => {
    const chart = initNoticeChartWindow(createCtx());
    for (const name of [
      "showNoticeChart",
      "hideNoticeChart",
      "repositionNoticeChart",
      "handleNoticeChartHeight",
      "handleNoticeChartClose",
      "syncVisibility",
      "suspendForPetHidden",
      "suspendForFullscreen",
      "resumeFromFullscreen",
      "cleanup",
      "getBubbleWindow",
    ]) {
      assert.equal(typeof chart[name], "function", `${name} must be a function`);
    }
    assert.equal(chart.getBubbleWindow(), null);
    chart.cleanup();
  });

  it("creates the window lazily, sized from the chart, and forwards only the drawn fields", () => {
    const ctx = createCtx();
    const chart = initNoticeChartWindow(ctx);
    assert.equal(chart.getBubbleWindow(), null, "no window before the first open");

    assert.equal(chart.showNoticeChart(trendNotice("n1")), true);
    const win = chart.getBubbleWindow();
    assert.ok(win, "the first open creates the window");
    assert.equal(path.basename(win.options.webPreferences.preload), "preload-notice-chart.js");
    assert.equal(path.basename(win.loadedFile), "notice-chart.html");
    assert.equal(win.options.transparent, true);
    assert.equal(win.options.frame, false);
    assert.equal(win.options.resizable, false);
    assert.equal(win.options.skipTaskbar, true);
    assert.equal(win.options.hasShadow, false);
    assert.equal(win.options.focusable, false);
    assert.equal(win.options.show, false);
    assert.equal(win.visible, true);
    // Anchored beside the pet (the follow-pet path), clamped into the work area.
    assert.deepEqual(win.bounds, { x: 1006, y: 84, width: 900, height: 768 });

    const shown = win.sent.filter((entry) => entry.channel === "notice-chart-show");
    assert.equal(shown.length, 1);
    assert.deepEqual(Object.keys(shown[0].payload).sort(), ["id", "image", "level", "title"]);
    assert.equal(shown[0].payload.id, "n1");
    assert.equal(shown[0].payload.title, "CPU trend");
    assert.equal(shown[0].payload.level, "warn");
    assert.equal(shown[0].payload.image.mime, "image/png");
    assert.equal(shown[0].payload.image.data, pngData(SOURCE_CHART.width, SOURCE_CHART.height));
    chart.cleanup();
  });

  it("refuses a notice with no verified PNG to expand", () => {
    const ctx = createCtx();
    const chart = initNoticeChartWindow(ctx);
    assert.equal(chart.showNoticeChart(trendNotice("n1", { image: null })), false);
    assert.equal(chart.showNoticeChart(trendNotice("n1", { image: { mime: "image/png", data: "" } })), false);
    assert.equal(chart.showNoticeChart(null), false);
    assert.equal(chart.getBubbleWindow(), null, "nothing was opened");
    chart.cleanup();
  });

  it("hides without destroying, so the next open reuses the same window", () => {
    const ctx = createCtx();
    const chart = initNoticeChartWindow(ctx);
    chart.showNoticeChart(trendNotice("n1"));
    const win = chart.getBubbleWindow();

    assert.equal(chart.handleNoticeChartClose({ sender: win.webContents }), true);
    assert.ok(win.sent.some((entry) => entry.channel === "notice-chart-hide"));
    assert.equal(win.destroyed, false);

    assert.equal(chart.showNoticeChart(trendNotice("n2")), true);
    assert.equal(chart.getBubbleWindow(), win, "the same window comes back");
    assert.equal(win.destroyed, false);
    const shown = win.sent.filter((entry) => entry.channel === "notice-chart-show");
    assert.equal(shown[shown.length - 1].payload.id, "n2");
    chart.cleanup();
  });

  it("closes when the shown notice leaves the store", () => {
    const ctx = createCtx();
    const chart = initNoticeChartWindow(ctx);
    const notice = ctx.noticeStore.push(trendNotice("n1"));
    chart.showNoticeChart(notice);
    const win = chart.getBubbleWindow();

    // Another notice arriving is none of this window's business.
    ctx.noticeStore.push(trendNotice("n2"));
    assert.ok(!win.sent.some((entry) => entry.channel === "notice-chart-hide"));

    ctx.noticeStore.remove("n1");
    assert.ok(win.sent.some((entry) => entry.channel === "notice-chart-hide"));
    chart.cleanup();
  });

  it("repositions from the renderer's measured height and clamps it to the work area", () => {
    const ctx = createCtx();
    const chart = initNoticeChartWindow(ctx);
    chart.showNoticeChart(trendNotice("n1"));
    const win = chart.getBubbleWindow();

    chart.handleNoticeChartHeight({ sender: win.webContents }, 700);
    assert.equal(win.bounds.height, 700);

    chart.handleNoticeChartHeight({ sender: win.webContents }, 5000);
    assert.equal(win.bounds.height, 918, "1080 * 0.85 work-area cap");

    chart.handleNoticeChartHeight({ sender: win.webContents }, 0);
    assert.equal(win.bounds.height, 918, "a non-positive height is ignored");

    const before = { ...win.bounds };
    chart.handleNoticeChartHeight({ sender: {} }, 240);
    assert.deepEqual(win.bounds, before, "a foreign sender is ignored");
    chart.cleanup();
  });

  it("ignores a close from any window but its own", () => {
    const ctx = createCtx();
    const chart = initNoticeChartWindow(ctx);
    chart.showNoticeChart(trendNotice("n1"));
    const win = chart.getBubbleWindow();

    assert.equal(chart.handleNoticeChartClose({ sender: {} }), false);
    assert.ok(!win.sent.some((entry) => entry.channel === "notice-chart-hide"));
    chart.cleanup();
  });

  it("dodges the notice stack, the permission stack, the HUD and the update bubble", () => {
    // The pet's follow slot (the right side, vertically centred) is taken by
    // the notice stack, so the chart has to land somewhere else entirely. The
    // stack is handed over window-like to cover the getBounds() shape too.
    const blocker = { x: 1000, y: 60, width: 340, height: 400 };
    const ctx = createCtx({
      getNoticeBubbleBounds: () => ({ getBounds: () => ({ ...blocker }) }),
      getPermissionBubbleBounds: () => [],
      getSessionHudBounds: () => [],
      getUpdateBubbleBounds: () => null,
    });
    const chart = initNoticeChartWindow(ctx);
    chart.showNoticeChart(trendNotice("n1"));
    const bounds = chart.getBubbleWindow().bounds;

    assert.notDeepEqual(
      { x: bounds.x, y: bounds.y },
      { x: 1006, y: 84 },
      "it did not take the blocked follow slot"
    );
    const overlaps = bounds.x < blocker.x + blocker.width
      && bounds.x + bounds.width > blocker.x
      && bounds.y < blocker.y + blocker.height
      && bounds.y + bounds.height > blocker.y;
    assert.equal(overlaps, false, "no overlap with the notice stack");
    assert.ok(bounds.x >= 0 && bounds.y >= 0, "inside the work area");
    assert.ok(bounds.x + bounds.width <= 1920 && bounds.y + bounds.height <= 1080);
    chart.cleanup();
  });

  it("respects petHidden, fullscreen and the hide/show visibility layers", () => {
    const ctx = createCtx();
    const chart = initNoticeChartWindow(ctx);
    chart.showNoticeChart(trendNotice("n1"));
    const win = chart.getBubbleWindow();

    assert.equal(chart.syncVisibility(true), false);
    assert.equal(win.visible, false);
    assert.equal(chart.syncVisibility(false), true);
    assert.equal(win.visible, true);

    assert.equal(chart.suspendForFullscreen(), true);
    assert.equal(win.visible, false);
    assert.equal(chart.resumeFromFullscreen(), true);
    assert.equal(win.visible, true);

    assert.equal(chart.suspendForPetHidden(), true);
    assert.equal(win.visible, false);
    chart.cleanup();
  });

  it("wires the closes that need input the window itself never receives", () => {
    const ctx = createCtx();
    const chart = initNoticeChartWindow(ctx);
    chart.showNoticeChart(trendNotice("n1"));
    const win = chart.getBubbleWindow();

    assert.equal(typeof (win.windowListeners.get("blur") || [])[0], "function");
    const inputListener = (win.webContentsListeners.get("before-input-event") || [])[0];
    assert.equal(typeof inputListener, "function");

    let prevented = false;
    inputListener({ preventDefault: () => { prevented = true; } }, { type: "keyDown", key: "Escape" });
    assert.equal(prevented, true);
    assert.ok(win.sent.some((entry) => entry.channel === "notice-chart-hide"));
    chart.cleanup();
  });

  it("drops the window and the subscription on cleanup", () => {
    const ctx = createCtx();
    const chart = initNoticeChartWindow(ctx);
    chart.showNoticeChart(trendNotice("n1"));
    const win = chart.getBubbleWindow();

    chart.cleanup();
    assert.equal(chart.getBubbleWindow(), null);
    assert.equal(win.destroyed, true);
    // The store listener is gone: a later snapshot must not throw.
    ctx.noticeStore.push(trendNotice("n2"));
    assert.equal(chart.showNoticeChart(null), false);
  });
});

describe("registerNoticeChartIpc", () => {
  it("registers the height and close channels and disposes them", () => {
    const channels = [];
    const removed = [];
    const ipcMain = {
      on: (channel, listener) => channels.push({ channel, listener }),
      removeListener: (channel) => removed.push(channel),
    };
    const forwarded = [];
    const registration = registerNoticeChartIpc({
      ipcMain,
      noticeChart: {
        handleNoticeChartHeight: (event, height) => { forwarded.push(["height", event, height]); },
        handleNoticeChartClose: (event) => { forwarded.push(["close", event]); },
      },
    });
    assert.deepEqual(
      channels.map((entry) => entry.channel),
      ["notice-chart-height", "notice-chart-close"]
    );
    for (const entry of channels) entry.listener("evt", 120);
    assert.deepEqual(forwarded, [["height", "evt", 120], ["close", "evt"]]);
    registration.dispose();
    assert.deepEqual(removed.slice().sort(), ["notice-chart-close", "notice-chart-height"]);
  });

  it("requires ipcMain and every handler the chart window exposes", () => {
    assert.throws(() => registerNoticeChartIpc({}), /registerNoticeChartIpc requires ipcMain/);
    assert.throws(
      () => registerNoticeChartIpc({ ipcMain: { on() {}, removeListener() {} } }),
      /registerNoticeChartIpc requires noticeChart/
    );
    assert.throws(
      () => registerNoticeChartIpc({ ipcMain: { on() {}, removeListener() {} }, noticeChart: {} }),
      /registerNoticeChartIpc requires noticeChart.handleNoticeChartHeight/
    );
    assert.throws(
      () => registerNoticeChartIpc({
        ipcMain: { on() {}, removeListener() {} },
        noticeChart: { handleNoticeChartHeight() {} },
      }),
      /registerNoticeChartIpc requires noticeChart.handleNoticeChartClose/
    );
    const registration = registerNoticeChartIpc({
      ipcMain: { on() {}, removeListener() {} },
      noticeChart: { handleNoticeChartHeight() {}, handleNoticeChartClose() {} },
    });
    assert.equal(typeof registration.dispose, "function");
  });
});

describe("notice-chart.html", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "notice-chart.html"), "utf8");
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
    assert.doesNotThrow(() => new vm.Script(source, { filename: "notice-chart.html" }));
  });

  it("pulls in nothing external, and the chart image has no static source", () => {
    const external = findAll(document, (node) => !!(node.attribs && (node.attribs.src || node.attribs.href)));
    assert.deepEqual(external.map((node) => node.name), [], "no src/href attributes");
    const forbidden = findAll(document, (node) => node.name === "link" || node.name === "iframe");
    assert.deepEqual(forbidden.map((node) => node.name), []);
    const images = findAll(document, (node) => node.name === "img");
    assert.deepEqual(images.map((node) => node.attribs.id), ["chart"], "one image, filled at runtime");
  });

  it("lets the verified PNG reach the image loader and nothing else", () => {
    const csp = findAll(
      document,
      (node) => node.name === "meta"
        && node.attribs
        && node.attribs["http-equiv"] === "Content-Security-Policy"
    )[0];
    assert.ok(csp, "the page carries a CSP");
    assert.match(csp.attribs.content, /default-src 'none'/);
    assert.match(csp.attribs.content, /img-src data:/, "the base64 PNG is a data: URI");
  });

  it("never assigns notice-derived text through the HTML parser", () => {
    const source = textOf(findAll(document, (node) => node.name === "script")[0]);
    assert.doesNotMatch(source, /innerHTML/);
    assert.doesNotMatch(source, /outerHTML/);
    assert.doesNotMatch(source, /insertAdjacentHTML/);
    assert.doesNotMatch(source, /document\.write/);
  });

  it("routes close through the preload bridge and reports the measured height", () => {
    const source = textOf(findAll(document, (node) => node.name === "script")[0]);
    assert.match(source, /window\.noticeChartAPI\.close\(/);
    assert.match(source, /window\.noticeChartAPI\.reportHeight\(/);
    assert.match(source, /requestAnimationFrame/);
    assert.match(source, /"data:image\/png;base64,"/);
  });
});
