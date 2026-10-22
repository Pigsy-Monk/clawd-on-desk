"use strict";

// `eyeTracking.trackingLayers` validation. The translate shape has to stay
// exactly as permissive as it was (existing themes declare it and nothing else);
// the aim modes ("rotate" / "foreshorten") are the new, checked surface.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const schema = require("../src/theme-schema");

function themeWithLayers(trackingLayers) {
  return {
    schemaVersion: 1,
    name: "Tracking",
    version: "1.0.0",
    viewBox: { x: 0, y: 0, width: 200, height: 200 },
    states: {
      idle: ["idle.svg"],
      yawning: ["yawning.svg"],
      dozing: ["dozing.svg"],
      collapsing: ["collapsing.svg"],
      thinking: ["thinking.svg"],
      working: ["working.svg"],
      sleeping: ["sleeping.svg"],
      waking: ["waking.svg"],
    },
    eyeTracking: { enabled: true, states: ["idle"], trackingLayers },
  };
}

function errorsFor(trackingLayers) {
  return schema.validateTheme(themeWithLayers(trackingLayers));
}

function expectError(trackingLayers, pattern) {
  const errors = errorsFor(trackingLayers);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got ${JSON.stringify(errors)}`
  );
}

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
  behind: "mirror",
};

const YAW = {
  ids: ["aim-yaw"],
  mode: "foreshorten",
  pivot: [124, 39],
  maxAngle: 25,
  ease: 0.2,
  rampPx: 160,
  when: "behind",
};

describe("theme schema: trackingLayers", () => {
  it("accepts the existing translate-only layers unchanged", () => {
    assert.deepStrictEqual(errorsFor({
      eyes: { ids: ["eye-sockets"], maxOffset: 20, ease: 0.2 },
      head: { ids: ["outline-head"], classes: ["ear-anim"], maxOffset: 12, ease: 0.12 },
    }), []);
  });

  it("accepts an explicit mode: translate", () => {
    assert.deepStrictEqual(errorsFor({ eyes: { mode: "translate", ids: ["eyes-js"], maxOffset: 3 } }), []);
  });

  it("accepts both demo aim schemes", () => {
    assert.deepStrictEqual(errorsFor({ turret: TURRET }), []);
    assert.deepStrictEqual(errorsFor({ gunPitch: TURRET, gunYaw: YAW }), []);
  });

  it("accepts a rotate layer without the optional fields", () => {
    assert.deepStrictEqual(errorsFor({
      turret: { mode: "rotate", pivot: [10, 10], minAngle: -5, maxAngle: 5 },
    }), []);
  });

  it("rejects an unknown mode", () => {
    expectError({ t: { mode: "spin", pivot: [1, 2] } }, /\.mode must be one of translate \/ rotate \/ foreshorten/);
  });

  it("rejects a field that does not belong to the layer's mode", () => {
    expectError({ t: { ...TURRET, nope: 1 } }, /\.nope is not a valid field for mode "rotate"/);
    expectError({ y: { ...YAW, behind: "mirror" } }, /\.behind is not a valid field for mode "foreshorten"/);
    expectError({ y: { ...YAW, minAngle: -5 } }, /\.minAngle is not a valid field for mode "foreshorten"/);
  });

  it("requires a pivot for the aim modes", () => {
    expectError({ t: { mode: "rotate", minAngle: -5, maxAngle: 5 } }, /\.pivot must be an \[x, y\] pair/);
    expectError({ y: { mode: "foreshorten", maxAngle: 5 } }, /\.pivot must be an \[x, y\] pair/);
  });

  it("requires angle limits that keep the rest angle reachable", () => {
    expectError({ t: { mode: "rotate", pivot: [1, 2] } }, /\.minAngle and .*\.maxAngle must be finite numbers/);
    expectError({ t: { mode: "rotate", pivot: [1, 2], minAngle: 1, maxAngle: 5 } }, /minAngle must be <= 0/);
    expectError({ t: { mode: "rotate", pivot: [1, 2], minAngle: -5, maxAngle: -1 } }, /maxAngle must be >= 0/);
  });

  it("requires a positive yaw range for foreshorten", () => {
    expectError({ y: { mode: "foreshorten", pivot: [1, 2] } }, /\.maxAngle must be a finite number of degrees greater than 0/);
    expectError({ y: { mode: "foreshorten", pivot: [1, 2], maxAngle: 0 } }, /\.maxAngle must be a finite number of degrees greater than 0/);
  });

  it("rejects unknown enum values", () => {
    expectError({ t: { ...TURRET, behind: "sideways" } }, /\.behind must be one of mirror \/ clamp/);
    expectError({ y: { ...YAW, when: "always" } }, /\.when must be one of behind/);
  });

  it("rejects malformed shared fields", () => {
    expectError({ t: { ...TURRET, ids: [] } }, /\.ids must be a non-empty array/);
    expectError({ t: { ...TURRET, classes: [""] } }, /\.classes must be a non-empty array/);
    expectError({ t: { ...TURRET, ease: 0 } }, /\.ease must be a finite number in \(0, 1\]/);
    expectError({ t: { ...TURRET, maxOffset: -1 } }, /\.maxOffset must be a finite number greater than 0/);
    expectError({ t: { ...TURRET, rampPx: -1 } }, /\.rampPx must be a finite number greater than or equal to 0/);
    expectError({ t: { ...TURRET, aimOrigin: [1] } }, /\.aimOrigin must be an \[x, y\] pair/);
    expectError({ t: { ...TURRET, restAngle: "up" } }, /\.restAngle must be a finite number/);
  });

  it("rejects a trackingLayers that is not an object", () => {
    expectError([], /eyeTracking\.trackingLayers must be an object/);
    expectError("eyes", /eyeTracking\.trackingLayers must be an object/);
  });

  it("rejects a layer that is not an object", () => {
    expectError({ eyes: 3 }, /\.eyes must be an object/);
  });

  it("leaves themes without trackingLayers alone", () => {
    const theme = themeWithLayers(undefined);
    delete theme.eyeTracking.trackingLayers;
    assert.deepStrictEqual(schema.validateTheme(theme), []);
  });
});

// The schema check is only half the contract: a theme that trips validateTheme
// is silently replaced by clawd at load time, so an aim theme has to survive the
// real loader — and keep its layers, its click-line pools and its defaults.
describe("theme loader: aim layers round-trip", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const themeLoader = require("../src/theme-loader");

  function writeUserTheme() {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-aim-theme-"));
    const dir = path.join(userData, "themes", "aim-test");
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    const theme = themeWithLayers({ turret: TURRET, gunYaw: YAW });
    theme.eyeTracking.maxOffset = 3;
    theme.reactions = {
      clickLeft: { files: ["say-a.svg", "say-b.svg"], duration: 3000 },
      clickRight: { file: "say-c.svg", duration: 3000 },
    };
    fs.writeFileSync(path.join(dir, "theme.json"), JSON.stringify(theme), "utf8");
    fs.writeFileSync(
      path.join(dir, "assets", "idle.svg"),
      '<svg viewBox="0 0 200 200"><g id="aim-turret"><g id="aim-yaw"></g></g></svg>',
      "utf8"
    );
    return userData;
  }

  it("loads an aim theme without falling back to clawd", () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-aim-userdata-"));
    const source = writeUserTheme();
    try {
      fs.cpSync(path.join(source, "themes"), path.join(userData, "themes"), { recursive: true });
      themeLoader.init(path.join(__dirname, "..", "src"), userData);
      const theme = themeLoader.loadTheme("aim-test", { strict: true });
      assert.strictEqual(theme._id, "aim-test");
      assert.strictEqual(theme.eyeTracking.trackingLayers.turret.mode, "rotate");
      assert.deepStrictEqual(theme.eyeTracking.trackingLayers.turret.pivot, [113, 66]);
      assert.strictEqual(theme.eyeTracking.trackingLayers.gunYaw.mode, "foreshorten");
      assert.deepStrictEqual(theme.reactions.clickLeft.files, ["say-a.svg", "say-b.svg"]);
    } finally {
      // Restore the loader's directory state for the rest of the suite.
      themeLoader.init(path.join(__dirname, "..", "src"));
      fs.rmSync(userData, { recursive: true, force: true });
      fs.rmSync(source, { recursive: true, force: true });
    }
  });
});
