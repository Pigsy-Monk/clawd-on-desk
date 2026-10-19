"use strict";

// A notice that arrives while the pet is docked at a screen edge (mini mode):
// the pet jumps out of the edge, shows the notice on its head sign as it
// would anywhere else, and docks back at the same edge once the sign is down
// and no card is open. The pet only goes back if it is still where it landed:
// the user moving it, docking it themselves, or turning mini off on the way
// all leave it where they put it.
//
//   exiting  — the jump out of mini mode is running;
//   showing  — the head sign is up (or the card it opened);
//   then back into mini at the edge it came from.

const TICK_MS = 150;
// Give the pet a moment on its feet before the sign goes up, so the jump's
// own state change does not cut the sign short.
const SETTLE_MS = 200;
// A jump that never finishes (display change mid-flight...) stops waiting.
const EXIT_TIMEOUT_MS = 4000;
// A card left open does not keep the pet out of the edge forever.
const CARD_WAIT_MAX_MS = 60000;
// Moving the pet further than this counts as the user taking over.
const MOVED_PX = 6;

function createMiniNoticePopout(options = {}) {
  const isMini = options.isMini || (() => false);
  const isMiniTransitioning = options.isMiniTransitioning || (() => false);
  const getEdge = options.getEdge || (() => null);
  const getPetBounds = options.getPetBounds || (() => null);
  const getWorkArea = options.getWorkArea || (() => null);
  const exitMini = options.exitMini || (() => {});
  const enterMini = options.enterMini || (() => {});
  const playSign = options.playSign || (() => false);
  const isSignUp = options.isSignUp || (() => false);
  const isCardOpen = options.isCardOpen || (() => false);
  const revealCards = options.revealCards || (() => {});
  const now = options.now || (() => Date.now());
  const setTicker = options.setInterval || setInterval;
  const clearTicker = options.clearInterval || clearInterval;

  let run = null;

  function stop() {
    if (run && run.ticker) clearTicker(run.ticker);
    run = null;
  }

  function moved(from, to) {
    return !from || !to
      || Math.abs(from.x - to.x) > MOVED_PX
      || Math.abs(from.y - to.y) > MOVED_PX;
  }

  function tick() {
    if (!run) return;
    const t = now();
    if (run.phase === "exiting") {
      if (isMini() || isMiniTransitioning()) {
        if (t - run.startedAt > EXIT_TIMEOUT_MS) {
          // Never landed: show the card instead of losing the notice.
          stop();
          revealCards();
        }
        return;
      }
      if (run.landedAt === null) {
        run.landedAt = t;
        run.landed = getPetBounds();
        return;
      }
      if (t - run.landedAt < SETTLE_MS) return;
      run.phase = "showing";
      let shown = false;
      try { shown = playSign(run.payload, run.notice) === true; } catch { shown = false; }
      if (!shown) revealCards();
      return;
    }
    // showing: wait for the sign (and any card it opened) to be gone.
    if (isMini() || isMiniTransitioning()) { stop(); return; }
    if (moved(run.landed, getPetBounds())) { stop(); return; }
    if (isSignUp()) { run.signDownAt = null; return; }
    if (run.signDownAt === null) run.signDownAt = t;
    if (isCardOpen() && t - run.signDownAt < CARD_WAIT_MAX_MS) return;
    const { edge, workArea } = run;
    stop();
    enterMini(workArea, edge);
  }

  // The pet is docked and a notice wants its sign. Returns false when it
  // cannot jump out (not docked, mid-transition, no edge), so the caller
  // shows the card as mini mode always did.
  function start(payload, notice = null) {
    if (!payload) return false;
    // Already out for an earlier notice: the newest one takes the sign.
    if (run && run.phase === "exiting") {
      run.payload = payload;
      run.notice = notice;
      return true;
    }
    if (!isMini() || isMiniTransitioning()) return false;
    const edge = getEdge();
    const bounds = getPetBounds();
    const workArea = bounds ? getWorkArea(bounds) : null;
    if ((edge !== "left" && edge !== "right") || !workArea) return false;
    stop();
    run = {
      phase: "exiting",
      payload,
      notice,
      edge,
      workArea,
      startedAt: now(),
      landedAt: null,
      landed: null,
      signDownAt: null,
      ticker: null,
    };
    exitMini();
    run.ticker = setTicker(tick, TICK_MS);
    return true;
  }

  return {
    start,
    cancel: stop,
    // The notice whose card waits while the pet is still jumping out.
    getPendingId: () => (run && run.phase === "exiting" && run.payload ? run.payload.id || null : null),
    getPhase: () => (run ? run.phase : null),
    isActive: () => !!run,
  };
}

module.exports = {
  createMiniNoticePopout,
  TICK_MS,
  SETTLE_MS,
  EXIT_TIMEOUT_MS,
  CARD_WAIT_MAX_MS,
};
