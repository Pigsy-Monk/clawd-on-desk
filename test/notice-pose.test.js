"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { normalizePose, POSE_LIMITS, POSE_EXPRESSIONS, POSE_PROPS } = require("../src/notice-pose");
const { createNoticeStore } = require("../src/notice-store");

describe("notice pose: normalization", () => {
  it("expands each frame into a complete pose, carrying the last one forward", () => {
    const anim = normalizePose({
      frames: [
        { ms: 400, arms: { r: [150, 165] } },
        { ms: 300, face: "happy" },
        { arms: { r: [18, 10] }, prop: "heart" },
      ],
    });
    assert.equal(anim.view, "front");
    assert.equal(anim.facing, "right");
    assert.equal(anim.loop, false);
    assert.equal(anim.hold, POSE_LIMITS.defaultHold);
    assert.equal(anim.frames.length, 3);
    const [a, b, c] = anim.frames.map((f) => f.pose);
    assert.deepEqual(a.arms.r, [150, 165]);
    assert.deepEqual(a.arms.l, [18, 10], "untouched limbs start at rest");
    assert.equal(a.face, "smile");
    assert.deepEqual(b.arms.r, [150, 165], "carried forward");
    assert.equal(b.face, "happy");
    assert.deepEqual(c.arms.r, [18, 10]);
    assert.equal(c.face, "happy");
    assert.equal(c.prop, "heart");
    assert.equal(anim.frames[2].ms, POSE_LIMITS.defaultFrameMs);
  });

  it("starts a side view from the side rest pose and keeps facing and loop", () => {
    const anim = normalizePose({ view: "side", facing: "left", loop: true, hold: 99999, frames: [{ torso: 55 }] });
    assert.equal(anim.view, "side");
    assert.equal(anim.facing, "left");
    assert.equal(anim.loop, true);
    assert.equal(anim.hold, POSE_LIMITS.holdMax);
    assert.deepEqual(anim.frames[0].pose.arms.r, [-6, 0]);
    assert.equal(anim.frames[0].pose.torso, 55);
  });

  it("clamps every number and ignores what it does not know", () => {
    const anim = normalizePose({
      view: "upside-down",
      frames: [{
        ms: 1, torso: 500, head: -500, lift: 9,
        arms: { l: [999, "x"], r: [1, 2, 3] }, legs: { l: [NaN, 20] },
        root: { dx: 100, dy: -100, rot: 1e9 },
        face: "evil", prop: "<script>", extra: "ignored",
      }],
    });
    const p = anim.frames[0].pose;
    assert.equal(anim.view, "front");
    assert.equal(anim.frames[0].ms, POSE_LIMITS.frameMsMin);
    assert.equal(p.torso, POSE_LIMITS.torso);
    assert.equal(p.head, -POSE_LIMITS.head);
    assert.equal(p.lift, POSE_LIMITS.lift);
    assert.deepEqual(p.arms.l, [POSE_LIMITS.limb, 10], "a non-number keeps the previous value");
    assert.deepEqual(p.arms.r, [18, 10], "a pair of the wrong length is ignored");
    assert.deepEqual(p.legs.l, [4, 20]);
    assert.deepEqual(p.root, { dx: POSE_LIMITS.dx, dy: -POSE_LIMITS.dy, rot: POSE_LIMITS.rot });
    assert.equal(p.face, "smile");
    assert.equal(p.prop, null);
    assert.equal("extra" in p, false);
  });

  it("keeps at most the frame cap and the total-time cap", () => {
    const many = normalizePose({ frames: Array.from({ length: 40 }, () => ({ ms: 100 })) });
    assert.equal(many.frames.length, POSE_LIMITS.frames);
    const long = normalizePose({ frames: Array.from({ length: 10 }, () => ({ ms: 6000 })) });
    const total = long.frames.reduce((n, f) => n + f.ms, 0);
    assert.ok(total <= POSE_LIMITS.totalMs, String(total));
    assert.equal(long.frames.length, 3);
  });

  it("returns null when there is nothing to play, and freezes what it returns", () => {
    for (const bad of [null, "wave", [], {}, { frames: [] }, { frames: "x" }]) {
      assert.equal(normalizePose(bad), null, JSON.stringify(bad));
    }
    const anim = normalizePose({ frames: [{}] });
    assert.ok(Object.isFrozen(anim) && Object.isFrozen(anim.frames) && Object.isFrozen(anim.frames[0].pose));
    assert.ok(Object.isFrozen(anim.frames[0].pose.arms.l));
    assert.ok(POSE_EXPRESSIONS.includes("happy") && POSE_PROPS.includes("heart"));
  });
});

describe("notice pose: the store", () => {
  it("makes a pose card from a notice that carries one", () => {
    const store = createNoticeStore();
    const { notice } = store.add({ title: "你好呀", pose: { loop: true, frames: [{ arms: { r: [150, 165] } }] } });
    assert.equal(notice.kind, "pose");
    assert.equal(notice.pose.loop, true);
    assert.deepEqual(notice.pose.frames[0].pose.arms.r, [150, 165]);
    store.dispose();
  });

  it("accepts a pose with no text, and drops an unusable one", () => {
    const store = createNoticeStore();
    assert.equal(store.add({ pose: { frames: [{}] } }).notice.kind, "pose");
    assert.equal(store.add({ pose: { frames: [] } }), null, "nothing to show at all");
    const plain = store.add({ title: "x", pose: "wave" }).notice;
    assert.equal(plain.kind, "text");
    assert.equal(plain.pose, null);
    store.dispose();
  });

  it("lets a chart win over a pose: series make a trend card", () => {
    const store = createNoticeStore();
    const { notice } = store.add({ title: "x", series: [{ name: "cpu", points: [1, 2] }], pose: { frames: [{}] } });
    assert.equal(notice.kind, "trend");
    assert.equal(notice.pose, null);
    store.dispose();
  });
});
