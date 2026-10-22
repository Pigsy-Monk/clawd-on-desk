"use strict";

// Aim tracking (turret / gun follow) — the numeric core behind trackingLayers
// layers with mode "rotate" / "foreshorten". These cases are the approved demo's
// geometry: see docs/project/theme-state-ui.md, "Aim Tracking".

const { describe, it } = require("node:test");
const assert = require("node:assert");

const aim = require("../src/aim-tracking");

const VIEW_BOX = { x: 0, y: 0, width: 200, height: 200 };

// Demo scheme A: the whole turret turns about the ring, aimed from the barrel root.
function turretLayer(overrides = {}) {
  return aim.createAimLayer({
    ids: ["aim-turret"],
    mode: "rotate",
    pivot: [113, 66],
    aimOrigin: [124, 39],
    restAngle: -14,
    minAngle: -15,
    maxAngle: 8,
    ease: 0.2,
    rampPx: 160,
    behind: "mirror",
    ...overrides,
  });
}

// Demo scheme B yaw: the barrel shortens along its own axis when the cursor is behind.
function yawLayer(overrides = {}) {
  return aim.createAimLayer({
    ids: ["aim-yaw"],
    mode: "foreshorten",
    pivot: [124, 39],
    maxAngle: 25,
    ease: 0.2,
    rampPx: 160,
    ...overrides,
  });
}

// ppu = 1 here (200 px art rect over a 200 unit viewBox), so px and viewBox units
// are interchangeable and the expected numbers stay readable.
function sample(x, y, extra = {}) {
  return { x, y, w: 200, h: 200, ...extra };
}

function angleOf(layer, s) {
  const target = aim.computeAimTarget(layer, s, VIEW_BOX);
  assert.ok(target, "expected a target");
  return target.angle;
}

describe("aim tracking: layer parsing", () => {
  it("keeps layers without a mode on the existing translate path", () => {
    assert.strictEqual(aim.resolveLayerMode({ ids: ["eyes"], maxOffset: 20 }), "translate");
    assert.strictEqual(aim.resolveLayerMode({ mode: "translate" }), "translate");
    assert.strictEqual(aim.createAimLayer({ ids: ["eyes"], maxOffset: 20, ease: 0.2 }), null);
  });

  it("treats an unknown mode as translate rather than inventing a rotation", () => {
    assert.strictEqual(aim.resolveLayerMode({ mode: "spin" }), "translate");
    assert.strictEqual(aim.createAimLayer({ mode: "spin", pivot: [1, 2] }), null);
  });

  it("refuses an aim layer without a usable pivot", () => {
    assert.strictEqual(aim.createAimLayer({ mode: "rotate", minAngle: -5, maxAngle: 5 }), null);
    assert.strictEqual(aim.createAimLayer({ mode: "rotate", pivot: [1] }), null);
    assert.strictEqual(aim.createAimLayer({ mode: "foreshorten", pivot: ["a", 2] }), null);
  });

  it("defaults aimOrigin to pivot, ease to 0.15 and rampPx to 160", () => {
    const layer = aim.createAimLayer({ mode: "rotate", pivot: [10, 20], minAngle: -5, maxAngle: 5 });
    assert.deepStrictEqual(layer.aimOrigin, [10, 20]);
    assert.strictEqual(layer.ease, 0.15);
    assert.strictEqual(layer.rampPx, 160);
    assert.strictEqual(layer.restAngle, 0);
    assert.strictEqual(layer.behind, "mirror");
    assert.deepStrictEqual({ angle: layer.angle, scaleX: layer.scaleX }, { angle: 0, scaleX: 1 });
  });

  it("keeps an explicit ease / rampPx / aimOrigin", () => {
    const layer = turretLayer();
    assert.strictEqual(layer.ease, 0.2);
    assert.strictEqual(layer.rampPx, 160);
    assert.deepStrictEqual(layer.aimOrigin, [124, 39]);
    assert.deepStrictEqual(layer.pivot, [113, 66]);
  });
});

describe("aim tracking: rotate angles", () => {
  it("sits at rest when the cursor is exactly along restAngle", () => {
    // restAngle −14° points up-right; 200 units out along that direction.
    const rad = (-14 * Math.PI) / 180;
    const x = 124 + Math.cos(rad) * 200;
    const y = 39 + Math.sin(rad) * 200;
    assert.ok(Math.abs(angleOf(turretLayer(), sample(x, y))) < 1e-6);
  });

  it("depresses to maxAngle for a level cursor to the right", () => {
    assert.strictEqual(angleOf(turretLayer(), sample(500, 39)), 8);
  });

  it("raises to minAngle for a cursor straight above the aim origin", () => {
    assert.strictEqual(angleOf(turretLayer(), sample(124, -300)), -15);
  });

  it("clamps a cursor well below the pet at maxAngle", () => {
    assert.strictEqual(angleOf(turretLayer(), sample(500, 400)), 8);
  });

  it("scales the angle towards rest inside rampPx", () => {
    // 10 px out of a 160 px ramp = 1/16 of the way to the clamped 8°.
    const target = angleOf(turretLayer(), sample(134, 39));
    assert.ok(Math.abs(target - 0.5) < 1e-9, `expected 0.5, got ${target}`);
  });

  it("returns to rest when the cursor sits on the aim origin", () => {
    assert.strictEqual(angleOf(turretLayer(), sample(124, 39)), 0);
  });

  it("honours a custom restAngle", () => {
    const layer = turretLayer({ restAngle: 0, minAngle: -20, maxAngle: 20 });
    assert.ok(Math.abs(angleOf(layer, sample(500, 39))) < 1e-9);
  });
});

describe("aim tracking: behind the pet", () => {
  it("mirrors a cursor behind the pet onto the same elevation (behind: mirror)", () => {
    const layer = turretLayer();
    assert.strictEqual(angleOf(layer, sample(500, 39)), angleOf(layer, sample(-300, 39)));
  });

  it("saturates at the limits instead with behind: clamp", () => {
    const layer = turretLayer({ behind: "clamp" });
    // Level but behind: the raw angle is ~180°, so it pins to maxAngle.
    assert.strictEqual(angleOf(layer, sample(-300, 39)), 8);
    // Slightly above the origin but behind: pins the other way.
    assert.strictEqual(angleOf(layer, sample(-300, 30)), -15);
    // The mirror variant answers the opposite way for that same cursor.
    assert.strictEqual(angleOf(turretLayer(), sample(-300, 30)), 8);
  });
});

describe("aim tracking: mirrored pets", () => {
  it("reflects the cursor about aimOrigin, so the angle matches its twin", () => {
    const layer = turretLayer();
    const mirrored = angleOf(layer, sample(500, 39, { mirrored: true }));
    assert.strictEqual(mirrored, angleOf(layer, sample(-300, 39)));
  });

  it("flips which side counts as behind", () => {
    const yaw = yawLayer();
    assert.strictEqual(aim.computeAimTarget(yaw, sample(500, 39), VIEW_BOX).scaleX, 1);
    assert.ok(aim.computeAimTarget(yaw, sample(500, 39, { mirrored: true }), VIEW_BOX).scaleX < 1);
  });
});

describe("aim tracking: foreshorten", () => {
  it("never shortens while the cursor is in front", () => {
    const yaw = yawLayer();
    assert.strictEqual(aim.computeAimTarget(yaw, sample(500, 39), VIEW_BOX).scaleX, 1);
    assert.strictEqual(aim.computeAimTarget(yaw, sample(124, 39), VIEW_BOX).scaleX, 1);
  });

  it("shortens to cos(maxAngle) once the cursor is far enough behind", () => {
    const yaw = yawLayer();
    const target = aim.computeAimTarget(yaw, sample(-300, 39), VIEW_BOX);
    assert.strictEqual(target.angle, 0);
    assert.ok(Math.abs(target.scaleX - Math.cos((25 * Math.PI) / 180)) < 1e-12);
  });

  it("ramps the shortening in over the first 80 units behind", () => {
    // rampPx 0 disables the distance ramp, isolating the 80-unit yaw span.
    const yaw = yawLayer({ rampPx: 0 });
    // 40 units behind = half the span, so half of the 25° yaw.
    const half = aim.computeAimTarget(yaw, sample(84, 39), VIEW_BOX).scaleX;
    assert.ok(Math.abs(half - Math.cos((12.5 * Math.PI) / 180)) < 1e-12, `got ${half}`);
  });

  it("scales the yaw by rampPx like the rotation does", () => {
    const yaw = yawLayer({ rampPx: 1000 });
    const near = aim.computeAimTarget(yaw, sample(-300, 39), VIEW_BOX).scaleX;
    const far = aim.computeAimTarget(yaw, sample(-900, 39), VIEW_BOX).scaleX;
    assert.ok(near > far, "a cursor closer to the pet must shorten less");
  });

  it("never rotates", () => {
    const yaw = yawLayer();
    assert.strictEqual(aim.computeAimTarget(yaw, sample(-300, -300), VIEW_BOX).angle, 0);
  });
});

describe("aim tracking: easing", () => {
  it("lerps towards the target with the layer's ease", () => {
    const next = aim.easeAim({ angle: 0, scaleX: 1 }, { angle: 8, scaleX: 1 }, 0.2);
    assert.ok(Math.abs(next.angle - 1.6) < 1e-12);
  });

  it("settles exactly onto the target once inside the epsilon", () => {
    const next = aim.easeAim({ angle: 7.99, scaleX: 1 }, { angle: 8, scaleX: 1 }, 0.2);
    assert.strictEqual(next.angle, 8);
    assert.strictEqual(aim.isAimSettled(next, { angle: 8, scaleX: 1 }), true);
  });

  it("is not settled while the angle is still far away", () => {
    assert.strictEqual(aim.isAimSettled({ angle: 0, scaleX: 1 }, { angle: 8, scaleX: 1 }), false);
  });

  it("converges to rest and reports settled when the sample disappears", () => {
    let current = { angle: 8, scaleX: 0.9 };
    for (let i = 0; i < 200; i++) {
      current = aim.easeAim(current, aim.REST, 0.2);
      if (aim.isAimSettled(current, aim.REST)) break;
    }
    assert.deepStrictEqual(current, { angle: 0, scaleX: 1 });
    assert.strictEqual(aim.isAimSettled(current, aim.REST), true);
  });
});

describe("aim tracking: transforms", () => {
  it("builds the rotate transform around pivot", () => {
    assert.strictEqual(aim.aimTransform(turretLayer(), { angle: 8.04, scaleX: 1 }), "rotate(8 113 66)");
    assert.strictEqual(aim.aimTransform(turretLayer(), { angle: -15, scaleX: 1 }), "rotate(-15 113 66)");
  });

  it("builds the foreshorten scale around pivot", () => {
    assert.strictEqual(
      aim.aimTransform(yawLayer(), { angle: 0, scaleX: 0.9063077 }),
      "translate(124 39) scale(0.906 1) translate(-124 -39)"
    );
  });

  it("writes 0 rather than -0", () => {
    assert.strictEqual(aim.aimTransform(turretLayer(), { angle: -0.01, scaleX: 1 }), "rotate(0 113 66)");
    assert.strictEqual(
      aim.aimTransform(yawLayer({ pivot: [0, 0] }), { angle: 0, scaleX: 1 }),
      "translate(0 0) scale(1 1) translate(0 0)"
    );
  });
});

describe("aim tracking: malformed input", () => {
  it("rejects samples that are not four finite numbers", () => {
    assert.strictEqual(aim.normalizeAimSample(null), null);
    assert.strictEqual(aim.normalizeAimSample({ x: 1, y: 2, w: 3 }), null);
    assert.strictEqual(aim.normalizeAimSample({ x: 1, y: 2, w: 0, h: 3 }), null);
    assert.strictEqual(aim.normalizeAimSample({ x: NaN, y: 2, w: 3, h: 3 }), null);
    assert.deepStrictEqual(aim.normalizeAimSample({ x: 1, y: 2, w: 3, h: 4, mirrored: true }),
      { x: 1, y: 2, w: 3, h: 4 });
  });

  it("keeps a valid sample as-is", () => {
    const sampleIn = { x: 1.5, y: -2.25, w: 200, h: 150 };
    assert.deepStrictEqual(aim.normalizeAimSample(sampleIn), sampleIn);
  });

  it("returns no target when the geometry cannot be resolved", () => {
    const layer = turretLayer();
    assert.strictEqual(aim.computeAimTarget(layer, sample(1, 1), { x: 0, y: 0, width: 0, height: 10 }), null);
    assert.strictEqual(aim.computeAimTarget(layer, { x: 1, y: 1, w: 0, h: 10 }, VIEW_BOX), null);
    assert.strictEqual(aim.computeAimTarget(null, sample(1, 1), VIEW_BOX), null);
    assert.strictEqual(aim.computeAimTarget({ mode: "translate" }, sample(1, 1), VIEW_BOX), null);
  });
});

// The approved demo's own geometry, transcribed from
// `tools/interact-page-2.js` in the design demo. These cases pin the *formula*
// the user picked rather than this module's reading of it: if the angle, the
// clamp order, the ramp or the foreshortening span ever drifts, the numbers
// below stop matching.
describe("aim tracking: parity with the approved demo", () => {
  const DEMO_A = { pivot: [113, 66], origin: [124, 39], rest: -14, upMax: 15, downMax: 8 };
  const DEMO_B_YAW = { pivot: [124, 39], yawMax: 25 };

  function demoRotateDegrees(samplePx, rampPx = 160) {
    const vx = samplePx.x - DEMO_A.origin[0];
    const vy = samplePx.y - DEMO_A.origin[1];
    const dist = Math.sqrt(vx * vx + vy * vy);
    const ramp = Math.min(1, dist / Math.max(1, rampPx));
    const ang = Math.atan2(vy, Math.abs(vx)) * (180 / Math.PI);
    const elev = Math.max(-DEMO_A.downMax, Math.min(DEMO_A.upMax, -(ang - DEMO_A.rest))) * ramp;
    return -elev;
  }

  function demoYawScale(samplePx, rampPx = 160) {
    const vx = samplePx.x - DEMO_B_YAW.pivot[0];
    const vy = samplePx.y - DEMO_B_YAW.pivot[1];
    const dist = Math.sqrt(vx * vx + vy * vy);
    const ramp = Math.min(1, dist / Math.max(1, rampPx));
    const yaw = vx < 0
      ? Math.max(0, Math.min(1, -vx / 80)) * DEMO_B_YAW.yawMax * ramp
      : 0;
    return Math.cos((yaw * Math.PI) / 180);
  }

  it("matches the demo's turret angle across the whole cursor plane", () => {
    const layer = turretLayer();
    let worst = 0;
    for (let x = -600; x <= 600; x += 37) {
      for (let y = -600; y <= 600; y += 41) {
        const mine = angleOf(layer, sample(x, y));
        worst = Math.max(worst, Math.abs(mine - demoRotateDegrees({ x, y })));
      }
    }
    assert.ok(worst < 0.01, `angle drifted from the demo by ${worst}°`);
  });

  it("matches the demo's foreshortening across the whole cursor plane", () => {
    const layer = yawLayer();
    let worst = 0;
    for (let x = -600; x <= 600; x += 37) {
      for (let y = -600; y <= 600; y += 41) {
        const mine = aim.computeAimTarget(layer, sample(x, y), VIEW_BOX).scaleX;
        worst = Math.max(worst, Math.abs(mine - demoYawScale({ x, y })));
      }
    }
    assert.ok(worst < 1e-12, `foreshortening drifted from the demo by ${worst}`);
  });
});
