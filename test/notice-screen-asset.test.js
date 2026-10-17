"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const layout = require("../src/notice-screen-layout");

const ROOT = path.join(__dirname, "..");
const SOURCE = path.join(ROOT, "assets", "source", "clawd-notice-screen", "clawd-notice-screen.svg");
const RUNTIME = path.join(ROOT, "assets", "svg", "clawd-notice-screen.svg");
// Same audit as test/outlaw-bender-asset.test.js: built-in SVGs skip the
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

function read(file) {
  return `${fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").trimEnd()}\n`;
}

test("builtin notice sign ships the reviewed source unchanged", () => {
  assert.strictEqual(read(RUNTIME), read(SOURCE));
});

test("builtin notice sign has no active, linked, or externally loaded SVG content", () => {
  const markup = fs.readFileSync(RUNTIME, "utf8");
  for (const pattern of FORBIDDEN) {
    assert.doesNotMatch(markup, pattern, String(pattern));
  }
});

test("notice sign keeps the shared viewBox and the board the layout module describes", () => {
  const markup = read(RUNTIME);
  assert.match(markup, /<svg [^>]*viewBox="-15 -25 45 45"/);
  // The wooden frame is the board rect the layout module hit-tests and zooms.
  const r = layout.SCREEN_RECT;
  assert.ok(markup.includes(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="#8B5A2B" rx="0.3"/>`));
  assert.deepStrictEqual({ ...r }, { x: 4.6, y: -9, w: 20, h: 9.6 });
  // The stick sits under the board, right of the body; each hand covers it
  // where it ends up (the left hand once a toss moved it LEFT_HAND_DX over).
  assert.ok(markup.includes('<rect x="14.2" y="0" width="0.8" height="5" fill="#9C6B3C"/>'));
  const hand = (id) => {
    const m = markup.match(new RegExp(`<rect id="${id}" x="(-?[0-9.]+)" y="4" width="2\\.2" height="1\\.6"`));
    assert.ok(m, id);
    return { from: Number(m[1]), to: Number(m[1]) + 2.2 };
  };
  const stickCentre = 14.2 + 0.4;
  for (const [id, centre] of [["notice-hand-right", stickCentre], ["notice-hand-left", stickCentre + layout.LEFT_HAND_DX]]) {
    const span = hand(id);
    assert.ok(span.from < centre && centre < span.to, `${id} holds the stick`);
  }
});

test("notice sign exposes the hooks the renderer drives, drawn above the body", () => {
  const markup = read(RUNTIME);
  for (const id of [
    "notice-sign-car", "notice-screen-zoom", "notice-viewport", "notice-line", "notice-chalk",
    "notice-arms-right", "notice-arms-left", "notice-hand-right", "notice-hand-left", "accessory-anchor",
  ]) {
    assert.ok(markup.includes(`id="${id}"`), id);
  }
  // The text viewport clips to the slate without url(): a nested <svg> whose
  // viewBox equals its viewport. The line fits inside it.
  assert.match(
    markup,
    /<svg id="notice-viewport" x="5\.4" y="-8\.2" width="18\.4" height="8" viewBox="5\.4 -8\.2 18\.4 8" overflow="hidden">/
  );
  assert.ok(layout.LINE_START_X > 5.4 && layout.LINE_END_X < 5.4 + 18.4);
  // The zoom group rides on the carrier, so a toss moves the zoomed board too.
  assert.ok(markup.indexOf('id="notice-sign-car"') < markup.indexOf('id="notice-screen-zoom"'));
  assert.ok(markup.indexOf('id="accessory-anchor"') < markup.indexOf('id="notice-sign-car"'),
    "the board must paint over the body");
  // Only the right hand holds the sign to begin with.
  assert.match(markup, /<g id="notice-arms-left" fill="#DE886D" visibility="hidden">/);
  assert.match(markup, /<rect id="notice-hand-left" [^>]*visibility="hidden"\/>/);
  // Eyes look up: pupils at y 7 with the dark cap on top.
  assert.ok(markup.includes('<rect x="4" y="7" width="1" height="2" fill="#000"/>'));
  assert.ok(markup.includes('<rect x="10" y="7" width="1" height="0.6" fill="#5A3022"/>'));
  // The entrance and the breath honour reduced motion in the asset itself.
  assert.match(markup, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.breathe, \.shadow-anim, \.sign-rise \{ animation: none; \}/);
});
