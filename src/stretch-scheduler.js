"use strict";

// When to invite the user to a stretch break. Pure: the runtime calls
// evaluate() on a slow timer with the current time, the system idle time and
// the reasons it cannot interrupt right now, and acts on the answer.
//
//   - Every `intervalMinutes` of presence, inside the active window
//     (default weekdays 09:00–19:00).
//   - Away (no keyboard / mouse input for AWAY_IDLE_MS, or the machine slept)
//     drops the pending invite; coming back starts a fresh interval, so a long
//     lunch never ends in an invite the moment the user sits down.
//   - Do not disturb, fullscreen, mini mode, a pending permission request, a
//     notice already on the sign — the invite waits ("defer") and is retried
//     on the next evaluation instead of being lost.
//   - "Later" snoozes for SNOOZE_MS; "Skip today" silences the rest of the day.

const AWAY_IDLE_MS = 10 * 60 * 1000;
const SNOOZE_MS = 10 * 60 * 1000;
// A gap between two evaluations this much longer than the tick means the
// process did not run (suspend / hibernate) — the same as having been away.
const SLEEP_GAP_MS = 5 * 60 * 1000;
const DEFAULT_INTERVAL_MINUTES = 60;
const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 240;
const DEFAULT_START_HOUR = 9;
const DEFAULT_END_HOUR = 19;

function localDayKey(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function clampInt(value, min, max, fallback) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function normalizeConfig(config = {}) {
  return {
    enabled: config.enabled === true,
    intervalMinutes: clampInt(config.intervalMinutes, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES, DEFAULT_INTERVAL_MINUTES),
    startHour: clampInt(config.startHour, 0, 23, DEFAULT_START_HOUR),
    endHour: clampInt(config.endHour, 1, 24, DEFAULT_END_HOUR),
    workdaysOnly: config.workdaysOnly !== false,
  };
}

// Whether `at` (local time) is inside the active window. A start hour at or
// after the end hour wraps past midnight (22–6 is the night); the weekday
// check then applies to the day the window started on.
function isWithinActiveHours(at, config) {
  const c = normalizeConfig(config);
  const d = new Date(at);
  const hour = d.getHours() + d.getMinutes() / 60;
  let day = d.getDay();
  let inside;
  if (c.startHour < c.endHour) {
    inside = hour >= c.startHour && hour < c.endHour;
  } else {
    inside = hour >= c.startHour || hour < c.endHour;
    if (inside && hour < c.endHour) day = (day + 6) % 7;
  }
  if (!inside) return false;
  if (c.workdaysOnly && (day === 0 || day === 6)) return false;
  return true;
}

function createStretchScheduler(initial = {}) {
  let nextDueAt = null;
  let skipDay = null;
  let away = false;
  let lastEvalAt = null;

  function intervalMs(config) {
    return normalizeConfig(config).intervalMinutes * 60 * 1000;
  }

  // One evaluation. Returns { action, reason } where action is:
  //   "none"   — nothing to do (disabled, outside hours, waiting, away…)
  //   "defer"  — due, but something says not now; ask again next tick
  //   "invite" — show the invite now
  function evaluate({ now, config, idleMs = 0, busy = false, blockers = [] }) {
    const c = normalizeConfig(config);
    const previous = lastEvalAt;
    lastEvalAt = now;
    if (!c.enabled) {
      nextDueAt = null;
      away = false;
      return { action: "none", reason: "disabled" };
    }
    // A break (or the invite) is already on screen; its outcome reschedules.
    if (busy) return { action: "none", reason: "busy" };
    if (skipDay !== null && skipDay !== localDayKey(now)) skipDay = null;
    if (previous !== null && now - previous > SLEEP_GAP_MS) {
      away = false;
      nextDueAt = now + intervalMs(c);
      return { action: "none", reason: "resumed" };
    }
    if (idleMs >= AWAY_IDLE_MS) {
      away = true;
      nextDueAt = null;
      return { action: "none", reason: "away" };
    }
    if (away) {
      away = false;
      nextDueAt = now + intervalMs(c);
      return { action: "none", reason: "back" };
    }
    if (!isWithinActiveHours(now, c)) {
      // Leaving the window drops the countdown; entering it starts a fresh
      // one, so the first invite of the day comes an interval after the start.
      nextDueAt = null;
      return { action: "none", reason: "outside-hours" };
    }
    if (skipDay === localDayKey(now)) return { action: "none", reason: "skipped-today" };
    if (nextDueAt === null) {
      nextDueAt = now + intervalMs(c);
      return { action: "none", reason: "armed" };
    }
    if (now < nextDueAt) return { action: "none", reason: "waiting" };
    const blocking = Array.isArray(blockers) ? blockers.filter(Boolean) : [];
    if (blocking.length) return { action: "defer", reason: blocking[0] };
    return { action: "invite", reason: "due" };
  }

  // Outcomes of an invite or a break.
  function snooze(now, ms = SNOOZE_MS) { nextDueAt = now + ms; }
  function skipToday(now) { skipDay = localDayKey(now); nextDueAt = null; }
  function completed(now, config) { nextDueAt = now + intervalMs(config); }
  // Interval or window changed: start counting again from now.
  function reset(now, config) {
    nextDueAt = normalizeConfig(config).enabled ? now + intervalMs(config) : null;
    away = false;
  }

  if (Number.isFinite(initial.nextDueAt)) nextDueAt = initial.nextDueAt;

  return {
    evaluate,
    snooze,
    skipToday,
    completed,
    reset,
    getNextDueAt: () => nextDueAt,
    isSkippedToday: (now) => skipDay === localDayKey(now),
    isAway: () => away,
  };
}

module.exports = {
  AWAY_IDLE_MS,
  SNOOZE_MS,
  SLEEP_GAP_MS,
  DEFAULT_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  DEFAULT_START_HOUR,
  DEFAULT_END_HOUR,
  normalizeConfig,
  isWithinActiveHours,
  localDayKey,
  createStretchScheduler,
};
