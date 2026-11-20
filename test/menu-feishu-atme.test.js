"use strict";

// The Feishu "@me" item is a manual action living in existing menus. These
// tests pin the two things that could silently regress: it must appear exactly
// once in each menu, and it must not fire on construction.

const assert = require("node:assert");
const Module = require("node:module");
const { describe, it } = require("node:test");

const MENU_MODULE_PATH = require.resolve("../src/menu");

function loadMenuWithElectron(fakeElectron) {
  delete require.cache[MENU_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === "electron") return fakeElectron;
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/menu");
  } finally {
    Module._load = originalLoad;
  }
}

function fakeElectron() {
  return {
    app: { quit: () => {}, setActivationPolicy: () => {}, dock: { show: () => {}, hide: () => {} } },
    BrowserWindow: function BrowserWindow() {},
    Menu: { buildFromTemplate: (template) => ({ template }) },
    Tray: function Tray() {},
    nativeImage: {
      createFromPath() {
        return { resize() { return this; }, setTemplateImage() {} };
      },
    },
    screen: {
      getAllDisplays: () => [{
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      }],
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ id: 1 }),
    },
  };
}

function buildBaseCtx(overrides = {}) {
  return {
    win: { isDestroyed: () => false },
    sessions: new Map(),
    currentSize: "P:15",
    doNotDisturb: false,
    lang: "en",
    showTray: true,
    showDock: true,
    openAtLogin: false,
    bubbleFollowPet: false,
    hideBubbles: false,
    soundMuted: false,
    menuOpen: false,
    tray: null,
    contextMenuOwner: null,
    contextMenu: null,
    isQuitting: false,
    petHidden: false,
    getMiniMode: () => false,
    getMiniTransitioning: () => false,
    getDisableMiniMode: () => false,
    getActiveThemeCapabilities: () => ({ miniMode: true, petTint: true }),
    openDashboard: () => {},
    openSettingsWindow: () => {},
    togglePetVisibility: () => {},
    bringPetToPrimaryDisplay: () => {},
    enableDoNotDisturb: () => {},
    disableDoNotDisturb: () => {},
    enterMiniViaMenu: () => {},
    exitMiniMode: () => {},
    miniHandleResize: () => false,
    getPetWindowBounds: () => ({ x: 10, y: 20, width: 120, height: 120 }),
    applyPetWindowBounds: () => {},
    getCurrentPixelSize: () => ({ width: 200, height: 200 }),
    isProportionalMode: () => true,
    repositionBubbles: () => {},
    syncHitWin: () => {},
    flushRuntimeStateToPrefs: () => {},
    reapplyMacVisibility: () => {},
    getSettingsWindow: () => null,
    clampToScreenVisual: (x, y) => ({ x, y }),
    ...overrides,
  };
}

const LABEL = "Feishu @mentions";

function findItems(template, label) {
  return template.filter((item) => item && item.label === label);
}

describe("Feishu @me menu item", () => {
  it("appears once in the context menu and runs only when clicked", () => {
    const initMenu = loadMenuWithElectron(fakeElectron());
    const runs = [];
    const ctx = buildBaseCtx({ runFeishuAtme: (t) => runs.push(typeof t) });
    const menu = initMenu(ctx);

    menu.buildContextMenu();

    const items = findItems(ctx.contextMenu.template, LABEL);
    assert.strictEqual(items.length, 1, "exactly one item in the context menu");
    assert.deepStrictEqual(runs, [], "building the menu must not run the digest");

    items[0].click();
    assert.deepStrictEqual(runs, ["function"], "click invokes the runner with t");
  });

  it("appears once in the tray menu too", () => {
    const initMenu = loadMenuWithElectron(fakeElectron());
    const ctx = buildBaseCtx({ runFeishuAtme: () => {} });
    ctx.tray = { setContextMenu: (m) => { ctx.trayMenu = m; } };
    const menu = initMenu(ctx);

    menu.buildTrayMenu();

    assert.strictEqual(findItems(ctx.trayMenu.template, LABEL).length, 1);
  });

  it("is disabled while the pet is hidden", () => {
    const initMenu = loadMenuWithElectron(fakeElectron());
    const ctx = buildBaseCtx({ runFeishuAtme: () => {}, petHidden: true });
    const menu = initMenu(ctx);

    menu.buildContextMenu();

    const items = findItems(ctx.contextMenu.template, LABEL);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].enabled, false);
  });

  it("is absent when main.js has not wired a runner", () => {
    const initMenu = loadMenuWithElectron(fakeElectron());
    const ctx = buildBaseCtx();
    const menu = initMenu(ctx);

    menu.buildContextMenu();
    ctx.tray = { setContextMenu: (m) => { ctx.trayMenu = m; } };
    menu.buildTrayMenu();

    assert.strictEqual(findItems(ctx.contextMenu.template, LABEL).length, 0);
    assert.strictEqual(findItems(ctx.trayMenu.template, LABEL).length, 0);
  });

  it("leaves Hide Pet / separator / Quit ordering intact (#460)", () => {
    const initMenu = loadMenuWithElectron(fakeElectron());
    const ctx = buildBaseCtx({ runFeishuAtme: () => {}, setPetVisibility: () => {} });
    const menu = initMenu(ctx);

    menu.buildContextMenu();

    const labels = ctx.contextMenu.template.map((item) => item.label);
    const hideIdx = labels.indexOf("Hide Pet");
    const quitIdx = labels.indexOf("Quit");
    assert.strictEqual(quitIdx, labels.length - 1, "Quit stays last");
    assert.strictEqual(hideIdx, quitIdx - 2, "Hide Pet stays just above Quit");
    assert.strictEqual(ctx.contextMenu.template[hideIdx + 1].type, "separator");
  });
});
