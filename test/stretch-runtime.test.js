"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  createStretchRuntime,
  SIGN_DWELL_MS,
  SIGN_BACKSTOP_MS,
  REPLACED_RETRY_MS,
  DONE_CLOSE_MS,
  EARLY_CLOSE_MS,
} = require("../src/stretch-runtime");
const { SNOOZE_MS, AWAY_IDLE_MS } = require("../src/stretch-scheduler");
const { planMs, resolveGroup } = require("../src/stretch-session");

const MIN = 60 * 1000;
const WED_10 = new Date(2026, 9, 14, 10, 0, 0).getTime();

// A fake clock with timers that fire when the clock is advanced past them.
function fakeTime(start = WED_10) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: t + Math.max(0, ms) }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, timer] of timers) if (timer.at <= end && (!next || timer.at < next[1].at)) next = [id, timer];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
    pending: () => timers.size,
  };
}

function harness(overrides = {}) {
  const time = fakeTime();
  const state = { idleMs: 0, blockers: [], canSign: true, delivered: true, config: { enabled: true, intervalMinutes: 60, startHour: 9, endHour: 19, workdaysOnly: true } };
  const log = { signs: [], lowered: [], cards: [], busy: [] };
  const runtime = createStretchRuntime({
    now: time.now,
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    getConfig: () => state.config,
    getLang: () => "zh",
    getSystemIdleMs: () => state.idleMs,
    getBlockers: () => state.blockers,
    canShowSign: () => state.canSign,
    raiseSign: (sign) => { log.signs.push(sign); return state.delivered; },
    lowerSign: (id) => log.lowered.push(id),
    showCard: (card) => log.cards.push(card),
    onBusyChange: (busy) => log.busy.push(busy),
    ...overrides,
  });
  const lastCard = () => log.cards[log.cards.length - 1];
  return { time, state, log, runtime, lastCard };
}

describe("stretch runtime: the invite", () => {
  it("raises the sign when the interval is up, with a 30 s dwell", () => {
    const h = harness();
    h.runtime.startTicking();
    h.time.advance(59 * MIN);
    assert.equal(h.log.signs.length, 0);
    h.time.advance(2 * MIN);
    assert.equal(h.log.signs.length, 1);
    const sign = h.log.signs[0];
    assert.match(sign.id, /^stretch-invite-/);
    assert.equal(sign.title, "该拉伸了？");
    assert.equal(sign.dwellMs, SIGN_DWELL_MS);
    assert.equal(h.runtime.getPhase(), "sign");
    assert.equal(h.runtime.ownsSignId(sign.id), true);
    assert.equal(h.runtime.ownsSignId("notice-3"), false);
    assert.deepEqual(h.log.cards, [], "no card until the board is clicked");
  });

  it("does not interrupt while blocked and invites once it clears", () => {
    const h = harness();
    h.state.blockers = ["dnd"];
    h.runtime.startTicking();
    h.time.advance(90 * MIN);
    assert.equal(h.log.signs.length, 0);
    h.state.blockers = [];
    h.time.advance(31 * 1000);
    assert.equal(h.log.signs.length, 1);
  });

  it("skips while the user is away and counts a fresh hour after", () => {
    const h = harness();
    h.runtime.startTicking();
    h.time.advance(50 * MIN);
    h.state.idleMs = AWAY_IDLE_MS + 1;
    h.time.advance(30 * MIN);
    assert.equal(h.log.signs.length, 0);
    h.state.idleMs = 0;
    h.time.advance(59 * MIN);
    assert.equal(h.log.signs.length, 0);
    h.time.advance(2 * MIN);
    assert.equal(h.log.signs.length, 1);
  });

  it("a left-click on the board opens the invite card and lowers the sign", () => {
    const h = harness();
    h.runtime.tryNow();
    const id = h.log.signs[0].id;
    assert.equal(h.runtime.handleSignClick("notice-1"), false);
    assert.equal(h.runtime.handleSignClick(id), true);
    assert.equal(h.runtime.getPhase(), "invite");
    assert.deepEqual(h.log.lowered, [id]);
    assert.equal(h.lastCard().phase, "invite");
    // The sign's own "over" report after the lowering changes nothing.
    assert.equal(h.runtime.handleSignEnded(id, "dwell"), false);
    assert.equal(h.runtime.getPhase(), "invite");
  });

  it("30 s without an answer counts as later: ten minutes, then again", () => {
    const h = harness();
    h.runtime.tryNow();
    const id = h.log.signs[0].id;
    h.time.advance(SIGN_DWELL_MS);
    assert.equal(h.runtime.handleSignEnded(id, "dwell"), true);
    assert.equal(h.runtime.getPhase(), "idle");
    assert.equal(h.runtime.getScheduler().getNextDueAt(), h.time.now() + SNOOZE_MS);
  });

  it("falls back to 'later' if the sign never reports back", () => {
    const h = harness();
    h.runtime.tryNow();
    h.time.advance(SIGN_BACKSTOP_MS + 10);
    assert.equal(h.runtime.getPhase(), "idle");
    assert.equal(h.log.lowered.length, 1);
  });

  it("a notice taking the sign over asks again in two minutes", () => {
    const h = harness();
    h.runtime.tryNow();
    h.runtime.handleSignEnded(h.runtime.getSignId(), "replaced");
    assert.equal(h.runtime.getPhase(), "idle");
    assert.equal(h.runtime.getScheduler().getNextDueAt(), h.time.now() + REPLACED_RETRY_MS);
    assert.deepEqual(h.log.cards, []);
  });

  it("a sign cut short (permission request, DND, drag) asks again later without a card", () => {
    for (const reason of ["cancel", "visual"]) {
      const h = harness();
      h.runtime.tryNow();
      h.runtime.handleSignEnded(h.runtime.getSignId(), reason);
      assert.equal(h.runtime.getPhase(), "idle", reason);
      assert.deepEqual(h.log.cards, [], reason);
      assert.equal(h.runtime.getScheduler().getNextDueAt(), h.time.now() + REPLACED_RETRY_MS, reason);
    }
  });

  it("goes straight to the card when the theme has no sign or it cannot be raised", () => {
    for (const [canSign, delivered] of [[false, true], [true, false]]) {
      const h = harness();
      h.state.canSign = canSign;
      h.state.delivered = delivered;
      h.runtime.tryNow();
      assert.equal(h.runtime.getPhase(), "invite");
      assert.equal(h.lastCard().phase, "invite");
    }
  });

  it("'later' and 'skip today' from the card", () => {
    const h = harness();
    h.runtime.tryNow();
    h.runtime.handleSignClick(h.runtime.getSignId());
    assert.equal(h.runtime.handleAction("later"), true);
    assert.equal(h.runtime.getPhase(), "idle");
    assert.equal(h.lastCard(), null, "card taken away");
    h.runtime.tryNow();
    assert.equal(h.runtime.handleAction("skipToday"), true);
    assert.equal(h.runtime.getScheduler().isSkippedToday(h.time.now()), true);
  });

  it("right-click menus offer the three choices on the sign and the controls in a break", () => {
    const h = harness();
    assert.deepEqual(h.runtime.menuActions(), []);
    h.runtime.tryNow();
    assert.deepEqual(h.runtime.menuActions({ onBoard: true }), ["start", "later", "skipToday"]);
    assert.deepEqual(h.runtime.menuActions(), [], "elsewhere on the pet: the normal menu");
    h.runtime.handleAction("start");
    assert.deepEqual(h.runtime.menuActions(), ["pause", "skip", "end"]);
    h.runtime.handleAction("pause");
    assert.deepEqual(h.runtime.menuActions(), ["resume", "skip", "end"]);
  });

  it("try now does nothing new while something is already up", () => {
    const h = harness();
    h.runtime.tryNow();
    assert.deepEqual(h.runtime.tryNow(), { status: "ok", alreadyActive: true, phase: "sign" });
    assert.equal(h.log.signs.length, 1);
  });
});

describe("stretch runtime: the break", () => {
  it("start lowers the sign, holds notices, and runs to done on its own", () => {
    const h = harness();
    h.runtime.tryNow();
    const id = h.runtime.getSignId();
    assert.equal(h.runtime.handleAction("start"), true);
    assert.deepEqual(h.log.lowered, [id]);
    assert.deepEqual(h.log.busy, [true]);
    assert.equal(h.lastCard().phase, "run");
    assert.equal(h.lastCard().title, "准备开始");
    const seqs = new Set();
    h.time.advance(planMs(resolveGroup("B")) + 100);
    for (const card of h.log.cards) if (card) seqs.add(card.seq);
    assert.equal(h.runtime.getPhase(), "finish");
    assert.equal(h.lastCard().phase, "done");
    assert.equal(h.lastCard().title, "做完啦！");
    assert.ok(seqs.size > 20, "a new payload per segment");
    h.time.advance(DONE_CLOSE_MS);
    assert.equal(h.runtime.getPhase(), "idle");
    assert.equal(h.lastCard(), null);
    assert.deepEqual(h.log.busy, [true, false], "notices flow again once the card is gone");
    // The next invite is an interval after the break.
    assert.ok(h.runtime.getScheduler().getNextDueAt() > h.time.now() + 50 * MIN);
  });

  it("pause, skip and end from the card", () => {
    const h = harness();
    h.runtime.tryNow();
    h.runtime.handleAction("start");
    h.time.advance(3000 + 900 + 2000);
    assert.equal(h.lastCard().board.type, "hold");
    assert.equal(h.runtime.handleAction("pause"), true);
    assert.equal(h.lastCard().buttons[0].action, "resume");
    const before = h.log.cards.length;
    h.time.advance(5 * MIN);
    assert.equal(h.log.cards.length, before, "nothing moves while paused");
    h.runtime.handleAction("resume");
    h.runtime.handleAction("skip");
    assert.match(h.lastCard().title, /^下一个：侧弯/);
    assert.deepEqual(h.lastCard().pills.skipped, [0]);
    h.runtime.handleAction("end");
    assert.equal(h.lastCard().phase, "early");
    assert.equal(h.lastCard().title, "先到这儿 · 做了 0 / 6 个");
    h.time.advance(EARLY_CLOSE_MS);
    assert.equal(h.runtime.getPhase(), "idle");
  });

  it("'ok' closes the finish card at once; actions that do not apply are refused", () => {
    const h = harness();
    assert.equal(h.runtime.handleAction("pause"), false);
    assert.equal(h.runtime.handleAction("ok"), false);
    assert.equal(h.runtime.handleAction("rm -rf"), false);
    h.runtime.tryNow();
    h.runtime.handleAction("start");
    h.runtime.handleAction("end");
    assert.equal(h.runtime.handleAction("ok"), true);
    assert.equal(h.runtime.getPhase(), "idle");
  });

  it("does not invite again while a break or the invite is up", () => {
    const h = harness();
    h.runtime.startTicking();
    h.runtime.tryNow();
    h.runtime.handleAction("start");
    h.runtime.handleAction("pause");
    h.time.advance(3 * 60 * MIN);
    assert.equal(h.log.signs.length, 1);
  });

  it("turning the reminder off takes an open invite away", () => {
    const h = harness();
    h.runtime.tryNow();
    h.state.config = { ...h.state.config, enabled: false };
    h.runtime.handleConfigChanged();
    assert.equal(h.runtime.getPhase(), "idle");
  });
});
