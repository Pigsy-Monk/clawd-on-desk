"use strict";

// ── Live prefs reload ──
//
// clawd-prefs.json is read once, at startup (src/prefs.js load → the settings
// controller's initial snapshot). A hand edit — by a user, or by a script that
// prefers the file to the Settings window — therefore only took effect after a
// restart. That is too slow for a knob a caller is tuning while it watches the
// pet, so this watcher pushes an edited file into the live store.
//
// Two rules keep it safe:
//
//   - The file is parsed here first. prefs.load() treats invalid JSON as "back
//     the file up and continue from defaults", which is right at startup and
//     catastrophic on a half-written save: it would reset the live store and
//     rename the user's file to .bak. A parse failure here just waits for the
//     next change.
//   - The values go in through controller.hydrate(), the import path that
//     skips pre-commit effects (no writes back to the system: login items,
//     hook installation, theme cleanup). Subscribers still fire, so settings
//     that react through subscribeKey (stretch breaks, dashboard, ...) update.
//     Values identical to the live store are no-ops, which is what makes the
//     app's own saves harmless: they trip the watcher, and hydrate says nil.
//
// Changes are debounced: an editor often writes the file more than once, and a
// save may land in two syscalls. Only readable, valid JSON that settles is
// applied.

const fs = require("fs");

const DEBOUNCE_MS = 300;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// A setting is "the same" when its JSON form is. Objects (agents,
// themeOverrides, bounds) are replaced wholesale by the settings layer, so a
// structural comparison is the honest one; primitives compare as themselves.
function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function changedSettings(next, current) {
  const changed = {};
  if (!isPlainObject(next) || !isPlainObject(current)) return changed;
  for (const key of Object.keys(current)) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) continue;
    if (!sameValue(next[key], current[key])) changed[key] = next[key];
  }
  return changed;
}

// options:
//   prefsPath    absolute path to clawd-prefs.json
//   prefs        module with load(path) → { snapshot, locked, ... }
//   controller   settings controller (getSnapshot / hydrate / isLocked /
//                hasReadFailure)
//   fsImpl       injectable fs (watchFile / unwatchFile / readFileSync) for tests
//   debounceMs   settle window (default 300)
//   onError      optional (err) notification
function createPrefsLiveReload(options = {}) {
  const prefsPath = options.prefsPath;
  const prefs = options.prefs;
  const controller = options.controller;
  const fsImpl = options.fsImpl || fs;
  const debounceMs = Number.isFinite(options.debounceMs) && options.debounceMs >= 0
    ? options.debounceMs
    : DEBOUNCE_MS;
  const onError = typeof options.onError === "function" ? options.onError : () => {};

  if (typeof prefsPath !== "string" || !prefsPath) {
    throw new TypeError("createPrefsLiveReload requires prefsPath");
  }
  if (!prefs || typeof prefs.load !== "function") {
    throw new TypeError("createPrefsLiveReload requires prefs.load");
  }
  if (!controller || typeof controller.getSnapshot !== "function"
      || typeof controller.hydrate !== "function") {
    throw new TypeError("createPrefsLiveReload requires a settings controller");
  }

  let timer = null;
  let stopped = false;
  let watching = false;

  function isLocked() {
    try {
      return typeof controller.isLocked === "function" && controller.isLocked() === true;
    } catch {
      return true;
    }
  }

  function hasReadFailure() {
    try {
      return typeof controller.hasReadFailure === "function" && controller.hasReadFailure() === true;
    } catch {
      return false;
    }
  }

  // Returns the changed keys that were hydrated, {} when nothing changed, or
  // null when the file could not be used this round (half-written, unreadable,
  // locked). Null is not an error: the next change tries again.
  function applyOnce() {
    if (stopped) return null;
    // A store that could not read its file at startup is defaults-only on
    // purpose; importing a file the user may not own would be a guess.
    if (isLocked() || hasReadFailure()) return null;

    let text;
    try {
      text = fsImpl.readFileSync(prefsPath, "utf8");
    } catch {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A partial write. prefs.load() would back the file up and reset the
      // store, so it is deliberately not called here.
      return null;
    }
    if (!isPlainObject(parsed)) return null;

    let loaded;
    try {
      loaded = prefs.load(prefsPath);
    } catch (err) {
      onError(err);
      return null;
    }
    if (!loaded || loaded.locked === true || !isPlainObject(loaded.snapshot)) return null;

    const changed = changedSettings(loaded.snapshot, controller.getSnapshot());
    if (Object.keys(changed).length === 0) return null;

    let result;
    try {
      result = controller.hydrate(changed);
    } catch (err) {
      onError(err);
      return null;
    }
    if (result && typeof result.then === "function") {
      result.then((settled) => {
        if (settled && settled.status !== "ok") {
          onError(new Error(settled.message || "prefs hydrate failed"));
        }
      }, onError);
      return changed;
    }
    if (result && result.status !== "ok") {
      onError(new Error(result.message || "prefs hydrate failed"));
      return null;
    }
    return changed;
  }

  function schedule() {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      applyOnce();
    }, debounceMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function start() {
    if (stopped || watching) return false;
    watching = true;
    // Polling (watchFile) rather than fs.watch: an atomic save (write temp +
    // rename, what many editors and scripts do) makes inode-based watchers
    // lose the file. One stat per second on a small file is cheap.
    fsImpl.watchFile(prefsPath, { interval: 1000, persistent: false }, schedule);
    return true;
  }

  function stop() {
    stopped = true;
    watching = false;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      fsImpl.unwatchFile(prefsPath, schedule);
    } catch {}
  }

  return {
    start,
    stop,
    applyOnce,
    // Exposed for tests and for callers that want to apply a known edit.
    isRunning: () => watching && !stopped,
  };
}

module.exports = {
  createPrefsLiveReload,
  DEBOUNCE_MS,
  __test: { changedSettings, sameValue },
};
