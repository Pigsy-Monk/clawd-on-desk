"use strict";

// Exercises the REAL CLI (scripts/validate-theme.js) for the aim-layer checks:
// the target element must exist in the SVG, `pivot` must land inside the
// viewBox, and a rotate layer must keep its rest angle reachable.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { describe, it, afterEach } = require("node:test");

const REPO_ROOT = path.join(__dirname, "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "validate-theme.js");

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length) {
    try {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

const TURRET = {
  ids: ["aim-turret"],
  mode: "rotate",
  pivot: [50, 50],
  aimOrigin: [60, 40],
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
  pivot: [60, 40],
  maxAngle: 25,
  ease: 0.2,
  rampPx: 160,
  when: "behind",
};

// A self-contained fixture: one tiny SVG that carries both aim targets, so the
// only findings in the output are the ones this file put there.
function writeFixture({ trackingLayers, svg = '<g id="aim-turret"><g id="aim-yaw"></g></g>' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-validate-aim-"));
  tempDirs.push(dir);
  const states = {};
  for (const name of ["idle", "working", "thinking", "sleeping", "yawning", "dozing", "collapsing", "waking"]) {
    states[name] = ["idle.svg"];
  }
  const theme = {
    schemaVersion: 1,
    name: "Aim Fixture",
    version: "1.0.0",
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
    states,
    eyeTracking: { enabled: true, states: ["idle"], maxOffset: 3, trackingLayers },
  };
  fs.writeFileSync(path.join(dir, "theme.json"), JSON.stringify(theme), "utf8");
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "assets", "idle.svg"), `<svg viewBox="0 0 100 100">${svg}</svg>`, "utf8");
  return dir;
}

function runValidateTheme(dir) {
  return spawnSync(process.execPath, [SCRIPT_PATH, dir], { cwd: REPO_ROOT, encoding: "utf8" });
}

// The summary line is either `<n> error(s)[, <m> warning(s)]` or, with none,
// `Passed [with <m> warning(s)]` / `All checks passed!`. Read the count rather
// than a glyph: it tracks what the validator DID, not how it painted it.
function errorCount(stdout) {
  const m = stdout.match(/(\d+) error\(s\)/);
  if (m) return Number(m[1]);
  assert.match(stdout, /Passed|All checks passed/, `no error summary in:\n${stdout}`);
  return 0;
}

describe("validate-theme.js aim layers", () => {
  it("passes a well-formed rotate + foreshorten pair", () => {
    const result = runValidateTheme(writeFixture({ trackingLayers: { turret: TURRET, yaw: YAW } }));
    assert.strictEqual(result.status, 0, result.stdout);
    assert.strictEqual(errorCount(result.stdout), 0);
    assert.match(result.stdout, /turret \(mode "rotate"\) targets an element that exists in this SVG/);
    assert.match(result.stdout, /turret\.pivot \[50, 50\] is inside the viewBox/);
    assert.match(result.stdout, /turret minAngle \(-15\) <= 0 <= maxAngle \(8\)/);
    assert.match(result.stdout, /yaw\.maxAngle must be > 0 \(mode "foreshorten"\)/);
  });

  it("fails when the rotate layer's pivot is outside the viewBox", () => {
    const dir = writeFixture({ trackingLayers: { turret: { ...TURRET, pivot: [140, 50] } } });
    const result = runValidateTheme(dir);
    assert.strictEqual(result.status, 1);
    assert.strictEqual(errorCount(result.stdout), 1);
    assert.match(result.stdout, /turret\.pivot \[140, 50\] is inside the viewBox \[0, 0, 100, 100\]/);
  });

  it("fails when the aim layer targets an element the SVG does not have", () => {
    const dir = writeFixture({
      trackingLayers: { turret: { ...TURRET, ids: ["aim-barrel"] } },
      svg: '<g id="aim-turret"></g>',
    });
    const result = runValidateTheme(dir);
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /turret \(mode "rotate"\) targets an element that exists in this SVG/);
  });

  it("fails when the rotation limits cannot reach the rest angle", () => {
    const dir = writeFixture({ trackingLayers: { turret: { ...TURRET, minAngle: 2, maxAngle: 8 } } });
    const result = runValidateTheme(dir);
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /turret minAngle \(2\) <= 0 <= maxAngle \(8\)/);
  });

  it("fails when a foreshorten layer has no positive yaw range", () => {
    const dir = writeFixture({ trackingLayers: { yaw: { ...YAW, maxAngle: 0 } } });
    const result = runValidateTheme(dir);
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /yaw\.maxAngle must be > 0 \(mode "foreshorten"\)/);
  });

  it("only warns when aimOrigin sits outside the viewBox", () => {
    const dir = writeFixture({ trackingLayers: { turret: { ...TURRET, aimOrigin: [120, 40] } } });
    const result = runValidateTheme(dir);
    assert.strictEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /turret\.aimOrigin \[120, 40\] is outside the viewBox/);
    assert.match(result.stdout, /Passed.*warning\(s\)/);
  });

  it("leaves translate-only layers exactly as they were", () => {
    const result = runValidateTheme(writeFixture({
      trackingLayers: { eyes: { ids: ["aim-turret"], maxOffset: 20, ease: 0.2 } },
    }));
    assert.strictEqual(result.status, 0, result.stdout);
    assert.doesNotMatch(result.stdout, /mode "rotate"/);
  });
});
