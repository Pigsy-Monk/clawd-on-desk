"use strict";

const { noticeHeadline } = require("./notice-text");

const NOTICE_REACTION_LEVELS = Object.freeze(["info", "success", "warn", "error"]);
const NOTICE_REACTION_LEVEL_SET = new Set(NOTICE_REACTION_LEVELS);

function normalizeNoticeReactionLevel(value) {
  return NOTICE_REACTION_LEVEL_SET.has(value) ? value : null;
}

// What crosses to the render window: the level (which every theme needs to
// pick its reaction), plus the card's id and one-line headline for a theme
// that can show it (clawd's head screen). Never the body, series or image —
// the head screen shows one line, and copy text is resolved in main from the
// id. A bare level string is still accepted for callers that only have that.
function buildNoticeReactionPayload(notice) {
  if (typeof notice === "string") {
    const level = normalizeNoticeReactionLevel(notice);
    return level ? Object.freeze({ level, id: null, title: "" }) : null;
  }
  if (!notice || typeof notice !== "object") return null;
  const level = normalizeNoticeReactionLevel(notice.level);
  if (!level) return null;
  return Object.freeze({
    level,
    id: typeof notice.id === "string" && notice.id ? notice.id : null,
    title: noticeHeadline(notice),
  });
}

// Notice reactions are decorative overlays, not state transitions. Keep their
// eligibility in one main-process gate so agent-pushed notices cannot bypass
// the user's opt-in or the pet's current visibility/interaction policy.
function canPlayNoticeReaction(options = {}) {
  return options.enabled === true
    && options.doNotDisturb !== true
    && options.petHidden !== true
    && options.miniMode !== true
    && options.miniTransitioning !== true
    && options.dragging !== true
    && options.headless !== true
    && options.hasPetWindow === true;
}

function createNoticeReactionHandler(options = {}) {
  const getEnabled = options.getEnabled || (() => false);
  const getDoNotDisturb = options.getDoNotDisturb || (() => false);
  const isPetHidden = options.isPetHidden || (() => false);
  const getMiniMode = options.getMiniMode || (() => false);
  const getMiniTransitioning = options.getMiniTransitioning || (() => false);
  const isDragging = options.isDragging || (() => false);
  const hasPetWindow = options.hasPetWindow || (() => false);
  const sendToRenderer = options.sendToRenderer || (() => {});
  // Optional: a theme with a head-screen reaction routes the notice through
  // main's displayed-visual contract instead (so its hit box applies). Returns
  // true when it took the notice; false falls back to the per-level reaction.
  const playNoticeScreen = typeof options.playNoticeScreen === "function"
    ? options.playNoticeScreen
    : null;

  function canPlay(context = {}) {
    return canPlayNoticeReaction({
      enabled: getEnabled(),
      doNotDisturb: getDoNotDisturb(),
      petHidden: isPetHidden(),
      miniMode: getMiniMode(),
      miniTransitioning: getMiniTransitioning(),
      dragging: isDragging(),
      headless: context.headless === true,
      hasPetWindow: hasPetWindow(),
    });
  }

  function handleNoticeReaction(notice, context = {}) {
    const payload = buildNoticeReactionPayload(notice);
    if (!payload) return false;
    if (!canPlay(context)) return false;

    if (playNoticeScreen) {
      let handled = false;
      try {
        handled = playNoticeScreen(payload, notice) === true;
      } catch {
        handled = false;
      }
      if (handled) return true;
    }
    sendToRenderer("play-notice-reaction", payload);
    return true;
  }

  // The same gate, without playing anything: main asks it before the notice
  // bubble renders, to know whether the sign will show the notice.
  handleNoticeReaction.canPlay = canPlay;
  return handleNoticeReaction;
}

module.exports = {
  NOTICE_REACTION_LEVELS,
  normalizeNoticeReactionLevel,
  buildNoticeReactionPayload,
  canPlayNoticeReaction,
  createNoticeReactionHandler,
};
