"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createMiniNoticePopout, SETTLE_MS, EXIT_TIMEOUT_MS, CARD_WAIT_MAX_MS } = require("../src/mini-notice-popout");

// A docked pet whose jump out takes a few ticks, and a sign that stays up
// until the test takes it down.
function harness(overrides = {}) {
  const s = {
    mini: true,
    transitioning: false,
    edge: "right",
    bounds: { x: 2422, y: 78, width: 230, height: 230 },
    signUp: false,
    cardOpen: false,
    t: 0,
  };
  const log = [];
  let ticker = null;
  const popout = createMiniNoticePopout({
    isMini: () => s.mini,
    isMiniTransitioning: () => s.transitioning,
    getEdge: () => s.edge,
    getPetBounds: () => ({ ...s.bounds }),
    getWorkArea: () => ({ x: 0, y: 0, width: 2560, height: 1392 }),
    exitMini: () => { log.push("exit"); s.transitioning = true; },
    enterMini: (wa, edge) => log.push(["enter", edge, wa.width]),
    playSign: (payload) => { log.push(["sign", payload.id]); s.signUp = true; return true; },
    isSignUp: () => s.signUp,
    isCardOpen: () => s.cardOpen,
    revealCards: () => log.push("reveal"),
    now: () => s.t,
    setInterval: (cb) => { ticker = { cb, cleared: false }; return ticker; },
    clearInterval: (t) => { if (t) t.cleared = true; },
    ...overrides,
  });
  const tick = (ms = 150) => { s.t += ms; if (ticker && !ticker.cleared) ticker.cb(); };
  // The jump lands: mini mode is over, the pet stands a little in from the edge.
  const land = () => { s.mini = false; s.transitioning = false; s.bounds = { ...s.bounds, x: 2230 }; };
  return { popout, s, log, tick, land, get ticker() { return ticker; } };
}

describe("a notice while docked", () => {
  it("jumps out, shows the sign once on its feet, and docks back at the same edge", () => {
    const h = harness();
    assert.strictEqual(h.popout.start({ id: "n1", level: "info", title: "构建完成" }, { id: "n1" }), true);
    assert.deepStrictEqual(h.log, ["exit"]);
    assert.strictEqual(h.popout.getPendingId(), "n1", "the card waits behind the jump");

    h.tick();
    assert.deepStrictEqual(h.log, ["exit"], "still in the air");
    h.land();
    h.tick();
    h.tick(SETTLE_MS - 50);
    assert.deepStrictEqual(h.log, ["exit"], "a moment on its feet first");
    h.tick(100);
    assert.deepStrictEqual(h.log, ["exit", ["sign", "n1"]]);
    assert.strictEqual(h.popout.getPendingId(), null, "the sign holds the card now");

    h.tick();
    assert.strictEqual(h.log.length, 2, "stays out while the sign is up");
    h.s.signUp = false;
    h.tick();
    assert.deepStrictEqual(h.log.at(-1), ["enter", "right", 2560]);
    assert.strictEqual(h.popout.isActive(), false);
    assert.ok(h.ticker.cleared);
  });

  it("waits for an open card before docking back, but not forever", () => {
    const h = harness();
    h.popout.start({ id: "n1" });
    h.land();
    h.tick(); h.tick(SETTLE_MS + 10);
    h.s.signUp = false;
    h.s.cardOpen = true; // the user clicked the sign
    h.tick();
    h.tick(CARD_WAIT_MAX_MS - 1000);
    assert.ok(!h.log.some((e) => Array.isArray(e) && e[0] === "enter"), "the card is being read");
    h.s.cardOpen = false;
    h.tick();
    assert.deepStrictEqual(h.log.at(-1), ["enter", "right", 2560]);

    const stuck = harness();
    stuck.popout.start({ id: "n2" });
    stuck.land();
    stuck.tick(); stuck.tick(SETTLE_MS + 10);
    stuck.s.signUp = false;
    stuck.s.cardOpen = true;
    stuck.tick();
    stuck.tick(CARD_WAIT_MAX_MS + 10);
    assert.deepStrictEqual(stuck.log.at(-1), ["enter", "right", 2560], "a card left open does not keep it out");
  });

  it("leaves the pet where the user put it", () => {
    const moved = harness();
    moved.popout.start({ id: "n1" });
    moved.land();
    moved.tick(); moved.tick(SETTLE_MS + 10);
    moved.s.bounds = { ...moved.s.bounds, x: 1200 }; // dragged away mid-sign
    moved.s.signUp = false;
    moved.tick();
    assert.ok(!moved.log.some((e) => Array.isArray(e) && e[0] === "enter"));
    assert.strictEqual(moved.popout.isActive(), false);

    const redocked = harness();
    redocked.popout.start({ id: "n1" });
    redocked.land();
    redocked.tick(); redocked.tick(SETTLE_MS + 10);
    redocked.s.mini = true; // docked it again themselves
    redocked.tick();
    assert.strictEqual(redocked.popout.isActive(), false);
    assert.ok(!redocked.log.some((e) => Array.isArray(e) && e[0] === "enter"));
  });

  it("lets the newest notice take the sign while still jumping out", () => {
    const h = harness();
    h.popout.start({ id: "n1" });
    assert.strictEqual(h.popout.start({ id: "n2" }), true);
    assert.deepStrictEqual(h.log, ["exit"], "one jump");
    assert.strictEqual(h.popout.getPendingId(), "n2");
    h.land();
    h.tick(); h.tick(SETTLE_MS + 10);
    assert.deepStrictEqual(h.log, ["exit", ["sign", "n2"]]);
  });

  it("shows the card when the sign cannot go up or the jump never lands", () => {
    const declined = harness({ playSign: () => false });
    declined.popout.start({ id: "n1" });
    declined.land();
    declined.tick(); declined.tick(SETTLE_MS + 10);
    assert.ok(declined.log.includes("reveal"));

    const stuck = harness();
    stuck.popout.start({ id: "n1" });
    stuck.tick(EXIT_TIMEOUT_MS + 10);
    assert.deepStrictEqual(stuck.log, ["exit", "reveal"]);
    assert.strictEqual(stuck.popout.isActive(), false);
  });

  it("does nothing unless the pet is docked and settled", () => {
    for (const change of [{ mini: false }, { transitioning: true }, { edge: null }]) {
      const h = harness();
      Object.assign(h.s, change);
      assert.strictEqual(h.popout.start({ id: "n1" }), false, JSON.stringify(change));
      assert.deepStrictEqual(h.log, []);
    }
    assert.strictEqual(harness().popout.start(null), false);
  });
});
