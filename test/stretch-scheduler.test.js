"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  createStretchScheduler,
  isWithinActiveHours,
  normalizeConfig,
  AWAY_IDLE_MS,
  SNOOZE_MS,
  SLEEP_GAP_MS,
} = require("../src/stretch-scheduler");

const MIN = 60 * 1000;
// Local times, so the window checks read the same in every time zone.
const WED_10 = new Date(2026, 9, 14, 10, 0, 0).getTime(); // Wednesday
const WED_18_30 = new Date(2026, 9, 14, 18, 30, 0).getTime();
const WED_19 = new Date(2026, 9, 14, 19, 0, 0).getTime();
const WED_8 = new Date(2026, 9, 14, 8, 59, 0).getTime();
const SAT_10 = new Date(2026, 9, 17, 10, 0, 0).getTime();
const ON = { enabled: true, intervalMinutes: 60, startHour: 9, endHour: 19, workdaysOnly: true };

// Evaluates every 30 s from `from` for `ms`, returning the first non-"none"
// answer (or the last answer). Real ticks are 30 s apart; a bigger jump reads
// as the machine having slept.
function run(sched, from, ms, extra = {}) {
  let last = null;
  for (let t = from; t <= from + ms; t += 30_000) {
    last = sched.evaluate({ now: t, config: ON, ...extra });
    if (last.action !== "none") return { ...last, at: t };
  }
  return { ...last, at: from + ms };
}

// Ticks every 30 s up to (not including) `to` with `extra`, then evaluates at `to`.
function stepTo(sched, from, to, extra = {}, last = {}) {
  for (let t = from; t < to; t += 30_000) sched.evaluate({ now: t, config: ON, ...extra });
  return sched.evaluate({ now: to, config: ON, ...last });
}

describe("stretch scheduler: active hours", () => {
  it("is inside 9–19 on a weekday, outside on the weekend and after hours", () => {
    assert.equal(isWithinActiveHours(WED_10, ON), true);
    assert.equal(isWithinActiveHours(WED_18_30, ON), true);
    assert.equal(isWithinActiveHours(WED_19, ON), false);
    assert.equal(isWithinActiveHours(WED_8, ON), false);
    assert.equal(isWithinActiveHours(SAT_10, ON), false);
    assert.equal(isWithinActiveHours(SAT_10, { ...ON, workdaysOnly: false }), true);
  });

  it("wraps past midnight when the start is after the end", () => {
    const night = { ...ON, startHour: 22, endHour: 6, workdaysOnly: false };
    assert.equal(isWithinActiveHours(new Date(2026, 9, 14, 23, 0).getTime(), night), true);
    assert.equal(isWithinActiveHours(new Date(2026, 9, 15, 3, 0).getTime(), night), true);
    assert.equal(isWithinActiveHours(new Date(2026, 9, 15, 12, 0).getTime(), night), false);
    // Friday-night window that runs into Saturday counts as Friday's.
    const fri = { ...night, workdaysOnly: true };
    assert.equal(isWithinActiveHours(new Date(2026, 9, 17, 2, 0).getTime(), fri), true);
    assert.equal(isWithinActiveHours(new Date(2026, 9, 18, 2, 0).getTime(), fri), false);
  });

  it("normalizes bad config to the defaults", () => {
    assert.deepEqual(normalizeConfig({ enabled: true, intervalMinutes: 3, startHour: 30, endHour: 0, workdaysOnly: "x" }), {
      enabled: true, intervalMinutes: 60, startHour: 9, endHour: 19, workdaysOnly: true,
    });
    assert.equal(normalizeConfig({}).enabled, false);
  });
});

describe("stretch scheduler: timing", () => {
  it("invites one interval after it starts counting", () => {
    const sched = createStretchScheduler();
    assert.equal(sched.evaluate({ now: WED_10, config: ON }).reason, "armed");
    assert.equal(sched.getNextDueAt(), WED_10 + 60 * MIN);
    const r = run(sched, WED_10 + 30_000, 61 * MIN);
    assert.equal(r.action, "invite");
    assert.ok(r.at >= WED_10 + 60 * MIN && r.at < WED_10 + 61 * MIN);
  });

  it("does nothing while disabled, and while a break is already up", () => {
    const sched = createStretchScheduler();
    assert.equal(sched.evaluate({ now: WED_10, config: { ...ON, enabled: false } }).reason, "disabled");
    sched.evaluate({ now: WED_10, config: ON });
    const r = sched.evaluate({ now: WED_10 + 61 * MIN, config: ON, busy: true });
    assert.deepEqual(r, { action: "none", reason: "busy" });
  });

  it("defers while something says not now, and invites once it clears", () => {
    const sched = createStretchScheduler();
    sched.evaluate({ now: WED_10, config: ON });
    const first = stepTo(sched, WED_10 + 30_000, WED_10 + 61 * MIN, { blockers: ["dnd"] }, { blockers: ["dnd"] });
    assert.deepEqual(first, { action: "defer", reason: "dnd" });
    for (const blocker of ["fullscreen", "mini", "permission", "notice-sign"]) {
      const r = sched.evaluate({ now: WED_10 + 61 * MIN + 10_000, config: ON, blockers: [blocker] });
      assert.deepEqual(r, { action: "defer", reason: blocker });
    }
    assert.equal(sched.evaluate({ now: WED_10 + 61.5 * MIN, config: ON }).action, "invite");
  });

  it("snooze waits ten minutes, skip-today waits for tomorrow", () => {
    const sched = createStretchScheduler();
    sched.snooze(WED_10);
    assert.equal(sched.getNextDueAt(), WED_10 + SNOOZE_MS);
    sched.skipToday(WED_10);
    assert.equal(sched.isSkippedToday(WED_10 + 60 * MIN), true);
    assert.equal(sched.evaluate({ now: WED_10 + 120 * MIN, config: ON }).reason, "skipped-today");
    // Next morning (one jump, so it also reads as having slept): counting
    // starts again and nothing is skipped any more.
    const thu = new Date(2026, 9, 15, 9, 30).getTime();
    assert.equal(sched.evaluate({ now: thu, config: ON }).action, "none");
    assert.equal(sched.isSkippedToday(thu), false);
    assert.equal(sched.getNextDueAt(), thu + 60 * MIN);
  });

  it("starts a fresh interval after a break", () => {
    const sched = createStretchScheduler();
    sched.completed(WED_10, { ...ON, intervalMinutes: 45 });
    assert.equal(sched.getNextDueAt(), WED_10 + 45 * MIN);
  });

  it("drops the countdown outside the window and re-arms inside it", () => {
    const sched = createStretchScheduler();
    sched.evaluate({ now: WED_18_30, config: ON });
    assert.equal(stepTo(sched, WED_18_30 + 30_000, WED_19 + 1000).reason, "outside-hours");
    assert.equal(sched.getNextDueAt(), null);
  });
});

describe("stretch scheduler: away", () => {
  it("skips the invite while away and counts a fresh interval on return", () => {
    const sched = createStretchScheduler();
    sched.evaluate({ now: WED_10, config: ON });
    // 55 min in, the user walks off for 20 minutes.
    const leave = WED_10 + 55 * MIN;
    const back = leave + 20 * MIN;
    stepTo(sched, WED_10 + 30_000, leave + AWAY_IDLE_MS - 30_000, {}, { idleMs: AWAY_IDLE_MS - 30_000 });
    for (let t = leave + AWAY_IDLE_MS; t < back; t += 30_000) {
      const r = sched.evaluate({ now: t, config: ON, idleMs: t - leave });
      assert.equal(r.action, "none");
      assert.equal(r.reason, "away");
    }
    assert.equal(sched.isAway(), true);
    const r = sched.evaluate({ now: back, config: ON, idleMs: 0 });
    assert.equal(r.reason, "back");
    assert.equal(sched.getNextDueAt(), back + 60 * MIN);
    assert.equal(stepTo(sched, back + 30_000, back + 59 * MIN).action, "none");
    assert.equal(stepTo(sched, back + 59 * MIN + 30_000, back + 60 * MIN).action, "invite");
  });

  it("a short pause in input is not away", () => {
    const sched = createStretchScheduler();
    sched.evaluate({ now: WED_10, config: ON });
    const r = run(sched, WED_10 + 30_000, 61 * MIN, { idleMs: AWAY_IDLE_MS - 1 });
    assert.equal(r.action, "invite");
  });

  it("treats a sleep gap between evaluations as having been away", () => {
    const sched = createStretchScheduler();
    sched.evaluate({ now: WED_10, config: ON });
    const wake = WED_10 + 61 * MIN + SLEEP_GAP_MS;
    const r = sched.evaluate({ now: wake, config: ON });
    assert.equal(r.reason, "resumed");
    assert.equal(sched.getNextDueAt(), wake + 60 * MIN);
  });

  it("reset (prefs changed) restarts the count", () => {
    const sched = createStretchScheduler();
    sched.evaluate({ now: WED_10, config: ON });
    sched.reset(WED_10 + 30 * MIN, { ...ON, intervalMinutes: 20 });
    assert.equal(sched.getNextDueAt(), WED_10 + 50 * MIN);
    sched.reset(WED_10, { ...ON, enabled: false });
    assert.equal(sched.getNextDueAt(), null);
  });
});
