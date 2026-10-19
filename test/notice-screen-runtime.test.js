"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createNoticeScreenRuntime, registerNoticeScreenIpc } = require("../src/notice-screen-runtime");
const { noticeCopyText } = require("../src/notice-text");
const noticeBubble = require("../src/notice-bubble");

const FILE = "clawd-notice-screen.svg";

function createHarness(overrides = {}) {
  const renderWc = { id: "render", isDestroyed: () => false };
  const hitWc = { id: "hit", isDestroyed: () => false };
  const state = {
    committedFile: "clawd-idle-follow.svg",
    hitBounds: { x: 100, y: 200, width: 150, height: 150 },
    cursor: { x: 0, y: 0 },
    now: 1000,
  };
  const toRenderer = [];
  const toHit = [];
  const clipboard = [];
  const pointerCalls = [];
  const signals = [];
  const runtime = createNoticeScreenRuntime({
    getRenderWebContents: () => renderWc,
    getHitWebContents: () => hitWc,
    getHitWindowBounds: () => state.hitBounds,
    getPetWindowBounds: () => ({ x: 0, y: 0, width: 230, height: 230 }),
    getCursorScreenPoint: () => state.cursor,
    // A fake 10 px-per-unit mapping keeps the expected numbers readable.
    getAssetPointerPayload: (bounds, point) => {
      pointerCalls.push(point);
      return { x: point.x / 10, y: point.y / 10, inside: true };
    },
    getCommittedFile: () => state.committedFile,
    sendToRenderer: (channel, payload) => { toRenderer.push([channel, payload]); return true; },
    sendToHitWin: (channel, payload) => toHit.push([channel, payload]),
    writeClipboard: (text) => clipboard.push(text),
    onSignClick: (id) => signals.push(["click", id]),
    onPoseInterrupted: () => signals.push(["interrupted"]),
    now: () => state.now,
    ...overrides,
  });
  const fromRender = { sender: renderWc };
  const fromHit = { sender: hitWc };
  return { runtime, state, toRenderer, toHit, clipboard, pointerCalls, signals, fromRender, fromHit };
}

const NOTICE = Object.freeze({
  id: "notice-3",
  level: "warn",
  title: "Disk almost full",
  body: "/ is at 92%",
  series: Object.freeze([]),
});
const PAYLOAD = Object.freeze({ level: "warn", id: "notice-3", title: "Disk almost full" });
// Hit window at (100,200); a client point (x,y) is screen (100+x, 200+y),
// i.e. viewBox ((100+x)/10, (200+y)/10) in this harness.
const SCREEN_RECT_FOR_HARNESS = { x: 10, y: 20, w: 5, h: 5 };

function startPose(h) {
  h.runtime.begin(PAYLOAD, NOTICE, FILE);
  h.state.committedFile = FILE;
  h.runtime.handleVisualCommitted({ file: FILE });
  h.runtime.handleRendererStatus(h.fromRender, { active: true, id: "notice-3", rect: SCREEN_RECT_FOR_HARNESS });
}

describe("notice screen runtime: hit-window gate", () => {
  it("opens only once the renderer reports the pose and it is the committed visual", () => {
    const h = createHarness();
    h.runtime.begin(PAYLOAD, NOTICE, FILE);
    assert.strictEqual(h.runtime.isActive(), false);
    assert.deepStrictEqual(h.toHit, []);

    h.runtime.handleRendererStatus(h.fromRender, { active: true, id: "notice-3", rect: SCREEN_RECT_FOR_HARNESS });
    assert.strictEqual(h.runtime.isActive(), false, "not committed yet");

    h.state.committedFile = FILE;
    h.runtime.handleVisualCommitted({ file: FILE });
    assert.strictEqual(h.runtime.isActive(), true);
    assert.deepStrictEqual(h.toHit, [["hit-state-sync", { noticeScreenActive: true }]]);

    // Further reports (zoom changes) do not re-send the same bit.
    h.runtime.handleRendererStatus(h.fromRender, { active: true, id: "notice-3", rect: { x: 0, y: 0, w: 9, h: 9 } });
    assert.strictEqual(h.toHit.length, 1);

    h.runtime.handleRendererStatus(h.fromRender, { active: false, id: "notice-3" });
    assert.strictEqual(h.runtime.isActive(), false);
    assert.deepStrictEqual(h.toHit.at(-1), ["hit-state-sync", { noticeScreenActive: false }]);
  });

  it("ignores a late 'over' for the previous notice once a newer one began", () => {
    const h = createHarness();
    startPose(h);
    h.runtime.begin({ ...PAYLOAD, id: "notice-4" }, { ...NOTICE, id: "notice-4" }, FILE);
    h.runtime.handleRendererStatus(h.fromRender, { active: false, id: "notice-3" });
    assert.strictEqual(h.runtime.getPendingFile(), FILE, "the newer pose is still pending");
    h.runtime.handleRendererStatus(h.fromRender, { active: true, id: "notice-4", rect: SCREEN_RECT_FOR_HARNESS });
    assert.strictEqual(h.runtime.isActive(), true);
  });

  it("closes when a different visual commits after the pose was shown", () => {
    const h = createHarness();
    startPose(h);
    h.state.committedFile = "clawd-working-typing.svg";
    h.runtime.handleVisualCommitted({ file: "clawd-working-typing.svg" });
    assert.strictEqual(h.runtime.isActive(), false);
    assert.strictEqual(h.runtime.getPendingFile(), null);
  });

  it("rejects status from anything but the render window, and malformed rects", () => {
    const h = createHarness();
    h.runtime.begin(PAYLOAD, NOTICE, FILE);
    assert.strictEqual(h.runtime.handleRendererStatus(h.fromHit, { active: true, id: "notice-3", rect: SCREEN_RECT_FOR_HARNESS }), false);
    assert.strictEqual(h.runtime.handleRendererStatus(h.fromRender, { active: true, id: "notice-3", rect: { x: 0, y: 0, w: -1, h: 2 } }), false);
    assert.strictEqual(h.runtime.handleRendererStatus(h.fromRender, { active: true, id: "other", rect: SCREEN_RECT_FOR_HARNESS }), false);
  });

  it("re-announces the gate to a reloaded hit window", () => {
    const h = createHarness();
    startPose(h);
    h.toHit.length = 0;
    h.runtime.syncHitWindow();
    assert.deepStrictEqual(h.toHit, [["hit-state-sync", { noticeScreenActive: true }]]);
  });
});

describe("notice screen runtime: pointer forwarding", () => {
  it("converts hit-window client points to viewBox units and forwards them", () => {
    const h = createHarness();
    startPose(h);
    assert.strictEqual(h.runtime.handleHitPointer(h.fromHit, { type: "move", clientX: 20, clientY: 30 }), true);
    assert.deepStrictEqual(h.pointerCalls.at(-1), { x: 120, y: 230 });
    assert.deepStrictEqual(h.toRenderer.at(-1), ["notice-screen-pointer", { type: "move", x: 12, y: 23 }]);

    h.runtime.handleHitPointer(h.fromHit, { type: "wheel", clientX: 0, clientY: 0, deltaY: -120, deltaMode: 0 });
    assert.deepStrictEqual(h.toRenderer.at(-1), ["notice-screen-pointer", { type: "wheel", x: 10, y: 20, deltaY: -120, deltaMode: 0 }]);

    h.runtime.handleHitPointer(h.fromHit, { type: "leave" });
    assert.deepStrictEqual(h.toRenderer.at(-1), ["notice-screen-pointer", { type: "leave" }]);
  });

  it("falls back to the global cursor when the client point is missing", () => {
    const h = createHarness();
    startPose(h);
    h.state.cursor = { x: 50, y: 60 };
    h.runtime.handleHitPointer(h.fromHit, { type: "move" });
    assert.deepStrictEqual(h.toRenderer.at(-1), ["notice-screen-pointer", { type: "move", x: 5, y: 6 }]);
  });

  it("forwards nothing while the pose is not live or from the wrong sender", () => {
    const h = createHarness();
    assert.strictEqual(h.runtime.handleHitPointer(h.fromHit, { type: "move", clientX: 1, clientY: 1 }), false);
    startPose(h);
    assert.strictEqual(h.runtime.handleHitPointer(h.fromRender, { type: "move", clientX: 1, clientY: 1 }), false);
    assert.strictEqual(h.runtime.handleHitPointer(h.fromHit, { type: "click", clientX: 1, clientY: 1 }), false);
    assert.deepStrictEqual(h.toRenderer, []);
  });
});

describe("notice screen runtime: right-click copy", () => {
  it("copies the notice text when the right-click lands on the reported screen rect", () => {
    const h = createHarness();
    startPose(h);
    // Client (20, 30) → viewBox (12, 23): inside {10,20,5,5}.
    assert.strictEqual(h.runtime.handleContextMenu(h.fromHit, { clientX: 20, clientY: 30 }), true);
    assert.deepStrictEqual(h.clipboard, ["Disk almost full\n/ is at 92%"]);
    assert.deepStrictEqual(h.toRenderer.at(-1), ["notice-screen-copied", { id: "notice-3" }]);
  });

  it("uses exactly the notice stack's copy text", () => {
    const trend = {
      title: "Latency",
      body: "p95 over budget",
      series: [{ name: "api", value: 412, unit: "ms", points: [] }, { name: "db", points: [3, 4] }],
    };
    assert.strictEqual(noticeBubble.__test.noticeCopyText, noticeCopyText);
    assert.strictEqual(noticeCopyText(trend), "Latency\np95 over budget\napi 412ms\ndb 4");
  });

  it("leaves a right-click elsewhere to the normal context menu", () => {
    const h = createHarness();
    startPose(h);
    assert.strictEqual(h.runtime.handleContextMenu(h.fromHit, { clientX: 80, clientY: 30 }), false);
    assert.deepStrictEqual(h.clipboard, []);
  });

  it("never consumes a right-click while no pose is live, or for an empty notice", () => {
    const idle = createHarness();
    assert.strictEqual(idle.runtime.handleContextMenu(idle.fromHit, { clientX: 20, clientY: 30 }), false);

    const empty = createHarness();
    empty.runtime.begin(PAYLOAD, { id: "notice-3", level: "warn" }, FILE);
    empty.state.committedFile = FILE;
    empty.runtime.handleRendererStatus(empty.fromRender, { active: true, id: "notice-3", rect: SCREEN_RECT_FOR_HARNESS });
    assert.strictEqual(empty.runtime.handleContextMenu(empty.fromHit, { clientX: 20, clientY: 30 }), false);
  });

  it("copies from the snapshot taken at begin, not from a renderer-supplied string", () => {
    const h = createHarness();
    startPose(h);
    h.runtime.handleRendererStatus(h.fromRender, {
      active: true, id: "notice-3", rect: SCREEN_RECT_FOR_HARNESS, text: "injected",
    });
    h.runtime.handleContextMenu(h.fromHit, { clientX: 20, clientY: 30 });
    assert.deepStrictEqual(h.clipboard, ["Disk almost full\n/ is at 92%"]);
  });

  it("does not report a copy when the clipboard write throws", () => {
    const h = createHarness({ writeClipboard: () => { throw new Error("busy"); } });
    startPose(h);
    assert.strictEqual(h.runtime.handleContextMenu(h.fromHit, { clientX: 20, clientY: 30 }), false);
    assert.ok(!h.toRenderer.some(([channel]) => channel === "notice-screen-copied"));
  });
});

describe("notice sign runtime: the held card", () => {
  it("asks for the card when a left-click lands on the board", () => {
    const h = createHarness();
    startPose(h);
    // Client (20, 30) → viewBox (12, 23): inside {10,20,5,5}.
    assert.strictEqual(h.runtime.handleHitClick(h.fromHit, { clientX: 20, clientY: 30 }), true);
    assert.deepStrictEqual(h.signals, [["click", "notice-3"]]);
  });

  it("leaves a click beside the board, or with no sign up, to the pet", () => {
    const h = createHarness();
    assert.strictEqual(h.runtime.handleHitClick(h.fromHit, { clientX: 20, clientY: 30 }), false);
    startPose(h);
    assert.strictEqual(h.runtime.handleHitClick(h.fromHit, { clientX: 80, clientY: 30 }), false);
    assert.strictEqual(h.runtime.handleHitClick(h.fromRender, { clientX: 20, clientY: 30 }), false);
    assert.deepStrictEqual(h.signals, []);
  });

  it("keeps the card held when the sign was shown in full or handed to a newer notice", () => {
    for (const reason of ["dwell", "replaced"]) {
      const h = createHarness();
      startPose(h);
      h.runtime.handleRendererStatus(h.fromRender, { active: false, id: "notice-3", reason });
      assert.deepStrictEqual(h.signals, [], reason);
    }
  });

  it("gives the card back when the sign is cut short", () => {
    const h = createHarness();
    startPose(h);
    h.runtime.handleRendererStatus(h.fromRender, { active: false, id: "notice-3", reason: "cancel" });
    assert.deepStrictEqual(h.signals, [["interrupted"]]);

    // An ending without a reason counts as cut short.
    const bare = createHarness();
    startPose(bare);
    bare.runtime.handleRendererStatus(bare.fromRender, { active: false, id: "notice-3" });
    assert.deepStrictEqual(bare.signals, [["interrupted"]]);
  });

  it("does not hand back a newer notice's card for a late 'over' of the old one", () => {
    const h = createHarness();
    startPose(h);
    h.runtime.begin({ ...PAYLOAD, id: "notice-4" }, { ...NOTICE, id: "notice-4" }, FILE);
    h.runtime.handleRendererStatus(h.fromRender, { active: false, id: "notice-3", reason: "cancel" });
    assert.deepStrictEqual(h.signals, []);
    assert.strictEqual(h.runtime.getPendingId(), "notice-4");
  });

  it("gives the card back when another visual replaces the sign", () => {
    const h = createHarness();
    startPose(h);
    h.state.committedFile = "clawd-notification.svg";
    h.runtime.handleVisualCommitted({ file: "clawd-notification.svg" });
    assert.deepStrictEqual(h.signals, [["interrupted"]]);
  });

  it("reports how long the live sign has been up", () => {
    const h = createHarness();
    assert.strictEqual(h.runtime.liveForMs(), 0);
    startPose(h);
    h.state.now += 2500;
    assert.strictEqual(h.runtime.liveForMs(), 2500);
    h.runtime.handleRendererStatus(h.fromRender, { active: false, id: "notice-3", reason: "dwell" });
    assert.strictEqual(h.runtime.liveForMs(), 0);
  });
});

describe("notice screen IPC registration", () => {
  it("registers its channels and the click handler, and removes them on dispose", () => {
    const listeners = new Map();
    const handlers = new Map();
    const ipcMain = {
      on: (channel, fn) => listeners.set(channel, fn),
      removeListener: (channel, fn) => { if (listeners.get(channel) === fn) listeners.delete(channel); },
      handle: (channel, fn) => handlers.set(channel, fn),
      removeHandler: (channel) => handlers.delete(channel),
    };
    const calls = [];
    const registration = registerNoticeScreenIpc({
      ipcMain,
      noticeScreen: {
        handleRendererStatus: (...args) => calls.push(["status", ...args]),
        handleHitPointer: (...args) => calls.push(["pointer", ...args]),
        handleHitClick: (...args) => { calls.push(["click", ...args]); return "yes"; },
      },
    });
    assert.deepStrictEqual([...listeners.keys()].sort(), ["notice-screen-hit-pointer", "notice-screen-status"]);
    assert.deepStrictEqual([...handlers.keys()], ["notice-screen-hit-click"]);
    listeners.get("notice-screen-status")("evt", { active: false });
    listeners.get("notice-screen-hit-pointer")("evt", { type: "leave" });
    // The invoke result is a strict boolean.
    assert.strictEqual(handlers.get("notice-screen-hit-click")("evt", { clientX: 1, clientY: 2 }), false);
    assert.deepStrictEqual(calls, [
      ["status", "evt", { active: false }],
      ["pointer", "evt", { type: "leave" }],
      ["click", "evt", { clientX: 1, clientY: 2 }],
    ]);
    registration.dispose();
    assert.strictEqual(listeners.size, 0);
    assert.strictEqual(handlers.size, 0);
    assert.throws(() => registerNoticeScreenIpc({ ipcMain }), /noticeScreen/);
  });
});

describe("notice sign runtime: hooks for the stretch invite", () => {
  it("reports every ending with its id and reason, before handing the card back", () => {
    const ended = [];
    for (const reason of ["dwell", "replaced", "cancel"]) {
      const h = createHarness({ onPoseEnded: (id, why) => ended.push([id, why]) });
      startPose(h);
      h.runtime.handleRendererStatus(h.fromRender, { active: false, id: "notice-3", reason });
    }
    const v = createHarness({ onPoseEnded: (id, why) => ended.push([id, why]) });
    startPose(v);
    v.state.committedFile = "clawd-notification.svg";
    v.runtime.handleVisualCommitted({ file: "clawd-notification.svg" });
    assert.deepStrictEqual(ended, [
      ["notice-3", "dwell"], ["notice-3", "replaced"], ["notice-3", "cancel"], ["notice-3", "visual"],
    ]);
  });

  it("passes the sign's id to the interrupted hook", () => {
    const seen = [];
    const h = createHarness({ onPoseInterrupted: (id) => seen.push(id) });
    startPose(h);
    h.runtime.handleRendererStatus(h.fromRender, { active: false, id: "notice-3", reason: "cancel" });
    assert.deepStrictEqual(seen, ["notice-3"]);
  });

  it("lets a board right-click be claimed instead of copied", () => {
    const asked = [];
    const h = createHarness({ onBoardContextMenu: (id) => { asked.push(id); return true; } });
    startPose(h);
    assert.strictEqual(h.runtime.handleContextMenu(h.fromHit, { clientX: 20, clientY: 30 }), true);
    assert.deepStrictEqual(asked, ["notice-3"]);
    assert.deepStrictEqual(h.clipboard, [], "nothing copied");

    // Unclaimed (or a throwing hook): the copy goes ahead as before.
    const plain = createHarness({ onBoardContextMenu: () => { throw new Error("x"); } });
    startPose(plain);
    assert.strictEqual(plain.runtime.handleContextMenu(plain.fromHit, { clientX: 20, clientY: 30 }), true);
    assert.deepStrictEqual(plain.clipboard, [noticeCopyText(NOTICE)]);
  });

  it("works with a sign that has no notice behind it", () => {
    const h = createHarness({ onBoardContextMenu: () => true });
    h.runtime.begin({ level: "info", id: "stretch-invite-1", title: "Time to stretch?" }, null, FILE);
    h.state.committedFile = FILE;
    h.runtime.handleRendererStatus(h.fromRender, { active: true, id: "stretch-invite-1", rect: SCREEN_RECT_FOR_HARNESS });
    assert.strictEqual(h.runtime.handleHitClick(h.fromHit, { clientX: 20, clientY: 30 }), true);
    assert.deepStrictEqual(h.signals, [["click", "stretch-invite-1"]]);
    assert.strictEqual(h.runtime.handleContextMenu(h.fromHit, { clientX: 20, clientY: 30 }), true);
  });
});
