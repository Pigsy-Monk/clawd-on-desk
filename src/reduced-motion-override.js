"use strict";

// "Animate even when the system asks for reduced motion" (pref
// ignoreReducedMotion, default off).
//
// Windows' "Show animations in Windows" off (and the macOS / Linux
// equivalents) makes every page report prefers-reduced-motion: reduce. Clawd
// honours that everywhere — the SVGs' own @media rules, the notice sign's
// marquee and hand-to-hand tosses, a pose card's figure — so on such a machine
// the pet stands still. Some users want the rest of the system calm and the
// pet moving; this lets them.
//
// There is no Chromium switch that turns the system setting off for one app
// (only --force-prefers-reduced-motion, the other way round), so the override
// is DevTools-protocol media emulation per page: Emulation.setEmulatedMedia
// with prefers-reduced-motion: no-preference. That reaches the page's
// matchMedia and the CSS of documents nested in it (SVG <object>s), survives a
// reload, and applies and clears live. The cost, and why it is off by
// default: a page with the emulation attached cannot have DevTools opened on
// it at the same time — opening DevTools detaches it, and it is re-attached
// on the page's next load.

const PROTOCOL_VERSION = "1.3";
const FEATURE = Object.freeze({ name: "prefers-reduced-motion", value: "no-preference" });

function createReducedMotionOverride(options = {}) {
  const isEnabled = typeof options.isEnabled === "function" ? options.isEnabled : () => false;
  const log = typeof options.log === "function" ? options.log : () => {};
  // webContents we attached the debugger to ourselves; only those are ours
  // to detach.
  const owned = new WeakSet();
  const tracked = new Set();

  function alive(wc) {
    return !!wc && !(typeof wc.isDestroyed === "function" && wc.isDestroyed());
  }

  function apply(wc) {
    if (!alive(wc) || !wc.debugger) return Promise.resolve(false);
    const dbg = wc.debugger;
    try {
      if (!dbg.isAttached()) {
        dbg.attach(PROTOCOL_VERSION);
        owned.add(wc);
      } else if (!owned.has(wc)) {
        // Someone else (DevTools, a test harness) holds it: leave it alone.
        return Promise.resolve(false);
      }
    } catch (err) {
      log(`reduced-motion override: attach failed: ${err && err.message}`);
      return Promise.resolve(false);
    }
    return dbg.sendCommand("Emulation.setEmulatedMedia", { features: [FEATURE] })
      .then(() => true, (err) => {
        log(`reduced-motion override: emulation failed: ${err && err.message}`);
        return false;
      });
  }

  function clear(wc) {
    if (!alive(wc) || !wc.debugger || !owned.has(wc)) return Promise.resolve(false);
    const dbg = wc.debugger;
    owned.delete(wc);
    if (!dbg.isAttached()) return Promise.resolve(true);
    return dbg.sendCommand("Emulation.setEmulatedMedia", { features: [] })
      .catch(() => {})
      .then(() => {
        try { dbg.detach(); } catch {}
        return true;
      });
  }

  // Every page of the app gets the same treatment: the pet, the hit window,
  // the notice cards, Settings, the Dashboard.
  function track(wc) {
    if (!alive(wc) || tracked.has(wc)) return;
    tracked.add(wc);
    wc.on("did-finish-load", () => { if (isEnabled()) apply(wc); });
    if (wc.debugger && typeof wc.debugger.on === "function") {
      wc.debugger.on("detach", () => { owned.delete(wc); });
    }
    wc.once("destroyed", () => { tracked.delete(wc); });
    if (isEnabled() && typeof wc.isLoading === "function" && !wc.isLoading()) apply(wc);
  }

  // The pref changed: apply to or clear every page that is already open.
  function sync() {
    const on = isEnabled();
    return Promise.all([...tracked].map((wc) => (on ? apply(wc) : clear(wc))));
  }

  return { track, sync, apply, clear };
}

module.exports = { createReducedMotionOverride, REDUCED_MOTION_FEATURE: FEATURE };
