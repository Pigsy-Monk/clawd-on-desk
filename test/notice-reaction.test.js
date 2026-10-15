"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  NOTICE_REACTION_LEVELS,
  normalizeNoticeReactionLevel,
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
    assert.deepStrictEqual(calls, [["play-notice-reaction", "warn"]]);
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

describe("notice reaction theme bindings", () => {
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
