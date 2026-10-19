"use strict";

// tick.js ships the *unclipped* cursor to the renderer alongside the eye offset
// whenever the theme declares an aim layer (trackingLayers mode "rotate" /
// "foreshorten"). The clamped eye offset cannot express a direction — it
// saturates at ±maxOffset — so the angle math needs its own sample.

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
themeLoader.init(path.join(__dirname, "..", "src"));
const _defaultTheme = themeLoader.loadTheme("clawd");

function cloneTheme(theme) {
  return JSON.parse(JSON.stringify(theme));
}

function loadTickWithScreen(getCursorScreenPoint) {
  const electronPath = require.resolve("electron");
  const tickPath = require.resolve("../src/tick");
  const previousElectron = Object.prototype.hasOwnProperty.call(require.cache, electronPath)
    ? require.cache[electronPath]
    : null;
  const previousTick = Object.prototype.hasOwnProperty.call(require.cache, tickPath)
    ? require.cache[tickPath]
    : null;

  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: { screen: { getCursorScreenPoint } },
  };
  delete require.cache[tickPath];

  return {
    initTick: require("../src/tick"),
    restore() {
      if (previousElectron) require.cache[electronPath] = previousElectron;
      else delete require.cache[electronPath];
      if (previousTick) require.cache[tickPath] = previousTick;
      else delete require.cache[tickPath];
    },
  };
}

const OBJ_RECT = { x: 20, y: 20, w: 60, h: 60 };

function makeCtx(theme, eyeMoves) {
  return {
    theme,
    win: {
      setIgnoreMouseEvents() {},
      isDestroyed() { return false; },
      isVisible() { return true; },
      getBounds() { return { x: 0, y: 0, width: 120, height: 120 }; },
    },
    currentState: "idle",
    currentSvg: theme.states.idle[0],
    idlePaused: false,
    miniMode: false,
    miniTransitioning: false,
    dragLocked: false,
    menuOpen: false,
    isAnimating: false,
    mouseOverPet: false,
    miniPeeked: false,
    forceEyeResend: false,
    forceEyeResendBoostUntil: 0,
    startupRecoveryActive: false,
    sendToRenderer(channel, ...args) {
      if (channel === "eye-move") eyeMoves.push(args);
    },
    sendToHitWin() {},
    getHitRectScreen() { return { left: 0, top: 0, right: 120, bottom: 120 }; },
    getObjRect() { return { ...OBJ_RECT }; },
    setState() {},
    applyState() {},
    miniPeekIn() {},
    miniPeekOut() {},
  };
}

function aimTheme() {
  const theme = cloneTheme(_defaultTheme);
  theme.eyeTracking.trackingLayers = {
    eyes: { ids: ["eyes-js"], maxOffset: 3, ease: 0.2 },
    turret: {
      ids: ["aim-turret"],
      mode: "rotate",
      pivot: [113, 66],
      aimOrigin: [124, 39],
      restAngle: -14,
      minAngle: -15,
      maxAngle: 8,
      ease: 0.2,
      rampPx: 160,
    },
  };
  return theme;
}

describe("tick aim sample", () => {
  let loader;
  let tickApi;
  let cursor;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    cursor = { x: 95, y: 70 };
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    tickApi = null;
    if (loader) loader.restore();
    mock.timers.reset();
  });

  function start(theme) {
    const eyeMoves = [];
    loader = loadTickWithScreen(() => ({ ...cursor }));
    tickApi = loader.initTick(makeCtx(theme, eyeMoves));
    tickApi.startMainTick();
    mock.timers.tick(1);
    return eyeMoves;
  }

  // The main tick reschedules itself, so a change of cursor has to be followed
  // by real time advancing for the next poll to observe it.
  function move(next) {
    cursor = next;
    for (let elapsed = 0; elapsed < 150; elapsed += 50) mock.timers.tick(50);
  }

  it("keeps the two-argument eye-move for themes without aim layers", () => {
    const eyeMoves = start(cloneTheme(_defaultTheme));
    move({ x: 100, y: 90 });
    assert.ok(eyeMoves.length >= 1, `expected at least one eye-move, got ${JSON.stringify(eyeMoves)}`);
    for (const args of eyeMoves) {
      assert.strictEqual(args.length, 2, `expected no aim sample, got ${JSON.stringify(args)}`);
    }
  });

  it("ships the raw cursor relative to the art rect for aim themes", () => {
    const eyeMoves = start(aimTheme());
    move({ x: 200, y: 90 });
    const last = eyeMoves[eyeMoves.length - 1];
    assert.strictEqual(last.length, 3);
    assert.deepStrictEqual(last[2], {
      x: 200 - OBJ_RECT.x,
      y: 90 - OBJ_RECT.y,
      w: OBJ_RECT.w,
      h: OBJ_RECT.h,
    });
  });

  it("keeps the sample unclipped where the eye offset saturates", () => {
    const eyeMoves = start(aimTheme());
    move({ x: 5000, y: 5000 });
    const first = eyeMoves[eyeMoves.length - 1];
    assert.deepStrictEqual(first[2], { x: 4980, y: 4980, w: 60, h: 60 });
    // ...while the eye offset is quantized and pinned at the theme's maxOffset
    // clamps, which is exactly why the angle cannot be derived from it.
    assert.strictEqual(first[0], 2);
    assert.strictEqual(first[1], 1.5);
  });

  it("still reports a move the eye offset dedup would have swallowed", () => {
    const eyeMoves = start(aimTheme());
    move({ x: 5000, y: 5000 });
    const afterFirst = eyeMoves.length;
    move({ x: 5001, y: 5001 });
    assert.strictEqual(eyeMoves.length, afterFirst + 1, "the aim sample changed, so the frame must ship");
    assert.deepStrictEqual(eyeMoves[eyeMoves.length - 1][2], { x: 4981, y: 4981, w: 60, h: 60 });
  });

  it("drops the sample when the mouse goes idle, so the aim returns to rest", () => {
    const eyeMoves = start(aimTheme());
    move({ x: 200, y: 90 });
    assert.strictEqual(eyeMoves[eyeMoves.length - 1].length, 3);

    // 60s without movement is the yawning threshold, which zeroes the eyes.
    mock.timers.tick(60000);
    const zeroing = eyeMoves.filter((args) => args[0] === 0 && args[1] === 0);
    assert.ok(zeroing.length >= 1, "expected an eye-move(0, 0)");
    assert.strictEqual(zeroing[zeroing.length - 1].length, 2, "the zeroing frame carries no sample");
  });
});
