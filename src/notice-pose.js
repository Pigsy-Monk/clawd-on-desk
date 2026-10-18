"use strict";

// The animation an agent can attach to a notice (`pose`): a little figure on
// the card acts something out — "wave hello", "bow", "jump for joy".
//
// The agent writes keyframes as joint angles, listing only what changes from
// the frame before. This module is the one validator: it clamps every number,
// drops what it does not know, and expands each frame into a complete pose
// (carrying the previous frame forward), so the card only has to interpolate.
// Nothing here is executed or used as markup; it is numbers and a few enums.
//
// Angles are degrees in the figure's own frame. Arms and legs are [upper,
// lower] segments: 0 hangs straight down, 90 points out to the side, 180 is
// straight up. torso/head lean (positive = to the right, or forward in a side
// view). root moves the whole figure (dy < 0 is up) and rot turns it about its
// feet.

const POSE_EXPRESSIONS = Object.freeze(["smile", "happy", "surprised", "wink", "sad", "closed"]);
const POSE_PROPS = Object.freeze(["heart", "question", "exclaim", "sweat", "note", "star", "zzz"]);
const POSE_LIMITS = Object.freeze({
  frames: 24,
  totalMs: 20000,
  frameMsMin: 80,
  frameMsMax: 8000,
  defaultFrameMs: 600,
  holdMax: 5000,
  defaultHold: 1200,
  limb: 270,
  torso: 90,
  head: 60,
  lift: 1.5,
  dx: 6,
  dy: 4,
  rot: 100,
});

const REST = Object.freeze({
  front: { torso: 0, head: 0, lift: 0, arms: { l: [18, 10], r: [18, 10] }, legs: { l: [4, 0], r: [4, 0] },
    root: { dx: 0, dy: 0, rot: 0 }, face: "smile", prop: null },
  side: { torso: 0, head: 0, lift: 0, arms: { l: [8, 4], r: [-6, 0] }, legs: { l: [-4, 0], r: [4, 0] },
    root: { dx: 0, dy: 0, rot: 0 }, face: "smile", prop: null },
});

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value, limit, fallback) {
  if (!isNumber(value)) return fallback;
  return Math.max(-limit, Math.min(limit, value));
}

function clone(pose) {
  return {
    torso: pose.torso,
    head: pose.head,
    lift: pose.lift,
    arms: { l: pose.arms.l.slice(), r: pose.arms.r.slice() },
    legs: { l: pose.legs.l.slice(), r: pose.legs.r.slice() },
    root: { ...pose.root },
    face: pose.face,
    prop: pose.prop,
  };
}

function freezePose(pose) {
  return Object.freeze({
    ...pose,
    arms: Object.freeze({ l: Object.freeze(pose.arms.l), r: Object.freeze(pose.arms.r) }),
    legs: Object.freeze({ l: Object.freeze(pose.legs.l), r: Object.freeze(pose.legs.r) }),
    root: Object.freeze(pose.root),
  });
}

function applyFrame(prev, raw) {
  const pose = clone(prev);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return pose;
  pose.torso = clamp(raw.torso, POSE_LIMITS.torso, pose.torso);
  pose.head = clamp(raw.head, POSE_LIMITS.head, pose.head);
  if (isNumber(raw.lift)) pose.lift = Math.max(0, Math.min(POSE_LIMITS.lift, raw.lift));
  for (const group of ["arms", "legs"]) {
    const value = raw[group];
    if (!value || typeof value !== "object") continue;
    for (const side of ["l", "r"]) {
      const pair = value[side];
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      pose[group][side] = pair.map((angle, i) => clamp(angle, POSE_LIMITS.limb, pose[group][side][i]));
    }
  }
  if (raw.root && typeof raw.root === "object") {
    for (const key of ["dx", "dy", "rot"]) pose.root[key] = clamp(raw.root[key], POSE_LIMITS[key], pose.root[key]);
  }
  if (POSE_EXPRESSIONS.includes(raw.face)) pose.face = raw.face;
  if (raw.prop === null || POSE_PROPS.includes(raw.prop)) pose.prop = raw.prop;
  return pose;
}

// The animation, normalized and frozen, or null when there is nothing to play
// (no frames). Frames past the frame cap or the total-time cap are dropped.
function normalizePose(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!Array.isArray(raw.frames) || raw.frames.length === 0) return null;
  const view = raw.view === "side" ? "side" : "front";
  const frames = [];
  let prev = REST[view];
  let total = 0;
  for (const rawFrame of raw.frames.slice(0, POSE_LIMITS.frames)) {
    const requested = rawFrame && isNumber(rawFrame.ms) ? rawFrame.ms : POSE_LIMITS.defaultFrameMs;
    const ms = Math.round(Math.max(POSE_LIMITS.frameMsMin, Math.min(POSE_LIMITS.frameMsMax, requested)));
    if (frames.length > 0 && total + ms > POSE_LIMITS.totalMs) break;
    total += ms;
    const pose = applyFrame(prev, rawFrame);
    frames.push(Object.freeze({ ms, pose: freezePose(pose) }));
    prev = pose;
  }
  const hold = isNumber(raw.hold)
    ? Math.round(Math.max(0, Math.min(POSE_LIMITS.holdMax, raw.hold)))
    : POSE_LIMITS.defaultHold;
  return Object.freeze({
    view,
    facing: raw.facing === "left" ? "left" : "right",
    loop: raw.loop === true,
    hold,
    frames: Object.freeze(frames),
  });
}

module.exports = {
  POSE_EXPRESSIONS,
  POSE_PROPS,
  POSE_LIMITS,
  normalizePose,
};
