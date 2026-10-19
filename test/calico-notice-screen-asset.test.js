"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const layout = require("../src/notice-screen-layout");

const ROOT = path.join(__dirname, "..");
const ASSETS = path.join(ROOT, "themes", "calico", "assets");
const FILE = "calico-notice-screen.svg";
const theme = JSON.parse(fs.readFileSync(path.join(ROOT, "themes", "calico", "theme.json"), "utf8"));
const markup = fs.readFileSync(path.join(ASSETS, FILE), "utf8");

// Same audit as test/notice-screen-asset.test.js: built-in SVGs skip the
// runtime sanitizer, so the repository proves them inert here.
const FORBIDDEN = [
  /<script\b/i,
  /<foreignObject\b/i,
  /<image\b/i,
  /<use\b/i,
  /\bhref\s*=/i,
  /url\s*\(/i,
  /\bdata\s*:/i,
  /\bon\w+\s*=/i,
  /<!DOCTYPE\b/i,
  /<!ENTITY\b/i,
];

const viewBoxOf = (svg) => svg.match(/<svg\b[^>]*\bviewBox="([^"]+)"/)[1].split(/\s+/).map(Number);

test("calico's notice sign has no active, linked, or externally loaded SVG content", () => {
  for (const pattern of FORBIDDEN) {
    assert.doesNotMatch(markup, pattern, String(pattern));
  }
});

test("calico's notice sign is a scriptable reaction with its own board", () => {
  const entry = theme.reactions["notice-screen"];
  assert.strictEqual(entry.file, FILE);
  assert.ok(theme.rendering.objectChannelFiles.includes(FILE), "the renderer needs its document");
  const sign = layout.resolveSign(entry.sign);
  assert.notStrictEqual(sign, layout.DEFAULT_SIGN, "the sign config is valid");
  for (const id of ["notice-screen-zoom", "notice-line", "notice-chalk", "notice-level-glyph"]) {
    assert.strictEqual(markup.split(`id="${id}"`).length - 1, 1, id);
  }
  // The board stays where it is: no carrier, arms or hands to toss it with.
  for (const id of ["notice-sign-car", "notice-arms-left", "notice-hand-left"]) {
    assert.ok(!markup.includes(`id="${id}"`), id);
  }
  // The bubble is drawn after the cat, so it stays on top while zoomed.
  assert.ok(markup.indexOf('id="eye-sockets"') < markup.indexOf('id="notice-screen-zoom"'));
});

test("calico's notice sign shares the theme's units and the idle cat's placement", () => {
  const vb = theme.fileViewBoxes[FILE];
  assert.deepStrictEqual(viewBoxOf(markup), [vb.x, vb.y, vb.width, vb.height]);
  // The cat canvas is the theme's own 266x200, at the origin.
  assert.match(markup, /<svg x="0" y="0" width="266" height="200" viewBox="0 0 1536 1152" overflow="visible">/);
  assert.deepStrictEqual([theme.viewBox.width, theme.viewBox.height], [266, 200]);
  // Shown at the idle sprite's scale and offset, so the cat does not jump
  // when the bubble comes up.
  const os = theme.objectScale;
  assert.strictEqual(os.fileScales[FILE], os.fileScales["calico-idle-follow.svg"]);
  assert.deepStrictEqual(os.fileOffsets[FILE], os.fileOffsets["calico-idle-follow.svg"]);
});

test("calico's notice line is clipped to exactly the room the sign declares", () => {
  const sign = layout.resolveSign(theme.reactions["notice-screen"].sign);
  const m = markup.match(/<svg id="notice-viewport" x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)" viewBox="([^"]+)" overflow="hidden">/);
  assert.ok(m, "the line viewport");
  const [x, y, w, h] = m.slice(1, 5).map(Number);
  assert.deepStrictEqual(m[5].split(" ").map(Number), [x, y, w, h], "child coordinates stay absolute");
  assert.ok(x <= sign.line.startX && sign.line.endX <= x + w, "the text room is inside the clip");
  assert.ok(y < sign.line.baselineY && sign.line.baselineY < y + h, "the baseline is inside the clip");
  // The clip sits on the bubble.
  assert.ok(x >= sign.screen.x && x + w <= sign.screen.x + sign.screen.w);
  assert.ok(y >= sign.screen.y && y + h <= sign.screen.y + sign.screen.h);
});

test("calico's notice cat is the idle cat, path for path", () => {
  const idle = fs.readFileSync(path.join(ASSETS, "calico-idle-follow.svg"), "utf8");
  const paths = (svg) => svg.match(/\bd="[^"]+"/g);
  const idlePaths = paths(idle);
  const signPaths = paths(markup);
  assert.ok(idlePaths.length > 20);
  for (const d of idlePaths) assert.ok(signPaths.includes(d), d.slice(0, 40));
});

test("calico's notice sign stops moving under reduced motion", () => {
  assert.match(markup, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.notice-pop, \.notice-ear-twitch, \.breathe, \.tail-sway,/);
});
