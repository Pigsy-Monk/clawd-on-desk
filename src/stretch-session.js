"use strict";

// Guided stretch breaks: the moves, the timeline and the cards.
//
// A break is one *group* of moves the user follows along with the bean figure
// on the card's chalkboard (the same figure pose cards use, src/notice-pose.js
// normalizes every animation here too). Main owns the clock — this module's
// session engine says which segment of the timeline is running, how far in it
// is, what was done and what was skipped — and the card only interpolates the
// figure between the transitions main sends it.
//
// Only group B (back) is offered for now. Groups A (neck & shoulders) and C
// (wrists & ankles) are written in the same shape and switched on by adding
// their id to ENABLED_GROUP_IDS (plus their English text); nothing else needs
// to change.
//
// Angles follow notice-pose.js. Every move is written for the *right* side —
// the bean faces the user like a mirror, so the user's right hand is on the
// right of the board — and the left side is mirrored by code. Per-frame `cue`
// (the spoken line), `br` (breath: in | out | hold | none) and `hand` (open |
// fist) belong to the follow-along layer; the pose normalizer drops them.
// Text uses {S} for the side being worked and {O} for the other one.

const { normalizePose } = require("./notice-pose");

const ENTER_MS = 900;
const EXIT_MS = 700;
const COUNT_MS = 3000;
const GAP_MS = 1500;

const ENABLED_GROUP_IDS = Object.freeze(["B"]);
const DEFAULT_GROUP_ID = "B";

// zh is the written source; en is the fallback for every other UI language.
const GROUPS = Object.freeze([
  { id: "A", name: { zh: "肩颈放松" }, moves: [
    { id: "A1", name: { zh: "耸肩" }, view: "front", sides: "B", hold: 12,
      hint: { zh: "坐直或站直，吸气时肩膀慢慢往耳朵提，停一下，呼气时放松落下。" },
      marks: [{ type: "shrug" }],
      frames: [
        { ms: 1600, lift: 0, br: "out", cue: { zh: "呼气 · 肩膀放下来" } },
        { ms: 1800, lift: 1.2, br: "in", cue: { zh: "吸气 · 肩膀往耳朵提" } },
        { ms: 600, br: "hold", cue: { zh: "停一下" } }] },
    { id: "A2", name: { zh: "侧颈" }, view: "front", sides: "RL", hold: 15,
      hint: { zh: "头慢慢往{S}肩倒，耳朵找肩膀，{O}肩往下沉。不用手硬拉，也别绕圈转头。" },
      frames: [
        { ms: 4000, head: 30, arms: { l: [12, 6], r: [18, 10] }, face: "closed", br: "in", cue: { zh: "吸气 · 头稍微回来一点" } },
        { ms: 4000, head: 38, arms: { l: [8, 2] }, br: "out", cue: { zh: "呼气 · {O}肩往下沉" } }] },
    { id: "A3", name: { zh: "低头" }, view: "side", sides: "B", hold: 15,
      hint: { zh: "背挺直，下巴慢慢往胸口收，感觉后脖子被拉长；不用往下压。" },
      frames: [
        { ms: 4000, head: 30, face: "closed", br: "in", cue: { zh: "吸气 · 后背挺直" } },
        { ms: 4000, head: 40, br: "out", cue: { zh: "呼气 · 下巴往胸口收" } }] },
    { id: "A4", name: { zh: "交叉拉肩" }, view: "front", sides: "RL", hold: 15,
      hint: { zh: "{S}臂伸直横过胸前，{O}手扶住{S}上臂往身体带。肩膀别耸起来。" },
      frames: [
        { ms: 4000, arms: { r: [-78, -84], l: [20, -118] }, br: "in", cue: { zh: "吸气 · 肩膀放松" } },
        { ms: 4000, arms: { r: [-82, -88], l: [22, -122] }, br: "out", cue: { zh: "呼气 · {O}手把胳膊往胸口带" } }] },
    { id: "A5", name: { zh: "扩胸" }, view: "front", sides: "B", hold: 15,
      hint: { zh: "两只手抬到肩膀高、手肘弯成 W，手肘往后拉，肩胛骨往中间夹，胸口打开；别仰头。" },
      frames: [
        { ms: 4000, arms: { l: [78, 175], r: [78, 175] }, br: "in", cue: { zh: "吸气 · 胸口打开" } },
        { ms: 4000, arms: { l: [86, 168], r: [86, 168] }, br: "out", cue: { zh: "呼气 · 手肘再往后拉一点" } }] },
  ] },
  { id: "B", name: { zh: "腰背舒展", en: "Back stretch" }, moves: [
    { id: "B1", name: { zh: "向上伸展", en: "Reach up" }, view: "front", sides: "B", hold: 15,
      hint: { zh: "双手举过头顶往上够，像被人轻轻往上拎；肩膀放松别耸。",
        en: "Raise both hands overhead and reach up, as if lifted gently; keep your shoulders relaxed." },
      frames: [
        { ms: 4000, arms: { l: [155, 165], r: [155, 165] }, br: "in", cue: { zh: "吸气 · 双手往上够", en: "Breathe in · reach up" } },
        { ms: 4000, arms: { l: [148, 158], r: [148, 158] }, br: "out", cue: { zh: "呼气 · 肩膀放下来", en: "Breathe out · drop your shoulders" } }] },
    { id: "B2", name: { zh: "侧弯", en: "Side bend" }, view: "front", sides: "RL", hold: 12,
      hint: { zh: "{O}手举过头顶，身体慢慢往{S}边弯，另一只手扶腰；别往前倒，也别憋气。",
        en: "Raise your {O} hand overhead and bend slowly to the {S}, other hand on your waist; don't lean forward or hold your breath." },
      frames: [
        { ms: 3000, torso: 14, head: 4, arms: { l: [150, 175], r: [50, -45] }, br: "in", cue: { zh: "吸气 · 身体往上拉长", en: "Breathe in · grow tall" } },
        { ms: 3000, torso: 20, head: 6, br: "out", cue: { zh: "呼气 · 再往{S}弯一点", en: "Breathe out · bend a bit more to the {S}" } }] },
    { id: "B3", name: { zh: "转体", en: "Twist" }, view: "front", sides: "RL", hold: 12,
      hint: { zh: "骨盆朝前不动，上身慢慢往{S}后方转，眼睛跟着看过去；转到舒服就停。",
        en: "Keep your hips facing forward and turn your upper body to the {S}, eyes following; stop where it feels comfortable." },
      marks: [{ type: "twist", dir: 1 }],
      frames: [
        { ms: 3000, head: 6, arms: { r: [70, 95], l: [-60, -95] }, br: "in", cue: { zh: "吸气 · 坐高一点", en: "Breathe in · sit tall" } },
        { ms: 3000, head: 8, arms: { r: [74, 98], l: [-64, -98] }, br: "out", cue: { zh: "呼气 · 再往{S}转一点", en: "Breathe out · turn a bit more to the {S}" } }] },
    { id: "B4", name: { zh: "弓背推手", en: "Round and push" }, view: "side", sides: "B", hold: 12,
      hint: { zh: "十指交叉，掌心朝前往前推，低头，后背拱圆，像抱着一个大球。",
        en: "Interlace your fingers, push your palms forward, drop your head and round your back, like hugging a big ball." },
      frames: [
        { ms: 3000, torso: 8, head: 16, arms: { l: [84, 86], r: [84, 86] }, root: { dx: -0.3 }, br: "in", cue: { zh: "吸气 · 准备", en: "Breathe in · get ready" } },
        { ms: 3000, torso: 14, head: 24, arms: { l: [80, 82], r: [80, 82] }, face: "closed", br: "out", cue: { zh: "呼气 · 手往前推，后背拱起来", en: "Breathe out · push forward, round your back" } }] },
    { id: "B5", name: { zh: "扶膝前屈", en: "Hands-on-knees bend" }, view: "side", sides: "B", hold: 15,
      hint: { zh: "膝盖微弯，双手扶在膝盖上，屁股往后坐，背放平；感觉腰和大腿后侧被拉开。",
        en: "Soften your knees, hands on your knees, sit your hips back and keep your back flat; feel your lower back and hamstrings open." },
      frames: [
        { ms: 4000, torso: 40, arms: { l: [30, 70], r: [30, 70] }, legs: { l: [20, -5], r: [20, -5] }, root: { dx: -0.3, dy: 0.1 }, br: "in", cue: { zh: "吸气 · 背放平", en: "Breathe in · flat back" } },
        { ms: 4000, torso: 46, br: "out", cue: { zh: "呼气 · 屁股往后坐一点", en: "Breathe out · hips back a little" } }] },
    { id: "B6", name: { zh: "轻轻后仰", en: "Gentle backbend" }, view: "side", sides: "B", hold: 12,
      hint: { zh: "双手扶住后腰，胸口往上抬，往后仰一点点就够；腰不舒服就跳过这个。",
        en: "Hands on your lower back, lift your chest and lean back just a little; if your back complains, skip this one." },
      frames: [
        { ms: 3000, torso: -4, arms: { l: [-70, -10], r: [-70, -10] }, br: "in", cue: { zh: "吸气 · 双手扶住后腰", en: "Breathe in · hands on your lower back" } },
        { ms: 3000, torso: -12, head: -6, root: { dx: 0.2 }, br: "out", cue: { zh: "呼气 · 胸口往上，轻轻后仰", en: "Breathe out · chest up, lean back gently" } }] },
  ] },
  { id: "C", name: { zh: "手腕脚踝" }, moves: [
    { id: "C1", name: { zh: "甩甩手" }, view: "front", sides: "B", hold: 8,
      hint: { zh: "手腕放松，像甩掉手上的水一样轻轻甩几下。" },
      marks: [{ type: "shake", at: "hand.l" }, { type: "shake", at: "hand.r" }],
      frames: [
        { ms: 150, arms: { l: [22, 10], r: [22, 10] }, face: "happy", br: "none", cue: { zh: "放松，轻轻甩" } },
        { ms: 150, arms: { l: [30, 32], r: [16, 0] } },
        { ms: 150, arms: { l: [16, 0], r: [30, 32] } }] },
    { id: "C2", name: { zh: "转手腕" }, view: "front", sides: "B", hold: 16,
      hint: { zh: "手肘贴着身体，小臂竖起来，两只手腕慢慢画圈，转几圈后换个方向。" },
      halves: [{ zh: "手腕慢慢画圈" }, { zh: "换个方向转" }], reverseSecondHalf: true,
      marks: [{ type: "spin", at: "hand.l", dir: 1 }, { type: "spin", at: "hand.r", dir: -1 }],
      frames: [
        { ms: 500, arms: { l: [20, 145], r: [20, 145] }, br: "none" },
        { ms: 500, arms: { l: [24, 155], r: [24, 155] } },
        { ms: 500, arms: { l: [20, 165], r: [20, 165] } },
        { ms: 500, arms: { l: [16, 155], r: [16, 155] } }] },
    { id: "C3", name: { zh: "拉手腕" }, view: "side", sides: "RL", hold: 16,
      hint: { zh: "{S}手往前伸直，另一只手把{S}手的手指轻轻往身体方向拉，前臂有拉伸感就停。" },
      halves: [{ zh: "指尖朝上，往回拉" }, { zh: "指尖朝下，往回压" }],
      marks: [{ type: "palm", at: "hand.r" }],
      frames: [
        { ms: 4000, arms: { r: [88, 90], l: [75, 95] }, br: "in", cue: { zh: "吸气" } },
        { ms: 4000, arms: { r: [86, 88], l: [73, 93] }, br: "out", cue: { zh: "呼气" } }] },
    { id: "C4", name: { zh: "握拳张开" }, view: "front", sides: "B", hold: 12,
      hint: { zh: "双手往两边伸，用力握拳，再把五指用力撑开，来回做。" },
      marks: [{ type: "fist", at: "hand.l" }, { type: "fist", at: "hand.r" }],
      frames: [
        { ms: 800, arms: { l: [55, 72], r: [55, 72] }, hand: "open", br: "none", cue: { zh: "张开 · 五指撑开" } },
        { ms: 800, arms: { l: [52, 64], r: [52, 64] }, hand: "fist", cue: { zh: "握拳 · 握紧" } }] },
    { id: "C5", name: { zh: "绕脚踝" }, view: "side", sides: "RL", hold: 12,
      hint: { zh: "扶着桌子站稳（坐着也行），{S}脚稍微抬起，用脚尖慢慢画圈。" },
      halves: [{ zh: "{S}脚尖慢慢画圈" }, { zh: "换个方向画圈" }], reverseSecondHalf: true,
      marks: [{ type: "desk", at: "hand.r" }, { type: "spin", at: "foot.r", dir: 1 }],
      frames: [
        { ms: 450, arms: { r: [70, 80], l: [60, 70] }, legs: { r: [33, 20], l: [-2, 0] }, br: "none" },
        { ms: 450, legs: { r: [35, 14] } },
        { ms: 450, legs: { r: [37, 20] } },
        { ms: 450, legs: { r: [35, 26] } }] },
    { id: "C6", name: { zh: "踮脚尖" }, view: "front", sides: "B", hold: 15,
      hint: { zh: "双脚与肩同宽，脚跟慢慢抬起，停一下再慢慢放下；站不稳就扶着桌子。" },
      marks: [{ type: "rise" }],
      frames: [
        { ms: 1200, arms: { l: [50, -45], r: [50, -45] }, root: { dy: 0 }, br: "out", cue: { zh: "慢慢放下" } },
        { ms: 1200, root: { dy: -0.35 }, br: "in", cue: { zh: "踮起脚尖" } },
        { ms: 600, br: "hold", cue: { zh: "停一下" } }] },
  ] },
]);

// Card chrome. zh / en only, like the move text: every other UI language falls
// back to English except zh-TW, which reads the Chinese source better than it
// reads English.
const UI_TEXT = Object.freeze({
  zh: {
    sideR: "右", sideL: "左", sideTagSuffix: "侧",
    inviteTitle: "该拉伸了？",
    inviteBody: "坐了挺久啦。来一组「{group}」：{n} 个动作，约 {dur}，坐着站着都行。",
    inviteNote: "慢慢做，哪里不舒服就停下。这只是活动提醒，不能代替医生的建议。",
    signTitle: "该拉伸了？",
    btnStart: "开始", btnLater: "10 分钟后", btnSkipToday: "今天跳过",
    btnPause: "暂停", btnResume: "继续", btnSkip: "跳过这个", btnEnd: "结束", btnOk: "好",
    countTitle: "准备开始", countCue: "跟着豆豆做，慢慢来", countHint: "{group} · {n} 个动作 · 约 {dur}",
    countSub: "第一个：{move}",
    gapBig: "下一个", gapTitle: "下一个：{move}", gapCue: "放松一下，准备",
    enterCue: "慢慢进入动作", exitCue: "慢慢回来", switchCue: "换另一边",
    switchBig: "换边", switchSub: "接下来：{side}侧",
    pausedBig: "暂停中", pausedSub: "点「继续」接着做", pausedCue: "已暂停，豆豆等你",
    progress: "第 {i} / {n} 个",
    breathIn: "吸气", breathOut: "呼气", breathHold: "停",
    doneTitle: "做完啦！",
    doneBody: "「{group}」{n} 个动作{skipped}，用时 {dur}。下一次 {next} 分钟后。",
    doneSkipped: "（跳过 {n} 个）",
    earlyTitle: "先到这儿 · 做了 {done} / {n} 个",
    earlyBody: "没关系，下次再接着来。",
    boardDone: "做完啦", boardEarly: "下次见", boardInvite: "动一动？",
    durMinSec: "{m} 分 {s} 秒", durSec: "{s} 秒",
    durBoth: "{s} 秒", durEach: "左右各 {s} 秒",
  },
  en: {
    sideR: "right", sideL: "left", sideTagSuffix: "",
    inviteTitle: "Time to stretch?",
    inviteBody: "You've been sitting a while. One round of “{group}”: {n} moves, about {dur}, sitting or standing.",
    inviteNote: "Go slowly and stop if anything hurts. This is a reminder to move, not medical advice.",
    signTitle: "Time to stretch?",
    btnStart: "Start", btnLater: "In 10 min", btnSkipToday: "Skip today",
    btnPause: "Pause", btnResume: "Resume", btnSkip: "Skip this", btnEnd: "End", btnOk: "OK",
    countTitle: "Get ready", countCue: "Follow the bean, take it slow", countHint: "{group} · {n} moves · about {dur}",
    countSub: "First: {move}",
    gapBig: "Next", gapTitle: "Next: {move}", gapCue: "Relax, get ready",
    enterCue: "Ease into it", exitCue: "Slowly come back", switchCue: "Other side",
    switchBig: "Switch", switchSub: "Next: {side} side",
    pausedBig: "Paused", pausedSub: "Press Resume to go on", pausedCue: "Paused, the bean is waiting",
    progress: "{i} / {n}",
    breathIn: "in", breathOut: "out", breathHold: "hold",
    doneTitle: "All done!",
    doneBody: "“{group}”: {n} moves{skipped} in {dur}. Next one in {next} min.",
    doneSkipped: " ({n} skipped)",
    earlyTitle: "Stopping here · {done} / {n} done",
    earlyBody: "No problem, pick it up next time.",
    boardDone: "Done", boardEarly: "See you", boardInvite: "Stretch?",
    durMinSec: "{m} min {s} s", durSec: "{s} s",
    durBoth: "{s} s", durEach: "{s} s each side",
  },
});

function contentLang(lang) {
  return lang === "zh" || lang === "zh-TW" ? "zh" : "en";
}

function pick(text, lang) {
  if (!text) return "";
  if (typeof text === "string") return text;
  return text[lang] || text.zh || text.en || "";
}

function format(template, vars) {
  return String(template || "").replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
}

function uiText(lang) {
  return UI_TEXT[contentLang(lang)];
}

// {S} / {O} → the side words. A both-sides move has no placeholders.
function fillSide(text, side, lang) {
  if (!text || side === "B") return text || "";
  const ui = uiText(lang);
  const s = side === "R" ? ui.sideR : ui.sideL;
  const o = side === "R" ? ui.sideL : ui.sideR;
  return text.split("{S}").join(s).split("{O}").join(o);
}

function fmtDur(ms, lang) {
  const ui = uiText(lang);
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? format(ui.durMinSec, { m, s: String(s).padStart(2, "0") }) : format(ui.durSec, { s });
}

function getGroup(id) {
  return GROUPS.find((g) => g.id === id) || null;
}

function enabledGroups() {
  return ENABLED_GROUP_IDS.map(getGroup).filter(Boolean);
}

// An unknown or not-yet-enabled id falls back to the default group, so a
// stale caller can never start a group whose text is incomplete.
function resolveGroup(id) {
  return ENABLED_GROUP_IDS.includes(id) ? getGroup(id) : getGroup(DEFAULT_GROUP_ID);
}

function sidesOf(move) {
  return move.sides === "RL" ? ["R", "L"] : ["B"];
}

// ── Poses ──

const POSE_KEYS = ["ms", "torso", "head", "lift", "arms", "legs", "root", "face", "prop"];

function stripFrame(frame) {
  const out = {};
  for (const key of POSE_KEYS) if (key in frame) out[key] = frame[key];
  return out;
}

// Front-view mirror: left and right limbs swap, lean and sideways shift flip.
function mirrorFrame(frame) {
  const out = { ...frame };
  for (const part of ["arms", "legs"]) {
    if (!frame[part]) continue;
    out[part] = {};
    if (frame[part].r) out[part].l = frame[part].r;
    if (frame[part].l) out[part].r = frame[part].l;
  }
  if (typeof frame.torso === "number") out.torso = -frame.torso;
  if (typeof frame.head === "number") out.head = -frame.head;
  if (frame.root) {
    out.root = { ...frame.root };
    if (typeof frame.root.dx === "number") out.root.dx = -frame.root.dx;
    if (typeof frame.root.rot === "number") out.root.rot = -frame.root.rot;
  }
  return out;
}

function plainPose(pose) {
  return {
    torso: pose.torso, head: pose.head, lift: pose.lift,
    arms: { l: pose.arms.l.slice(), r: pose.arms.r.slice() },
    legs: { l: pose.legs.l.slice(), r: pose.legs.r.slice() },
    root: { ...pose.root }, face: pose.face, prop: pose.prop,
  };
}

const restCache = new Map();
function restPose(view) {
  if (!restCache.has(view)) restCache.set(view, normalizePose({ view, frames: [{}] }).frames[0].pose);
  return restCache.get(view);
}

function stillAnim(view, facing = "right") {
  return normalizePose({ view, facing, frames: [{}] });
}

// The little extra animations around a break.
const WAVE_POSE = Object.freeze({ loop: true, frames: [
  { ms: 400, arms: { r: [150, 165] } }, { ms: 280, arms: { r: [150, 205] } }, { ms: 280, arms: { r: [150, 165] } },
  { ms: 280, arms: { r: [150, 205] } }, { ms: 280, arms: { r: [150, 165] } }, { ms: 900, arms: { r: [18, 10] } }] });
const CHEER_POSE = Object.freeze({ loop: false, hold: 0, frames: [
  { ms: 300 },
  { ms: 250, root: { dy: 0.25 }, legs: { l: [22, -18], r: [22, -18] }, arms: { l: [30, 20], r: [30, 20] } },
  { ms: 220, root: { dy: -1.8 }, legs: { l: [8, 4], r: [8, 4] }, arms: { l: [150, 155], r: [150, 155] }, face: "happy", prop: "star" },
  { ms: 260, root: { dy: 0 }, legs: { l: [4, 0], r: [4, 0] } },
  { ms: 500, arms: { l: [150, 155], r: [150, 155] }, face: "happy", prop: "star" }] });

function cycleMs(anim) {
  let t = 0;
  for (let i = 1; i < anim.frames.length; i++) t += anim.frames[i].ms;
  return t + anim.frames[0].ms;
}

// One side of one move: an enter animation (rest → the move), the hold loop,
// an exit animation (the move → rest), all normalized, plus the follow-along
// layer per hold frame.
const variantCache = new Map();
function variantOf(move, side, lang) {
  const key = `${move.id}|${side}|${contentLang(lang)}`;
  if (variantCache.has(key)) return variantCache.get(key);
  const mirrored = side === "L";
  const view = move.view;
  const facing = view === "side" && mirrored ? "left" : "right";
  let frames = move.frames.map(stripFrame);
  if (mirrored && view === "front") frames = frames.map(mirrorFrame);
  const hold = normalizePose({ view, facing, loop: true, frames });
  const target = plainPose(hold.frames[0].pose);
  const enter = normalizePose({ view, facing, loop: false, hold: 0, frames: [{ ms: 80 }, { ms: ENTER_MS, ...target }] });
  const exit = normalizePose({ view, facing, loop: false, hold: 0, frames: [{ ms: 80, ...target }, { ms: EXIT_MS, ...plainPose(restPose(view)) }] });
  const marks = (move.marks || []).map((mark) => {
    const copy = { ...mark };
    if (mirrored && view === "front" && copy.at) copy.at = copy.at.replace(/\.(l|r)$/, (_, s) => (s === "l" ? ".r" : ".l"));
    if (mirrored && typeof copy.dir === "number") copy.dir = -copy.dir;
    return copy;
  });
  // Cue, breath and hand not written on a frame carry over from the one before.
  const cues = [];
  let last = { cue: "", br: "none", hand: "" };
  for (let i = 0; i < hold.frames.length; i++) {
    const raw = move.frames[i];
    const entry = {
      cue: raw.cue ? fillSide(pick(raw.cue, contentLang(lang)), side, lang) : last.cue,
      br: raw.br || last.br,
      hand: raw.hand || last.hand,
    };
    cues.push(entry);
    last = entry;
  }
  const ui = uiText(lang);
  const variant = Object.freeze({
    move, side, view, facing, hold, enter, exit, marks, cues,
    holdMs: move.hold * 1000,
    cycleMs: cycleMs(hold),
    halves: move.halves ? move.halves.map((h) => fillSide(pick(h, contentLang(lang)), side, lang)) : null,
    reverseSecondHalf: !!move.reverseSecondHalf,
    hint: fillSide(pick(move.hint, contentLang(lang)), side, lang),
    tag: side === "B" ? "" : (side === "R" ? ui.sideR : ui.sideL) + ui.sideTagSuffix,
  });
  variantCache.set(key, variant);
  return variant;
}

// Hold phase, t ms in: which hold frame the figure is moving into (its cue
// and breath), how far into that move it is (0..1), and which half of the
// hold this is. The card runs the same arithmetic per animation frame; this
// copy is what the tests pin down.
function holdState(variant, t) {
  const cyc = variant.cycleMs;
  const second = t >= variant.holdMs / 2;
  let u = ((t % cyc) + cyc) % cyc;
  if (variant.reverseSecondHalf && second) u = (cyc - u) % cyc;
  const F = variant.hold.frames;
  let target = 0;
  let k = 0;
  let rest = u;
  for (let i = 1; i <= F.length; i++) {
    const idx = i % F.length;
    const ms = F[idx].ms;
    if (rest <= ms || i === F.length) { target = idx; k = Math.min(1, rest / ms); break; }
    rest -= ms;
  }
  const entry = variant.cues[target];
  let cue = entry.cue;
  if (variant.halves) {
    cue = variant.halves[second ? 1 : 0] + (entry.br !== "none" && entry.cue ? " · " + entry.cue : "");
  }
  return { u, frame: target, k, half: second ? 1 : 0, cue, br: entry.br };
}

// ── Timeline ──

// 3-2-1 → every move (each side: enter, hold, exit) → "next" between moves.
function buildPlan(group) {
  const segs = [{ type: "count", ms: COUNT_MS, mi: 0, sd: sidesOf(group.moves[0])[0] }];
  group.moves.forEach((move, mi) => {
    const sides = sidesOf(move);
    sides.forEach((sd, si) => {
      segs.push({ type: "enter", mi, sd, ms: ENTER_MS });
      segs.push({ type: "hold", mi, sd, ms: move.hold * 1000 });
      segs.push({ type: "exit", mi, sd, ms: EXIT_MS, switching: si < sides.length - 1 });
    });
    if (mi < group.moves.length - 1) {
      segs.push({ type: "gap", mi: mi + 1, sd: sidesOf(group.moves[mi + 1])[0], ms: GAP_MS });
    }
  });
  return segs.map((seg) => Object.freeze(seg));
}

function planMs(group) {
  return buildPlan(group).reduce((sum, seg) => sum + seg.ms, 0);
}

// ── Session engine ──
//
// A pure state machine over the plan, on an injected clock. The runtime asks
// it for the time left in the current segment, sets one timer for that, and
// calls tick() when it fires; pause/resume/skip/end come from the card and
// the pet's menu. Status: "running" → "done" (the plan ran out) or "early"
// (ended by the user, or skipped past the last move).
function createStretchSession(options = {}) {
  const group = options.group || resolveGroup(DEFAULT_GROUP_ID);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const plan = buildPlan(group);
  const startedAt = now();
  let si = 0;
  let segStartedAt = startedAt;
  let pausedAt = null;
  let activeMs = 0;
  let activeSince = startedAt;
  let status = "running";
  let endedAt = null;
  const done = new Set();
  const skipped = new Set();

  function segElapsed(at = now()) {
    return Math.max(0, (pausedAt !== null ? pausedAt : at) - segStartedAt);
  }

  function finish(nextStatus, at) {
    if (status !== "running") return;
    if (pausedAt === null) activeMs += Math.max(0, at - activeSince);
    pausedAt = null;
    status = nextStatus;
    endedAt = at;
  }

  // Leaving segment si at time `at`. The last exit of a move that was not
  // skipped is what makes it "done".
  function leaveSegment(at) {
    const seg = plan[si];
    const next = plan[si + 1];
    if (seg.type === "exit" && (!next || next.type === "gap") && !skipped.has(seg.mi)) done.add(seg.mi);
    si += 1;
    segStartedAt = at;
    if (si >= plan.length) {
      si = plan.length - 1;
      finish("done", at);
    }
  }

  // Advances past every segment that has run out. Returns true when the
  // segment (or the status) changed, i.e. when the card needs a new payload.
  function tick() {
    if (status !== "running" || pausedAt !== null) return false;
    const at = now();
    let changed = false;
    while (status === "running" && at - segStartedAt >= plan[si].ms) {
      const end = segStartedAt + plan[si].ms;
      leaveSegment(end);
      changed = true;
    }
    return changed;
  }

  function pause() {
    if (status !== "running" || pausedAt !== null) return false;
    tick();
    if (status !== "running") return true;
    const at = now();
    pausedAt = at;
    activeMs += Math.max(0, at - activeSince);
    return true;
  }

  function resume() {
    if (status !== "running" || pausedAt === null) return false;
    const at = now();
    segStartedAt += at - pausedAt;
    activeSince = at;
    pausedAt = null;
    return true;
  }

  function togglePause() {
    return pausedAt === null ? pause() : resume();
  }

  // Skip: the countdown or a "next" gap is just cut short; inside a move the
  // whole move goes (both sides) and the timeline jumps to the next gap.
  // Skipping the last move ends the session early.
  function skip() {
    if (status !== "running") return false;
    if (pausedAt === null) tick();
    if (status !== "running") return true;
    const at = now();
    const seg = plan[si];
    const wasPaused = pausedAt !== null;
    if (wasPaused) {
      activeSince = at;
      pausedAt = null;
    }
    if (seg.type === "count" || seg.type === "gap") {
      si += 1;
      segStartedAt = at;
      return true;
    }
    if (!done.has(seg.mi)) skipped.add(seg.mi);
    const nextGap = plan.findIndex((s, k) => k > si && s.type === "gap");
    if (nextGap < 0) {
      finish("early", at);
      return true;
    }
    si = nextGap;
    segStartedAt = at;
    return true;
  }

  function end() {
    if (status !== "running") return false;
    finish("early", now());
    return true;
  }

  // Time until the current segment runs out, or null when nothing will
  // happen on its own (paused or over).
  function msUntilNextSegment() {
    if (status !== "running" || pausedAt !== null) return null;
    return Math.max(0, plan[si].ms - segElapsed());
  }

  function snapshot() {
    const at = now();
    return Object.freeze({
      groupId: group.id,
      status,
      index: si,
      segment: plan[si],
      elapsed: Math.min(plan[si].ms, segElapsed(at)),
      paused: pausedAt !== null,
      done: [...done].sort((a, b) => a - b),
      skipped: [...skipped].sort((a, b) => a - b),
      moveCount: group.moves.length,
      activeMs: status === "running" && pausedAt === null ? activeMs + Math.max(0, at - activeSince) : activeMs,
      startedAt,
      endedAt,
    });
  }

  return {
    group,
    plan,
    tick,
    pause,
    resume,
    togglePause,
    skip,
    end,
    msUntilNextSegment,
    snapshot,
    get status() { return status; },
    get paused() { return pausedAt !== null; },
  };
}

// ── Cards ──
//
// What the card window draws, as plain data. A new payload goes out on every
// segment change and every pause / resume; between them the card animates on
// its own from `board` (see notice-bubble.html, "Stretch card"). Strings are
// final text — the card never formats anything.

const STRETCH_CARD_ID = "stretch";
const ACTIONS = Object.freeze(["start", "later", "skipToday", "pause", "resume", "skip", "end", "ok"]);

function moveDurText(move, lang) {
  const ui = uiText(lang);
  return format(move.sides === "RL" ? ui.durEach : ui.durBoth, { s: move.hold });
}

function groupName(group, lang) {
  return pick(group.name, contentLang(lang));
}

function moveName(move, lang) {
  return pick(move.name, contentLang(lang));
}

function breathWords(lang) {
  const ui = uiText(lang);
  return { in: ui.breathIn, out: ui.breathOut, hold: ui.breathHold };
}

function buildInviteCard({ group = resolveGroup(DEFAULT_GROUP_ID), lang = "zh" } = {}) {
  const ui = uiText(lang);
  return Object.freeze({
    id: STRETCH_CARD_ID,
    phase: "invite",
    level: "info",
    title: ui.inviteTitle,
    count: "",
    cue: group.moves.map((m) => moveName(m, lang)).join(" · "),
    body: format(ui.inviteBody, { group: groupName(group, lang), n: group.moves.length, dur: fmtDur(planMs(group), lang) }),
    note: ui.inviteNote,
    pills: null,
    buttons: [
      { action: "start", label: ui.btnStart, primary: true },
      { action: "later", label: ui.btnLater },
      { action: "skipToday", label: ui.btnSkipToday },
    ],
    dismiss: "later",
    board: { type: "anim", anim: normalizePose(WAVE_POSE), name: ui.boardInvite },
    breath: breathWords(lang),
  });
}

function pillsOf(snap, current) {
  return { n: snap.moveCount, now: current, done: snap.done, skipped: snap.skipped };
}

function buildRunCard(session, lang = "zh") {
  const snap = session.snapshot();
  const group = session.group;
  const ui = uiText(lang);
  const seg = snap.segment;
  const move = group.moves[seg.mi];
  const variant = variantOf(move, seg.sd, lang);
  const step = `${seg.mi + 1} / ${group.moves.length}`;
  const base = {
    id: STRETCH_CARD_ID,
    phase: "run",
    level: "info",
    count: format(ui.progress, { i: seg.mi + 1, n: group.moves.length }),
    note: "",
    pills: pillsOf(snap, seg.mi),
    buttons: [
      snap.paused
        ? { action: "resume", label: ui.btnResume, primary: true }
        : { action: "pause", label: ui.btnPause, primary: true },
      { action: "skip", label: ui.btnSkip },
      { action: "end", label: ui.btnEnd },
    ],
    dismiss: "end",
    paused: snap.paused,
    breath: breathWords(lang),
  };
  const timing = { ms: seg.ms, elapsed: snap.elapsed, paused: snap.paused, step };
  const pausedMsg = { big: ui.pausedBig, sub: ui.pausedSub, size: 3.2 };
  let card;
  if (seg.type === "count") {
    card = {
      ...base,
      title: ui.countTitle,
      cue: ui.countCue,
      body: format(ui.countHint, { group: groupName(group, lang), n: group.moves.length, dur: fmtDur(planMs(group), lang) }),
      board: { type: "still", anim: stillAnim(variant.view), countdown: COUNT_MS / 1000,
        msg: { big: "3", sub: format(ui.countSub, { move: moveName(move, lang) }), size: 4 }, ...timing },
    };
  } else if (seg.type === "gap") {
    card = {
      ...base,
      title: format(ui.gapTitle, { move: moveName(move, lang) }),
      cue: ui.gapCue,
      body: variant.hint,
      board: { type: "still", anim: stillAnim(variant.view),
        msg: { big: ui.gapBig, sub: `${moveName(move, lang)} · ${moveDurText(move, lang)}`, size: 3.2 }, ...timing },
    };
  } else {
    const title = moveName(move, lang) + (variant.tag ? ` · ${variant.tag}` : "");
    const board = { type: seg.type, name: moveName(move, lang), tag: variant.tag, marks: variant.marks, ...timing };
    let cue = "";
    if (seg.type === "enter") {
      board.anim = variant.enter;
      board.count = move.hold;
      cue = ui.enterCue;
    } else if (seg.type === "hold") {
      board.anim = variant.hold;
      board.cues = variant.cues;
      board.halves = variant.halves;
      board.reverse = variant.reverseSecondHalf;
      cue = holdState(variant, snap.elapsed).cue;
    } else {
      board.anim = variant.exit;
      cue = seg.switching ? ui.switchCue : ui.exitCue;
      if (seg.switching) {
        board.msg = { big: ui.switchBig, sub: format(ui.switchSub, { side: seg.sd === "R" ? ui.sideL : ui.sideR }), size: 3.2 };
      }
    }
    card = { ...base, title, cue, body: variant.hint, board };
  }
  if (snap.paused) {
    card.cue = ui.pausedCue;
    card.board = { ...card.board, msg: pausedMsg };
  }
  return Object.freeze(card);
}

function buildFinishCard(session, lang = "zh", { nextMinutes = 60 } = {}) {
  const snap = session.snapshot();
  const group = session.group;
  const ui = uiText(lang);
  const early = snap.status !== "done";
  const doneN = snap.done.length;
  return Object.freeze({
    id: STRETCH_CARD_ID,
    phase: early ? "early" : "done",
    level: early ? "info" : "success",
    title: early ? format(ui.earlyTitle, { done: doneN, n: group.moves.length }) : ui.doneTitle,
    count: "",
    cue: "",
    body: early
      ? ui.earlyBody
      : format(ui.doneBody, {
        group: groupName(group, lang),
        n: doneN,
        skipped: snap.skipped.length ? format(ui.doneSkipped, { n: snap.skipped.length }) : "",
        dur: fmtDur(snap.activeMs, lang),
        next: nextMinutes,
      }),
    note: "",
    pills: pillsOf(snap, -1),
    buttons: [{ action: "ok", label: ui.btnOk, primary: true }],
    dismiss: "ok",
    board: { type: "anim", anim: normalizePose(early ? WAVE_POSE : CHEER_POSE), name: early ? ui.boardEarly : ui.boardDone },
    breath: breathWords(lang),
  });
}

function isStretchAction(value) {
  return typeof value === "string" && ACTIONS.includes(value);
}

module.exports = {
  GROUPS,
  ENABLED_GROUP_IDS,
  DEFAULT_GROUP_ID,
  ENTER_MS,
  EXIT_MS,
  COUNT_MS,
  GAP_MS,
  STRETCH_CARD_ID,
  ACTIONS,
  UI_TEXT,
  contentLang,
  uiText,
  fillSide,
  fmtDur,
  getGroup,
  enabledGroups,
  resolveGroup,
  sidesOf,
  variantOf,
  holdState,
  buildPlan,
  planMs,
  createStretchSession,
  buildInviteCard,
  buildRunCard,
  buildFinishCard,
  isStretchAction,
};
