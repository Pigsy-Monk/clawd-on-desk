"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createReducedMotionOverride, REDUCED_MOTION_FEATURE } = require("../src/reduced-motion-override");

// A webContents with a debugger, recording what the override does to it.
function fakeContents({ loading = false, attachedByOther = false } = {}) {
  const listeners = {};
  const dbgListeners = {};
  const calls = [];
  let attached = attachedByOther;
  const wc = {
    calls,
    destroyed: false,
    isDestroyed: () => wc.destroyed,
    isLoading: () => loading,
    on: (event, fn) => { (listeners[event] = listeners[event] || []).push(fn); },
    once: (event, fn) => { (listeners[event] = listeners[event] || []).push(fn); },
    emit: (event) => (listeners[event] || []).forEach((fn) => fn()),
    debugger: {
      isAttached: () => attached,
      attach: (version) => { calls.push(["attach", version]); attached = true; },
      detach: () => { calls.push(["detach"]); attached = false; },
      sendCommand: (method, params) => { calls.push([method, params]); return Promise.resolve({}); },
      on: (event, fn) => { (dbgListeners[event] = dbgListeners[event] || []).push(fn); },
      emitDetach: () => { attached = false; (dbgListeners.detach || []).forEach((fn) => fn()); },
    },
  };
  return wc;
}
const tick = () => new Promise((r) => setImmediate(r));

describe("reduced-motion override", () => {
  it("does nothing while the pref is off", async () => {
    const override = createReducedMotionOverride({ isEnabled: () => false });
    const wc = fakeContents();
    override.track(wc);
    wc.emit("did-finish-load");
    await tick();
    assert.deepEqual(wc.calls, []);
  });

  it("emulates no-preference on every loaded page while the pref is on", async () => {
    const override = createReducedMotionOverride({ isEnabled: () => true });
    const loaded = fakeContents();
    const loading = fakeContents({ loading: true });
    override.track(loaded);
    override.track(loading);
    await tick();
    assert.deepEqual(loaded.calls, [["attach", "1.3"], ["Emulation.setEmulatedMedia", { features: [REDUCED_MOTION_FEATURE] }]]);
    assert.deepEqual(loading.calls, [], "a page still loading waits for did-finish-load");
    loading.emit("did-finish-load");
    await tick();
    assert.equal(loading.calls[1][0], "Emulation.setEmulatedMedia");
    assert.deepEqual(REDUCED_MOTION_FEATURE, { name: "prefers-reduced-motion", value: "no-preference" });
  });

  it("applies and clears live when the pref flips, detaching only what it attached", async () => {
    let on = false;
    const override = createReducedMotionOverride({ isEnabled: () => on });
    const ours = fakeContents();
    const others = fakeContents({ attachedByOther: true });
    override.track(ours);
    override.track(others);
    on = true;
    await override.sync();
    assert.equal(ours.calls.length, 2);
    assert.deepEqual(others.calls, [], "a debugger someone else holds is left alone");
    on = false;
    await override.sync();
    assert.deepEqual(ours.calls.slice(2), [["Emulation.setEmulatedMedia", { features: [] }], ["detach"]]);
    assert.deepEqual(others.calls, []);
  });

  it("re-applies on the next load after DevTools took the debugger away", async () => {
    const override = createReducedMotionOverride({ isEnabled: () => true });
    const wc = fakeContents();
    override.track(wc);
    await tick();
    wc.debugger.emitDetach();
    wc.emit("did-finish-load");
    await tick();
    assert.deepEqual(wc.calls.map((c) => c[0]), ["attach", "Emulation.setEmulatedMedia", "attach", "Emulation.setEmulatedMedia"]);
  });

  it("survives an attach that throws and a destroyed page", async () => {
    const logs = [];
    const override = createReducedMotionOverride({ isEnabled: () => true, log: (m) => logs.push(m) });
    const wc = fakeContents({ loading: true });
    wc.debugger.attach = () => { throw new Error("busy"); };
    override.track(wc);
    wc.emit("did-finish-load");
    await tick();
    assert.match(logs[0], /attach failed: busy/);
    const gone = fakeContents();
    gone.destroyed = true;
    override.track(gone);
    assert.equal(await override.apply(gone), false);
  });
});
