"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const S = require("../src/stretch-session");
const { POSE_LIMITS } = require("../src/notice-pose");

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, set: (v) => { t = v; } };
}

function session(c = clock()) {
  return { c, s: S.createStretchSession({ group: S.resolveGroup("B"), now: c.now }) };
}

// Runs the clock to the start of the first segment matching `match`.
function goTo(c, s, match) {
  for (let guard = 0; guard < 200 && s.status === "running"; guard++) {
    const seg = s.snapshot().segment;
    if (match(seg)) return seg;
    c.advance(s.msUntilNextSegment());
    s.tick();
  }
  throw new Error("segment not reached");
}

describe("stretch groups", () => {
  it("offers only group B for now, and every group has the same shape", () => {
    assert.deepEqual(S.ENABLED_GROUP_IDS, ["B"]);
    assert.deepEqual(S.enabledGroups().map((g) => g.id), ["B"]);
    assert.deepEqual(S.GROUPS.map((g) => g.id), ["A", "B", "C"]);
    for (const group of S.GROUPS) {
      assert.ok(group.name.zh, group.id);
      for (const move of group.moves) {
        assert.ok(["front", "side"].includes(move.view), move.id);
        assert.ok(["B", "RL"].includes(move.sides), move.id);
        assert.ok(Number.isInteger(move.hold) && move.hold > 0, move.id);
        assert.ok(move.frames.length > 0 && move.frames.length <= POSE_LIMITS.frames, move.id);
        assert.ok(move.hint.zh, move.id);
      }
    }
  });

  it("falls back to group B for an unknown or not-yet-enabled group", () => {
    assert.equal(S.resolveGroup("A").id, "B");
    assert.equal(S.resolveGroup("nope").id, "B");
    assert.equal(S.resolveGroup("B").id, "B");
  });

  it("has English text for every enabled move, and keeps the back-bend warning", () => {
    for (const group of S.enabledGroups()) {
      assert.ok(group.name.en);
      for (const move of group.moves) {
        assert.ok(move.name.en && move.hint.en, move.id);
        for (const frame of move.frames) if (frame.cue) assert.ok(frame.cue.en, move.id);
      }
    }
    const back = S.getGroup("B").moves.find((m) => m.id === "B6");
    assert.match(back.hint.zh, /腰不舒服就跳过/);
    assert.match(back.hint.en, /skip this one/);
  });
});

describe("stretch variants", () => {
  const sideBend = S.getGroup("B").moves.find((m) => m.id === "B2");

  it("fills the side words and tags each side", () => {
    const r = S.variantOf(sideBend, "R", "zh");
    const l = S.variantOf(sideBend, "L", "zh");
    assert.match(r.hint, /^左手举过头顶，身体慢慢往右边弯/);
    assert.match(l.hint, /^右手举过头顶，身体慢慢往左边弯/);
    assert.equal(r.tag, "右侧");
    assert.equal(l.tag, "左侧");
    assert.equal(S.variantOf(sideBend, "R", "en").tag, "right");
    assert.equal(S.variantOf(S.getGroup("B").moves[0], "B", "zh").tag, "");
  });

  it("mirrors a front-view move for the left side", () => {
    const r = S.variantOf(sideBend, "R", "zh").hold.frames[1].pose;
    const l = S.variantOf(sideBend, "L", "zh").hold.frames[1].pose;
    assert.equal(l.torso, -r.torso);
    assert.deepEqual(l.arms.l, r.arms.r);
    assert.deepEqual(l.arms.r, r.arms.l);
  });

  it("enters from the resting pose and exits back to it", () => {
    const v = S.variantOf(sideBend, "R", "zh");
    assert.equal(v.enter.frames[0].pose.torso, 0);
    assert.equal(v.enter.frames[1].pose.torso, v.hold.frames[0].pose.torso);
    assert.equal(v.exit.frames[1].pose.torso, 0);
  });

  it("walks the hold loop's cues and breath in step with the figure", () => {
    const v = S.variantOf(sideBend, "R", "zh");
    // Frames: 3 s → frame 0 (in), 3 s → frame 1 (out). Moving into frame 1 first.
    const early = S.holdState(v, 1000);
    assert.equal(early.frame, 1);
    assert.equal(early.br, "out");
    assert.match(early.cue, /呼气 · 再往右弯一点/);
    const later = S.holdState(v, 4000);
    assert.equal(later.frame, 0);
    assert.equal(later.br, "in");
    assert.ok(later.k > 0.3 && later.k < 0.4);
    assert.equal(later.half, 0);
    assert.equal(S.holdState(v, 7000).half, 1);
  });
});

describe("stretch plan", () => {
  it("counts down, then enter / hold / exit per side, with a gap between moves", () => {
    const group = S.getGroup("B");
    const plan = S.buildPlan(group);
    assert.equal(plan[0].type, "count");
    assert.equal(plan.filter((s) => s.type === "gap").length, group.moves.length - 1);
    const holds = plan.filter((s) => s.type === "hold");
    const sides = group.moves.reduce((n, m) => n + (m.sides === "RL" ? 2 : 1), 0);
    assert.equal(holds.length, sides);
    const switches = plan.filter((s) => s.type === "exit" && s.switching);
    assert.equal(switches.length, group.moves.filter((m) => m.sides === "RL").length);
    assert.equal(S.planMs(group), plan.reduce((t, s) => t + s.ms, 0));
    assert.ok(S.planMs(group) > 100_000 && S.planMs(group) < 180_000, "about two minutes");
  });
});

describe("stretch session engine", () => {
  it("runs the whole plan to done, every move done", () => {
    const { c, s } = session();
    let changes = 0;
    while (s.status === "running") {
      c.advance(s.msUntilNextSegment());
      if (s.tick()) changes += 1;
    }
    assert.equal(s.status, "done");
    const snap = s.snapshot();
    assert.deepEqual(snap.done, [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(snap.skipped, []);
    assert.equal(snap.activeMs, S.planMs(s.group));
    assert.equal(changes, s.plan.length);
  });

  it("catches up several segments in one late tick", () => {
    const { c, s } = session();
    c.advance(S.COUNT_MS + S.ENTER_MS + 100);
    assert.equal(s.tick(), true);
    assert.equal(s.snapshot().segment.type, "hold");
    assert.equal(s.snapshot().elapsed, 100);
  });

  it("pause freezes the clock and resume picks up where it stopped", () => {
    const { c, s } = session();
    goTo(c, s, (seg) => seg.type === "hold");
    c.advance(4000);
    assert.equal(s.pause(), true);
    assert.equal(s.msUntilNextSegment(), null);
    c.advance(60_000);
    assert.equal(s.tick(), false);
    assert.equal(s.snapshot().elapsed, 4000);
    assert.equal(s.snapshot().paused, true);
    assert.equal(s.resume(), true);
    assert.equal(s.msUntilNextSegment(), 15_000 - 4000);
    assert.equal(s.togglePause(), true);
    assert.equal(s.paused, true);
  });

  it("does not count paused time as active time", () => {
    const { c, s } = session();
    c.advance(1000);
    s.pause();
    c.advance(50_000);
    s.resume();
    c.advance(1000);
    assert.equal(s.snapshot().activeMs, 2000);
  });

  it("skip in a move drops the whole move (both sides) and lands on the next gap", () => {
    const { c, s } = session();
    goTo(c, s, (seg) => seg.type === "hold" && seg.mi === 1 && seg.sd === "R");
    assert.equal(s.skip(), true);
    const snap = s.snapshot();
    assert.equal(snap.segment.type, "gap");
    assert.equal(snap.segment.mi, 2);
    assert.deepEqual(snap.skipped, [1]);
    assert.deepEqual(snap.done, [0]);
  });

  it("skip during the countdown or a gap only cuts it short", () => {
    const { c, s } = session();
    s.skip();
    assert.equal(s.snapshot().segment.type, "enter");
    assert.deepEqual(s.snapshot().skipped, []);
    goTo(c, s, (seg) => seg.type === "gap");
    s.skip();
    assert.equal(s.snapshot().segment.type, "enter");
    assert.deepEqual(s.snapshot().skipped, []);
  });

  it("skipping the last move ends the session early", () => {
    const { c, s } = session();
    goTo(c, s, (seg) => seg.type === "hold" && seg.mi === 5);
    s.skip();
    assert.equal(s.status, "early");
    assert.deepEqual(s.snapshot().skipped, [5]);
  });

  it("skip while paused resumes the clock", () => {
    const { c, s } = session();
    goTo(c, s, (seg) => seg.type === "hold");
    s.pause();
    s.skip();
    assert.equal(s.paused, false);
    assert.notEqual(s.msUntilNextSegment(), null);
  });

  it("end stops early and nothing moves after it", () => {
    const { c, s } = session();
    goTo(c, s, (seg) => seg.type === "hold" && seg.mi === 2);
    assert.equal(s.end(), true);
    assert.equal(s.status, "early");
    assert.deepEqual(s.snapshot().done, [0, 1]);
    assert.equal(s.end(), false);
    assert.equal(s.skip(), false);
    assert.equal(s.pause(), false);
    assert.equal(s.msUntilNextSegment(), null);
    c.advance(100_000);
    assert.equal(s.tick(), false);
  });
});

describe("stretch cards", () => {
  it("invite: three choices, the safety note, × means later", () => {
    const card = S.buildInviteCard({ lang: "zh" });
    assert.equal(card.phase, "invite");
    assert.equal(card.title, "该拉伸了？");
    assert.deepEqual(card.buttons.map((b) => b.action), ["start", "later", "skipToday"]);
    assert.equal(card.dismiss, "later");
    assert.match(card.note, /不舒服就停下/);
    assert.ok(card.board.anim.frames.length > 1);
  });

  it("run: progress, side tag, controls, × means end", () => {
    const { c, s } = session();
    goTo(c, s, (seg) => seg.type === "hold" && seg.mi === 1 && seg.sd === "L");
    const card = S.buildRunCard(s, "zh");
    assert.equal(card.title, "侧弯 · 左侧");
    assert.equal(card.count, "第 2 / 6 个");
    assert.deepEqual(card.buttons.map((b) => b.action), ["pause", "skip", "end"]);
    assert.equal(card.dismiss, "end");
    assert.equal(card.board.type, "hold");
    assert.equal(card.board.step, "2 / 6");
    assert.equal(card.board.ms, 12_000);
    assert.equal(card.board.cues.length, 2);
    assert.deepEqual(card.pills, { n: 6, now: 1, done: [0], skipped: [] });
    assert.deepEqual(card.breath, { in: "吸气", out: "呼气", hold: "停" });
  });

  it("run: paused swaps the controls and the board message", () => {
    const { c, s } = session();
    goTo(c, s, (seg) => seg.type === "hold");
    s.pause();
    const card = S.buildRunCard(s, "zh");
    assert.equal(card.buttons[0].action, "resume");
    assert.equal(card.board.paused, true);
    assert.equal(card.board.msg.big, "暂停中");
    assert.equal(card.cue, "已暂停，豆豆等你");
  });

  it("run: the countdown, a gap and a side switch say what comes next", () => {
    const { c, s } = session();
    let card = S.buildRunCard(s, "zh");
    assert.equal(card.board.type, "still");
    assert.equal(card.board.countdown, 3);
    assert.match(card.board.msg.sub, /向上伸展/);
    goTo(c, s, (seg) => seg.type === "exit" && seg.switching);
    card = S.buildRunCard(s, "zh");
    assert.equal(card.board.msg.big, "换边");
    assert.match(card.board.msg.sub, /左侧/);
    goTo(c, s, (seg) => seg.type === "gap");
    card = S.buildRunCard(s, "zh");
    assert.match(card.title, /^下一个：/);
  });

  it("the back-bend card carries the 'skip it if your back complains' line", () => {
    const { c, s } = session();
    goTo(c, s, (seg) => seg.type === "hold" && seg.mi === 5);
    assert.match(S.buildRunCard(s, "zh").body, /腰不舒服就跳过这个/);
  });

  it("finish: done says 做完啦, early says how many were done", () => {
    const { c, s } = session();
    while (s.status === "running") { c.advance(s.msUntilNextSegment()); s.tick(); }
    const done = S.buildFinishCard(s, "zh", { nextMinutes: 45 });
    assert.equal(done.phase, "done");
    assert.equal(done.level, "success");
    assert.equal(done.title, "做完啦！");
    assert.match(done.body, /45 分钟后/);

    const b = session();
    goTo(b.c, b.s, (seg) => seg.type === "hold" && seg.mi === 2);
    b.s.end();
    const early = S.buildFinishCard(b.s, "zh");
    assert.equal(early.phase, "early");
    assert.equal(early.title, "先到这儿 · 做了 2 / 6 个");
    assert.deepEqual(early.buttons.map((x) => x.action), ["ok"]);
  });

  it("speaks English outside Chinese, and zh-TW reads the Chinese text", () => {
    assert.equal(S.buildInviteCard({ lang: "en" }).title, "Time to stretch?");
    assert.equal(S.buildInviteCard({ lang: "ja" }).title, "Time to stretch?");
    assert.equal(S.buildInviteCard({ lang: "zh-TW" }).title, "该拉伸了？");
  });

  it("whitelists the card actions", () => {
    for (const a of ["start", "later", "skipToday", "pause", "resume", "skip", "end", "ok"]) assert.equal(S.isStretchAction(a), true);
    for (const a of ["", "eval", null, 3, "START"]) assert.equal(S.isStretchAction(a), false);
  });
});
