"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  NOTICE_REACTION_LEVELS,
  normalizeNoticeReactionLevel,
  buildNoticeReactionPayload,
  canPlayNoticeReaction,
  createNoticeReactionHandler,
} = require("../src/notice-reaction");

// The level → animation choice the renderer makes. Kept in step with
// renderer.js's NOTICE_REACTION_ANIMATIONS: this test's job is to prove every
// built-in theme can actually satisfy it.
const LEVEL_ANIMATIONS = {
  info: "idle-look",
  success: "heart-eyes",
  warn: "notification",
  error: "react-annoyed",
};

const ROOT = path.join(__dirname, "..");
// clawd keeps its art in the shared assets dir; the other built-ins ship their
// own (see theme-context.getRendererAssetsPath).
const THEME_ASSET_DIRS = {
  clawd: path.join(ROOT, "assets", "svg"),
  calico: path.join(ROOT, "themes", "calico", "assets"),
  cloudling: path.join(ROOT, "themes", "cloudling", "assets"),
};

describe("notice reaction main-process gate", () => {
  it("exposes the four levels as a frozen set", () => {
    assert.ok(Object.isFrozen(NOTICE_REACTION_LEVELS));
    assert.deepStrictEqual([...NOTICE_REACTION_LEVELS], ["info", "success", "warn", "error"]);
  });

  it("normalizes each level and rejects anything else", () => {
    for (const level of ["info", "success", "warn", "error"]) {
      assert.strictEqual(normalizeNoticeReactionLevel(level), level);
    }
    assert.strictEqual(normalizeNoticeReactionLevel("ERROR"), null);
    assert.strictEqual(normalizeNoticeReactionLevel("debug"), null);
    assert.strictEqual(normalizeNoticeReactionLevel({ level: "info" }), null);
    assert.strictEqual(normalizeNoticeReactionLevel(null), null);
    assert.strictEqual(normalizeNoticeReactionLevel(undefined), null);
  });

  it("requires opt-in, a visible regular pet, and a non-headless source", () => {
    const base = {
      enabled: true,
      doNotDisturb: false,
      petHidden: false,
      miniMode: false,
      miniTransitioning: false,
      dragging: false,
      headless: false,
      hasPetWindow: true,
    };
    assert.strictEqual(canPlayNoticeReaction(base), true);
    for (const key of [
      "doNotDisturb",
      "petHidden",
      "miniMode",
      "miniTransitioning",
      "dragging",
      "headless",
    ]) {
      assert.strictEqual(canPlayNoticeReaction({ ...base, [key]: true }), false, key);
    }
    assert.strictEqual(canPlayNoticeReaction({ ...base, enabled: false }), false);
    assert.strictEqual(canPlayNoticeReaction({ ...base, hasPetWindow: false }), false);
  });

  it("fresh-reads every gate and sends one sanitized renderer event", () => {
    const state = {
      enabled: false,
      dnd: false,
      hidden: false,
      mini: false,
      transitioning: false,
      dragging: false,
      window: true,
    };
    const calls = [];
    const handle = createNoticeReactionHandler({
      getEnabled: () => state.enabled,
      getDoNotDisturb: () => state.dnd,
      isPetHidden: () => state.hidden,
      getMiniMode: () => state.mini,
      getMiniTransitioning: () => state.transitioning,
      isDragging: () => state.dragging,
      hasPetWindow: () => state.window,
      sendToRenderer: (...args) => calls.push(args),
    });

    assert.strictEqual(handle("warn"), false);
    state.enabled = true;
    assert.strictEqual(handle("warn"), true);
    assert.strictEqual(handle("error", { headless: true }), false);
    assert.strictEqual(handle("unexpected"), false);
    assert.deepStrictEqual(calls, [["play-notice-reaction", { level: "warn", id: null, title: "" }]]);
  });

  it("blocks each gate independently at the handler level", () => {
    const state = {
      enabled: true,
      dnd: false,
      hidden: false,
      mini: false,
      transitioning: false,
      dragging: false,
      window: true,
    };
    const calls = [];
    const handle = createNoticeReactionHandler({
      getEnabled: () => state.enabled,
      getDoNotDisturb: () => state.dnd,
      isPetHidden: () => state.hidden,
      getMiniMode: () => state.mini,
      getMiniTransitioning: () => state.transitioning,
      isDragging: () => state.dragging,
      hasPetWindow: () => state.window,
      sendToRenderer: (...args) => calls.push(args),
    });

    for (const [key, value] of [
      ["enabled", false],
      ["dnd", true],
      ["hidden", true],
      ["mini", true],
      ["transitioning", true],
      ["dragging", true],
      ["window", false],
    ]) {
      const saved = state[key];
      state[key] = value;
      assert.strictEqual(handle("info"), false, key);
      state[key] = saved;
    }
    assert.strictEqual(handle("info", { headless: true }), false);
    assert.deepStrictEqual(calls, []);
  });

  it("defaults every gate to closed when no options are supplied", () => {
    const calls = [];
    const handle = createNoticeReactionHandler({ sendToRenderer: (...args) => calls.push(args) });
    for (const level of NOTICE_REACTION_LEVELS) {
      assert.strictEqual(handle(level), false, level);
    }
    assert.deepStrictEqual(calls, []);
  });
});

describe("notice reaction payload", () => {
  it("carries level, id and headline from a store notice, nothing else", () => {
    const payload = buildNoticeReactionPayload({
      id: "notice-7",
      level: "error",
      title: "  Build failed\nsecond line ",
      body: "secret body",
      series: [{ name: "cpu", points: [1, 2] }],
      image: { mime: "image/png", data: "AAAA" },
    });
    assert.deepStrictEqual({ ...payload }, { level: "error", id: "notice-7", title: "Build failed" });
    assert.ok(Object.isFrozen(payload));
  });

  it("falls back to the first body line for a body-only notice", () => {
    const payload = buildNoticeReactionPayload({ id: "n1", level: "info", title: "", body: "\n  deploy done  \nmore" });
    assert.strictEqual(payload.title, "deploy done");
  });

  it("accepts a bare level and rejects anything without a valid level", () => {
    assert.deepStrictEqual({ ...buildNoticeReactionPayload("success") }, { level: "success", id: null, title: "" });
    assert.strictEqual(buildNoticeReactionPayload("debug"), null);
    assert.strictEqual(buildNoticeReactionPayload({ id: "n", level: "fatal", title: "x" }), null);
    assert.strictEqual(buildNoticeReactionPayload(null), null);
  });

  function openHandler(extra = {}) {
    const calls = [];
    const handle = createNoticeReactionHandler({
      getEnabled: () => true,
      hasPetWindow: () => true,
      sendToRenderer: (...args) => calls.push(args),
      ...extra,
    });
    return { calls, handle };
  }

  it("lets a head-screen theme take the notice, and only after the gate", () => {
    const screens = [];
    const notice = { id: "n9", level: "warn", title: "Disk almost full", body: "92%" };
    const { calls, handle } = openHandler({
      playNoticeScreen: (payload, original) => {
        screens.push([{ ...payload }, original]);
        return true;
      },
    });
    assert.strictEqual(handle(notice), true);
    assert.deepStrictEqual(screens, [[{ level: "warn", id: "n9", title: "Disk almost full" }, notice]]);
    assert.deepStrictEqual(calls, [], "the per-level reaction must not also play");

    const gated = openHandler({
      getEnabled: () => false,
      playNoticeScreen: () => { throw new Error("must not be reached"); },
    });
    assert.strictEqual(gated.handle(notice), false);
  });

  it("skipSign keeps the per-level reaction but never raises the head screen", () => {
    const screens = [];
    const { calls, handle } = openHandler({
      playNoticeScreen: (payload) => { screens.push(payload); return true; },
    });
    assert.strictEqual(handle({ id: "n3", level: "error", title: "down" }, { skipSign: true }), true);
    assert.deepStrictEqual(screens, [], "the sign is what holds the card back");
    assert.deepStrictEqual(calls, [["play-notice-reaction", { level: "error", id: "n3", title: "down" }]]);
  });

  it("skipSign does not jump the pet out of mini mode to show a sign", () => {
    const minis = [];
    const { calls, handle } = openHandler({
      getMiniMode: () => true,
      hasMiniSign: () => true,
      playMiniSign: (payload) => { minis.push(payload); return true; },
    });
    // In mini mode the ordinary reaction gate is closed, so nothing plays —
    // what matters is that the pet stays docked.
    assert.strictEqual(handle({ id: "n5", level: "info", title: "hi" }, { skipSign: true }), false);
    assert.deepStrictEqual(minis, []);
    assert.deepStrictEqual(calls, []);
  });

  it("a skipSign notice still obeys the gate", () => {
    const { calls, handle } = openHandler({ getDoNotDisturb: () => true });
    assert.strictEqual(handle({ id: "n4", level: "info", title: "hi" }, { skipSign: true }), false);
    assert.deepStrictEqual(calls, []);
  });

  it("answers the same gate up front through canPlay, without playing anything", () => {
    const open = openHandler({ playNoticeScreen: () => { throw new Error("must not be reached"); } });
    assert.strictEqual(open.handle.canPlay(), true);
    assert.deepStrictEqual(open.calls, []);
    for (const extra of [{ getEnabled: () => false }, { getDoNotDisturb: () => true }, { getMiniMode: () => true }]) {
      assert.strictEqual(openHandler(extra).handle.canPlay(), false, Object.keys(extra)[0]);
    }
  });

  it("falls back to the per-level reaction when the head screen declines or throws", () => {
    for (const playNoticeScreen of [() => false, () => { throw new Error("boom"); }, () => "yes"]) {
      const { calls, handle } = openHandler({ playNoticeScreen });
      assert.strictEqual(handle({ id: "n2", level: "success", title: "ok" }), true);
      assert.deepStrictEqual(calls, [["play-notice-reaction", { level: "success", id: "n2", title: "ok" }]]);
    }
  });

  it("docked at an edge, hands the notice to the theme's edge drawer and nothing else", () => {
    const drawers = [];
    const notice = { id: "m1", level: "info", title: "构建完成" };
    const { calls, handle } = openHandler({
      getMiniMode: () => true,
      hasMiniSign: () => true,
      playMiniSign: (payload, original) => { drawers.push([{ ...payload }, original]); return true; },
      playNoticeScreen: () => { throw new Error("the head sign has no room in mini mode"); },
    });
    assert.strictEqual(handle.canPlay(), false, "the head sign stays off in mini mode");
    assert.strictEqual(handle.canPlayMini(), true);
    assert.strictEqual(handle(notice), true);
    assert.deepStrictEqual(drawers, [[{ level: "info", id: "m1", title: "构建完成" }, notice]]);
    assert.deepStrictEqual(calls, [], "no per-level reaction on top");
  });

  it("keeps mini mode as it was for a theme without an edge drawer, or while gated", () => {
    const none = openHandler({
      getMiniMode: () => true,
      hasMiniSign: () => false,
      playMiniSign: () => { throw new Error("must not be reached"); },
    });
    assert.strictEqual(none.handle.canPlayMini(), false);
    assert.strictEqual(none.handle({ id: "m2", level: "warn", title: "x" }), false);
    assert.deepStrictEqual(none.calls, []);
    for (const extra of [
      { getDoNotDisturb: () => true },
      { getMiniTransitioning: () => true },
      { isDragging: () => true },
      { isPetHidden: () => true },
      { getEnabled: () => false },
      { getMiniMode: () => false },
    ]) {
      const gated = openHandler({ getMiniMode: () => true, hasMiniSign: () => true, playMiniSign: () => true, ...extra });
      assert.strictEqual(gated.handle.canPlayMini(), false, Object.keys(extra)[0]);
    }
    // A drawer that declines leaves the notice unreacted, so main shows the card.
    const declined = openHandler({ getMiniMode: () => true, hasMiniSign: () => true, playMiniSign: () => false });
    assert.strictEqual(declined.handle({ id: "m3", level: "info", title: "x" }), false);
    assert.deepStrictEqual(declined.calls, []);
  });
});

describe("notice reaction theme bindings", () => {
  it("binds the notice sign on clawd and calico; other themes keep the per-level reaction", () => {
    const clawd = JSON.parse(fs.readFileSync(path.join(ROOT, "themes", "clawd", "theme.json"), "utf8"));
    const file = clawd.reactions["notice-screen"] && clawd.reactions["notice-screen"].file;
    assert.strictEqual(file, "clawd-notice-screen.svg");
    assert.ok(fs.existsSync(path.join(THEME_ASSET_DIRS.clawd, file)));
    // The text line is written into the SVG document, so the file must be on
    // the document-backed channel; its hit box must cover the zoomed board in
    // either hand (test/notice-screen-layout.test.js checks the envelope).
    assert.ok(clawd.rendering.objectChannelFiles.includes(file));
    assert.deepStrictEqual(clawd.fileHitBoxes[file], { x: -9.75, y: -15.8, w: 34.5, h: 32.8 });
    // Calico brings its own board (a cat-eared bubble); its geometry is checked
    // in test/calico-notice-screen-asset.test.js and the layout tests.
    const calico = JSON.parse(fs.readFileSync(path.join(ROOT, "themes", "calico", "theme.json"), "utf8"));
    const calicoFile = calico.reactions["notice-screen"].file;
    assert.strictEqual(calicoFile, "calico-notice-screen.svg");
    assert.ok(fs.existsSync(path.join(THEME_ASSET_DIRS.calico, calicoFile)));
    assert.ok(calico.rendering.objectChannelFiles.includes(calicoFile));
    assert.ok(calico.fileHitBoxes[calicoFile]);
    const cloudling = JSON.parse(fs.readFileSync(path.join(ROOT, "themes", "cloudling", "theme.json"), "utf8"));
    assert.strictEqual(cloudling.reactions["notice-screen"], undefined);
  });

  it("covers every level with a real asset in every built-in theme", () => {
    for (const [themeId, assetDir] of Object.entries(THEME_ASSET_DIRS)) {
      const theme = JSON.parse(fs.readFileSync(path.join(ROOT, "themes", themeId, "theme.json"), "utf8"));
      assert.ok(theme.reactions, `${themeId} should declare reactions`);
      for (const level of NOTICE_REACTION_LEVELS) {
        const animation = LEVEL_ANIMATIONS[level];
        const entry = theme.reactions[animation];
        assert.ok(entry, `${themeId} should bind "${animation}" (level ${level})`);
        const file = Array.isArray(entry.files) ? entry.files[0] : entry.file;
        assert.strictEqual(typeof file, "string", `${themeId}.reactions.${animation} needs a file`);
        assert.ok(
          fs.existsSync(path.join(assetDir, file)),
          `${themeId} is missing the asset for ${level}: ${file}`
        );
      }
    }
  });

  it("maps each level to a distinct animation", () => {
    const animations = NOTICE_REACTION_LEVELS.map((level) => LEVEL_ANIMATIONS[level]);
    assert.strictEqual(new Set(animations).size, NOTICE_REACTION_LEVELS.length);
  });
});
