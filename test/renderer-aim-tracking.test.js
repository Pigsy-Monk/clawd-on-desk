"use strict";

// The renderer side of aim tracking: parsing `mode` out of trackingLayers,
// wrapping the targets, easing the angle / foreshortening towards the cursor
// sample, and mirroring the result when the pet is drawn mirrored.
//
// The angle math itself lives in src/aim-tracking.js and is covered by
// test/aim-tracking.test.js; these cases are about the wiring.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { FakeElement, createRendererHarness } = require("./helpers/renderer-harness");

const VIEW_BOX = { x: 0, y: 0, width: 200, height: 200 };

const TURRET = {
  ids: ["aim-turret"],
  mode: "rotate",
  pivot: [113, 66],
  aimOrigin: [124, 39],
  restAngle: -14,
  minAngle: -15,
  maxAngle: 8,
  ease: 0.2,
  rampPx: 160,
};

const YAW = {
  ids: ["aim-yaw"],
  mode: "foreshorten",
  pivot: [124, 39],
  maxAngle: 25,
  ease: 0.2,
  rampPx: 160,
};

// The harness's fake SVG document: one element per id, all children of the root
// so the wrapper <g>s have somewhere to go.
function attachTrackingSvg(objectEl, ids) {
  const root = new FakeElement("svg");
  const elements = new Map();
  const svgDoc = {
    defaultView: {},
    documentElement: root,
    createElementNS(_namespace, tagName) {
      const element = new FakeElement(tagName);
      element.ownerDocument = svgDoc;
      return element;
    },
    getElementById(id) {
      if (elements.has(id)) return elements.get(id);
      return root.children.find((child) => child.id === id) || null;
    },
    querySelectorAll(selector) {
      if (typeof selector !== "string" || !selector.startsWith(".")) return [];
      const className = selector.slice(1);
      return root.children.filter((child) => child.classList.contains(className));
    },
  };
  root.ownerDocument = svgDoc;
  for (const id of ids) {
    const element = new FakeElement("g");
    element.id = id;
    element.ownerDocument = svgDoc;
    elements.set(id, element);
    root.appendChild(element);
  }
  objectEl.contentDocument = svgDoc;
  return { root, svgDoc, elements };
}

function aimHarness({ trackingLayers, extraConfig = {} } = {}) {
  const harness = createRendererHarness({
    themeConfig: {
      viewBox: VIEW_BOX,
      eyeTracking: {
        enabled: true,
        states: ["idle"],
        maxOffset: 3,
        trackingLayers: trackingLayers || { eyes: { ids: ["eyes-js"], maxOffset: 3, ease: 0.2 }, turret: TURRET, yaw: YAW },
      },
      idleFollowSvg: "current.svg",
      ...extraConfig,
    },
  });
  return harness;
}

function attach(harness, ids = ["eyes-js", "aim-turret", "aim-yaw"]) {
  const svg = attachTrackingSvg(harness.clawd, ids);
  harness.api.setCurrentState("idle");
  harness.api.attachEyeTracking(harness.clawd);
  return svg;
}

// The eased loop is driven by requestAnimationFrame, which the harness maps to a
// 16ms timeout.
function runFrames(harness, count = 60) {
  for (let i = 0; i < count; i++) {
    const timer = harness.activeTimers().find((candidate) => candidate.ms === 16);
    if (!timer) return i;
    timer.cleared = true;
    timer.callback();
  }
  return count;
}

function transformOf(harness, layerName) {
  const layer = harness.api.trackingLayers[layerName];
  assert.ok(layer, `layer ${layerName} must exist`);
  assert.ok(layer.wrappers.length > 0, `layer ${layerName} must have a wrapper`);
  return layer.wrappers[0].getAttribute("transform");
}

describe("renderer aim tracking", () => {
  it("keeps translate layers without a mode on the existing path", () => {
    const harness = aimHarness();
    attach(harness);
    const eyes = harness.api.trackingLayers.eyes;
    assert.strictEqual(eyes.aim, null, "a layer without a mode must stay translate-only");

    harness.electronHandlers.onEyeMove(3, -1);
    runFrames(harness, 40);
    // maxOffset 3 over the theme's maxOffset 3 => 1:1, quantized to 1/4 px.
    assert.strictEqual(transformOf(harness, "eyes"), "translate(3,-1)");
  });

  it("builds aim layers from the config and leaves them at rest without a sample", () => {
    const harness = aimHarness();
    attach(harness);
    const turret = harness.api.trackingLayers.turret;
    assert.strictEqual(turret.aim.mode, "rotate");
    // Spread into a host-realm array: the layer's own array comes from the vm.
    assert.deepStrictEqual([...turret.aim.pivot], [113, 66]);
    assert.deepStrictEqual([...turret.aim.aimOrigin], [124, 39]);
    assert.strictEqual(turret.aim.ease, 0.2);
    assert.strictEqual(turret.aim.rampPx, 160);
    assert.strictEqual(turret.aim.restAngle, -14);
    assert.strictEqual(harness.api.trackingLayers.yaw.aim.mode, "foreshorten");

    // No sample has arrived, so nothing has been written yet: the art keeps the
    // orientation its own SVG author gave it.
    assert.strictEqual(turret.aim.angle, 0);
    assert.strictEqual(turret.aim.scaleX, 1);
    assert.strictEqual(turret.wrappers[0].getAttribute("transform"), "");
  });

  it("rotates the turret towards the cursor sample and settles there", () => {
    const harness = aimHarness();
    attach(harness);
    // ppu = 1 (200px art rect over a 200-unit viewBox). A level cursor far to the
    // right depresses the barrel to maxAngle.
    harness.electronHandlers.onEyeMove(0, 0, { x: 500, y: 39, w: 200, h: 200 });
    runFrames(harness, 200);
    assert.strictEqual(transformOf(harness, "turret"), "rotate(8 113 66)");
  });

  it("foreshortens the yaw layer when the cursor goes behind the pet", () => {
    const harness = aimHarness();
    attach(harness);
    harness.electronHandlers.onEyeMove(0, 0, { x: -300, y: 39, w: 200, h: 200 });
    runFrames(harness, 200);
    // cos(25°) = 0.906
    assert.strictEqual(transformOf(harness, "yaw"), "translate(124 39) scale(0.906 1) translate(-124 -39)");
  });

  it("eases rather than snapping in one frame", () => {
    const harness = aimHarness();
    attach(harness);
    harness.electronHandlers.onEyeMove(0, 0, { x: 500, y: 39, w: 200, h: 200 });
    runFrames(harness, 1);
    const first = transformOf(harness, "turret");
    assert.notStrictEqual(first, "rotate(8 113 66)");
    assert.strictEqual(first, "rotate(1.6 113 66)");
  });

  it("returns to rest when a frame arrives without a sample", () => {
    const harness = aimHarness();
    attach(harness);
    harness.electronHandlers.onEyeMove(0, 0, { x: 500, y: 39, w: 200, h: 200 });
    runFrames(harness, 200);
    assert.strictEqual(transformOf(harness, "turret"), "rotate(8 113 66)");

    // tick.js's eye-move(0, 0) on a state change / mouse idle carries no sample.
    harness.electronHandlers.onEyeMove(0, 0);
    runFrames(harness, 200);
    assert.strictEqual(transformOf(harness, "turret"), "rotate(0 113 66)");
    assert.strictEqual(harness.api.aimSample, null);
  });

  it("ignores a malformed sample and keeps the aim at rest", () => {
    const harness = aimHarness();
    attach(harness);
    harness.electronHandlers.onEyeMove(0, 0, { x: 500, y: 39, w: 0, h: 200 });
    runFrames(harness, 60);
    assert.strictEqual(harness.api.aimSample, null);
    assert.strictEqual(transformOf(harness, "turret"), "rotate(0 113 66)");
  });

  it("mirrors the angle for a pet pinned to the left edge in mini mode", () => {
    const harness = aimHarness();
    attach(harness);
    assert.strictEqual(harness.api.isAimMirrored(), false);

    // Unmirrored, a cursor to the right is in *front*: nothing to foreshorten.
    harness.electronHandlers.onEyeMove(0, 0, { x: 500, y: 39, w: 200, h: 200 });
    runFrames(harness, 200);
    assert.strictEqual(transformOf(harness, "yaw"), "translate(124 39) scale(1 1) translate(-124 -39)");

    harness.electronHandlers.onMiniModeChange(true, "left");
    assert.strictEqual(harness.api.isAimMirrored(), true);

    // Mirroring reflects the cursor about aimOrigin, so the same screen point
    // now reads as behind the pet and the barrel shortens. The flip itself only
    // changes how the next sample is read, so the sample has to arrive again.
    harness.electronHandlers.onEyeMove(0, 0, { x: 500, y: 39, w: 200, h: 200 });
    runFrames(harness, 200);
    assert.strictEqual(transformOf(harness, "yaw"), "translate(124 39) scale(0.906 1) translate(-124 -39)");
    assert.strictEqual(transformOf(harness, "turret"), "rotate(8 113 66)");
  });

  it("mirrors while a theme's roam visual walks left", () => {
    const harness = aimHarness({ extraConfig: { hasRoamVisual: true, roamFlipAssets: false } });
    attach(harness);
    harness.api.setCurrentState("roam");
    assert.strictEqual(harness.api.isAimMirrored(), false);

    harness.electronHandlers.onRoamHeading(true);
    assert.strictEqual(harness.api.isAimMirrored(), true);

    harness.electronHandlers.onRoamHeading(false);
    assert.strictEqual(harness.api.isAimMirrored(), false);
  });

  it("does not mirror for a theme whose roam art already faces left", () => {
    const harness = aimHarness({ extraConfig: { hasRoamVisual: true, roamFlipAssets: true } });
    attach(harness);
    harness.api.setCurrentState("roam");
    harness.electronHandlers.onRoamHeading(true);
    assert.strictEqual(harness.api.isAimMirrored(), false, "flipAssets inverts the heading rule");
  });

  it("drops the aim state when layered tracking is cleaned up", () => {
    const harness = aimHarness();
    attach(harness);
    harness.electronHandlers.onEyeMove(0, 0, { x: 500, y: 39, w: 200, h: 200 });
    runFrames(harness, 5);
    assert.ok(harness.api.aimSample);

    harness.electronHandlers.onThemeConfig({ viewBox: VIEW_BOX, eyeTracking: { enabled: true, states: ["idle"] } });
    assert.strictEqual(harness.api.aimSample, null);
    assert.strictEqual(harness.api.trackingLayers, null);
  });
});
