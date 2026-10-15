"use strict";

const NOTICE_REACTION_LEVELS = Object.freeze(["info", "success", "warn", "error"]);
const NOTICE_REACTION_LEVEL_SET = new Set(NOTICE_REACTION_LEVELS);

function normalizeNoticeReactionLevel(value) {
  return NOTICE_REACTION_LEVEL_SET.has(value) ? value : null;
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

  return function handleNoticeReaction(level, context = {}) {
    const normalized = normalizeNoticeReactionLevel(level);
    if (!normalized) return false;
    if (!canPlayNoticeReaction({
      enabled: getEnabled(),
      doNotDisturb: getDoNotDisturb(),
      petHidden: isPetHidden(),
      miniMode: getMiniMode(),
      miniTransitioning: getMiniTransitioning(),
      dragging: isDragging(),
      headless: context.headless === true,
      hasPetWindow: hasPetWindow(),
    })) return false;

    sendToRenderer("play-notice-reaction", normalized);
    return true;
  };
}

module.exports = {
  NOTICE_REACTION_LEVELS,
  normalizeNoticeReactionLevel,
  canPlayNoticeReaction,
  createNoticeReactionHandler,
};
