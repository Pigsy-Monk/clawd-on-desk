"use strict";

// Main-process owner of stretch breaks: the scheduler's clock, the invite
// (the pet's sign, then the invite card), the running session and its card.
// Everything with a window is injected, so this file runs under node:test.
//
// Phases:
//   idle   — nothing on screen; the scheduler ticks.
//   sign   — the pet holds up "Time to stretch?". Left-click the board opens
//            the invite card; right-click it gives the same three choices; 30 s
//            without an answer counts as "later".
//   invite — the invite card: Start / In 10 min / Skip today (× = later).
//   run    — the session card; the sign is down and new notices wait.
//   finish — "All done!" or "Stopping here", closes itself after a moment.

const {
  resolveGroup,
  createStretchSession,
  buildInviteCard,
  buildRunCard,
  buildFinishCard,
  isStretchAction,
  DEFAULT_GROUP_ID,
} = require("./stretch-session");
const { createStretchScheduler, normalizeConfig, SNOOZE_MS } = require("./stretch-scheduler");

const TICK_MS = 30 * 1000;
const SIGN_DWELL_MS = 30 * 1000;
// Backstop in case the render window never reports the sign over.
const SIGN_BACKSTOP_MS = 90 * 1000;
// The sign was taken over or cut short: ask again a little later.
const REPLACED_RETRY_MS = 2 * 60 * 1000;
const DONE_CLOSE_MS = 6000;
const EARLY_CLOSE_MS = 4000;
const SIGN_ID_PREFIX = "stretch-invite-";

function noop() {}

function createStretchRuntime(options = {}) {
  const now = options.now || Date.now;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const getConfig = options.getConfig || (() => ({}));
  const getLang = options.getLang || (() => "zh");
  const getSystemIdleMs = options.getSystemIdleMs || (() => 0);
  const getBlockers = options.getBlockers || (() => []);
  const canShowSign = options.canShowSign || (() => false);
  const raiseSign = options.raiseSign || (() => false);
  const lowerSign = options.lowerSign || noop;
  const showCard = options.showCard || noop;
  const onBusyChange = options.onBusyChange || noop;
  const log = options.log || noop;
  const groupId = options.groupId || DEFAULT_GROUP_ID;

  const scheduler = createStretchScheduler();
  let phase = "idle";
  let session = null;
  let signId = null;
  let signSeq = 0;
  let cardSeq = 0;
  let phaseTimer = null;
  let tickTimer = null;
  let disposed = false;

  function config() {
    return normalizeConfig(getConfig() || {});
  }

  function clearPhaseTimer() {
    if (phaseTimer !== null) {
      clearTimer(phaseTimer);
      phaseTimer = null;
    }
  }

  function setPhaseTimer(ms, fn) {
    clearPhaseTimer();
    phaseTimer = setTimer(() => {
      phaseTimer = null;
      if (!disposed) fn();
    }, Math.max(0, ms));
    if (phaseTimer && typeof phaseTimer.unref === "function") phaseTimer.unref();
  }

  function isBusy() {
    return phase === "run" || phase === "finish";
  }

  function setPhase(next) {
    const wasBusy = isBusy();
    phase = next;
    const busy = isBusy();
    if (wasBusy !== busy) {
      try { onBusyChange(busy); } catch (err) { log(`stretch: onBusyChange failed: ${err && err.message}`); }
    }
  }

  function send(card) {
    if (card) cardSeq += 1;
    try {
      showCard(card ? { ...card, seq: cardSeq } : null);
    } catch (err) {
      log(`stretch: showCard failed: ${err && err.message}`);
    }
  }

  function takeSignDown() {
    if (!signId) return;
    const id = signId;
    signId = null;
    try { lowerSign(id); } catch {}
  }

  function backToIdle() {
    clearPhaseTimer();
    takeSignDown();
    session = null;
    send(null);
    setPhase("idle");
  }

  // ── Invite ──

  function openInviteCard() {
    clearPhaseTimer();
    takeSignDown();
    setPhase("invite");
    send(buildInviteCard({ group: resolveGroup(groupId), lang: getLang() }));
  }

  function offerInvite() {
    if (phase !== "idle") return false;
    if (canShowSign()) {
      signSeq += 1;
      const id = `${SIGN_ID_PREFIX}${signSeq}`;
      const lang = getLang();
      const card = buildInviteCard({ group: resolveGroup(groupId), lang });
      signId = id;
      let delivered = false;
      try {
        delivered = raiseSign({ id, title: card.title, level: "info", dwellMs: SIGN_DWELL_MS }) === true;
      } catch {
        delivered = false;
      }
      if (delivered) {
        setPhase("sign");
        setPhaseTimer(SIGN_BACKSTOP_MS, () => {
          if (phase === "sign") later();
        });
        return true;
      }
      signId = null;
    }
    openInviteCard();
    return true;
  }

  // The render window says the sign is down. Only matters while the invite is
  // still only on the sign: then it either timed out (later), or lost the
  // sign — to a newer notice, a permission request, DND, a drag — and asks
  // again a little later rather than popping its card into whatever just
  // happened.
  function handleSignEnded(id, reason) {
    if (phase !== "sign" || id !== signId) return false;
    signId = null;
    if (reason === "dwell") {
      later();
    } else {
      clearPhaseTimer();
      setPhase("idle");
      scheduler.snooze(now(), REPLACED_RETRY_MS);
    }
    return true;
  }

  function later() {
    if (phase !== "sign" && phase !== "invite") return false;
    backToIdle();
    scheduler.snooze(now(), SNOOZE_MS);
    return true;
  }

  function skipToday() {
    if (phase !== "sign" && phase !== "invite") return false;
    backToIdle();
    scheduler.skipToday(now());
    return true;
  }

  // ── Session ──

  function scheduleSegment() {
    clearPhaseTimer();
    if (!session) return;
    const ms = session.msUntilNextSegment();
    if (ms === null) return;
    setPhaseTimer(ms + 5, onSegmentTimer);
  }

  function onSegmentTimer() {
    if (phase !== "run" || !session) return;
    session.tick();
    afterSessionChange();
  }

  function afterSessionChange() {
    if (!session) return;
    if (session.status !== "running") {
      finish();
      return;
    }
    send(buildRunCard(session, getLang()));
    scheduleSegment();
  }

  function start() {
    if (phase === "run" || phase === "finish") return false;
    clearPhaseTimer();
    takeSignDown();
    session = createStretchSession({ group: resolveGroup(groupId), now });
    setPhase("run");
    afterSessionChange();
    return true;
  }

  function finish() {
    const finished = session;
    clearPhaseTimer();
    scheduler.completed(now(), config());
    setPhase("finish");
    send(buildFinishCard(finished, getLang(), { nextMinutes: config().intervalMinutes }));
    setPhaseTimer(finished.status === "done" ? DONE_CLOSE_MS : EARLY_CLOSE_MS, backToIdle);
  }

  function sessionAction(fn) {
    if (phase !== "run" || !session) return false;
    const changed = fn();
    if (changed) afterSessionChange();
    return changed;
  }

  // ── Entry points ──

  // A card button, the × (its `dismiss` action) or a menu item.
  function handleAction(action) {
    if (!isStretchAction(action)) return false;
    switch (action) {
      case "start": return start();
      case "later": return later();
      case "skipToday": return skipToday();
      case "pause": return sessionAction(() => session.pause());
      case "resume": return sessionAction(() => session.resume());
      case "skip": return sessionAction(() => session.skip());
      case "end": return sessionAction(() => session.end());
      case "ok":
        if (phase !== "finish") return false;
        backToIdle();
        return true;
      default: return false;
    }
  }

  // A left-click on the board.
  function handleSignClick(id) {
    if (phase !== "sign" || id !== signId) return false;
    openInviteCard();
    return true;
  }

  // Actions for a right-click menu, as ids (main supplies the labels).
  // onBoard: the click landed on the invite sign.
  function menuActions({ onBoard = false } = {}) {
    if (phase === "sign") return onBoard ? ["start", "later", "skipToday"] : [];
    if (phase === "invite") return ["start", "later", "skipToday"];
    if (phase === "run" && session) return [session.paused ? "resume" : "pause", "skip", "end"];
    return [];
  }

  // "Try it now" from Settings: the invite at once, whatever the clock says.
  function tryNow() {
    if (phase !== "idle") return { status: "ok", alreadyActive: true, phase };
    offerInvite();
    return { status: "ok", phase };
  }

  function tick() {
    if (disposed) return null;
    let idleMs = 0;
    try { idleMs = Number(getSystemIdleMs()) || 0; } catch {}
    let blockers = [];
    try { blockers = getBlockers() || []; } catch {}
    const result = scheduler.evaluate({ now: now(), config: config(), idleMs, busy: phase !== "idle", blockers });
    if (result.action === "invite") offerInvite();
    return result;
  }

  function startTicking() {
    if (tickTimer !== null || disposed) return;
    const loop = () => {
      tickTimer = setTimer(() => {
        tickTimer = null;
        tick();
        if (!disposed) loop();
      }, TICK_MS);
      if (tickTimer && typeof tickTimer.unref === "function") tickTimer.unref();
    };
    tick();
    loop();
  }

  // The prefs changed (interval, window, on/off).
  function handleConfigChanged() {
    scheduler.reset(now(), config());
    if (!config().enabled && (phase === "sign" || phase === "invite")) backToIdle();
  }

  function dispose() {
    disposed = true;
    clearPhaseTimer();
    if (tickTimer !== null) clearTimer(tickTimer);
    tickTimer = null;
  }

  return {
    tick,
    startTicking,
    tryNow,
    offerInvite,
    handleAction,
    handleSignClick,
    handleSignEnded,
    handleConfigChanged,
    menuActions,
    ownsSignId: (id) => typeof id === "string" && id.startsWith(SIGN_ID_PREFIX),
    getPhase: () => phase,
    getSignId: () => signId,
    isBusy,
    isActive: () => phase !== "idle",
    getSession: () => session,
    getScheduler: () => scheduler,
    dispose,
  };
}

module.exports = {
  createStretchRuntime,
  TICK_MS,
  SIGN_DWELL_MS,
  SIGN_BACKSTOP_MS,
  REPLACED_RETRY_MS,
  DONE_CLOSE_MS,
  EARLY_CLOSE_MS,
  SIGN_ID_PREFIX,
};
