"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createPrefsLiveReload, __test } = require("../src/prefs-live-reload");

function makeFs(files) {
  const state = { files: { ...files }, watchArgs: null, unwatched: null };
  return {
    state,
    readFileSync: (p, enc) => {
      if (!(p in state.files)) {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return state.files[p];
    },
    watchFile: (p, opts, cb) => { state.watchArgs = { p, opts, cb }; },
    unwatchFile: (p, cb) => { state.unwatched = { p, cb }; },
  };
}

const PATH = "C:/prefs/clawd-prefs.json";

function makeController(snapshot = {}, opts = {}) {
  const hydrated = [];
  return {
    hydrated,
    getSnapshot: () => ({ ...snapshot }),
    hydrate: (partial) => {
      hydrated.push(partial);
      return { status: "ok" };
    },
    isLocked: () => opts.locked === true,
    hasReadFailure: () => opts.readFailure === true,
  };
}

function makePrefs(snapshot) {
  let loads = 0;
  return {
    loads: () => loads,
    load: () => { loads += 1; return { snapshot: { ...snapshot }, locked: false }; },
  };
}

describe("prefs live reload", () => {
  it("hydrates only the keys the file changed", () => {
    const fsImpl = makeFs({ [PATH]: JSON.stringify({ notificationBubbleAutoCloseSeconds: 60 }) });
    const controller = makeController({ notificationBubbleAutoCloseSeconds: 6, lang: "zh" });
    const reload = createPrefsLiveReload({
      prefsPath: PATH,
      prefs: makePrefs({ notificationBubbleAutoCloseSeconds: 60, lang: "zh" }),
      controller,
      fsImpl,
    });
    const changed = reload.applyOnce();
    assert.deepEqual(changed, { notificationBubbleAutoCloseSeconds: 60 });
    assert.deepEqual(controller.hydrated, [{ notificationBubbleAutoCloseSeconds: 60 }]);
  });

  it("is a no-op when the file matches the live store", () => {
    const fsImpl = makeFs({ [PATH]: "{}" });
    const controller = makeController({ lang: "zh" });
    const reload = createPrefsLiveReload({
      prefsPath: PATH,
      prefs: makePrefs({ lang: "zh" }),
      controller,
      fsImpl,
    });
    assert.equal(reload.applyOnce(), null);
    assert.deepEqual(controller.hydrated, []);
  });

  it("waits out a half-written file instead of letting prefs.load reset the store", () => {
    const fsImpl = makeFs({ [PATH]: '{"lang": "zh", "agents":' });
    const prefs = makePrefs({ lang: "en" });
    const controller = makeController({ lang: "en" });
    const reload = createPrefsLiveReload({ prefsPath: PATH, prefs, controller, fsImpl });
    assert.equal(reload.applyOnce(), null);
    assert.equal(prefs.loads(), 0, "prefs.load would back the file up and continue from defaults");
    assert.deepEqual(controller.hydrated, []);
  });

  it("ignores a file it cannot read", () => {
    const fsImpl = makeFs({});
    const controller = makeController({ lang: "zh" });
    const reload = createPrefsLiveReload({
      prefsPath: PATH,
      prefs: makePrefs({ lang: "en" }),
      controller,
      fsImpl,
    });
    assert.equal(reload.applyOnce(), null);
    assert.deepEqual(controller.hydrated, []);
  });

  it("stays out of a store that could not read its file", () => {
    for (const opts of [{ locked: true }, { readFailure: true }]) {
      const fsImpl = makeFs({ [PATH]: JSON.stringify({ lang: "en" }) });
      const controller = makeController({ lang: "zh" }, opts);
      const reload = createPrefsLiveReload({
        prefsPath: PATH,
        prefs: makePrefs({ lang: "en" }),
        controller,
        fsImpl,
      });
      assert.equal(reload.applyOnce(), null, Object.keys(opts)[0]);
      assert.deepEqual(controller.hydrated, []);
    }
  });

  it("debounces a burst of change notifications into one apply", async () => {
    const fsImpl = makeFs({ [PATH]: JSON.stringify({ lang: "en" }) });
    const controller = makeController({ lang: "zh" });
    const prefs = makePrefs({ lang: "en" });
    const reload = createPrefsLiveReload({ prefsPath: PATH, prefs, controller, fsImpl, debounceMs: 5 });
    assert.equal(reload.start(), true);
    assert.equal(reload.isRunning(), true);
    const cb = fsImpl.state.watchArgs.cb;
    cb(); cb(); cb();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(prefs.loads(), 1);
    assert.deepEqual(controller.hydrated, [{ lang: "en" }]);
    reload.stop();
    assert.equal(reload.isRunning(), false);
    assert.equal(fsImpl.state.unwatched.p, PATH);
  });

  it("compares object settings structurally", () => {
    assert.equal(__test.sameValue({ a: 1, b: [2] }, { a: 1, b: [2] }), true);
    assert.equal(__test.sameValue({ a: 1 }, { a: 2 }), false);
    assert.equal(__test.sameValue("zh", "zh"), true);
    assert.equal(
      __test.changedSettings({ agents: { a: 1 } }, { agents: { a: 2 }, lang: "zh" }).agents.a,
      1
    );
  });
});
