"use strict";

// Main-process side of the notice sign (clawd's "notice-screen" reaction).
// The render window owns the pose itself — text, marquee, zoom, hand-to-hand
// tosses, dwell — because its timers and its SVG document live there. Main
// owns the things the render window cannot do:
//
//   - input: the render window ignores the mouse, and during any reaction
//     main stops cursor polling, so hover / wheel / clicks arrive from the
//     hit window, are converted to viewBox units here, and are forwarded;
//   - the card: while the sign is up the notice's card is held back; a
//     left-click on the board asks for it (onSignClick), and a pose that is
//     cut short rather than shown in full asks for it too (onPoseInterrupted);
//   - the clipboard: a right-click on the board copies the notice's text,
//     resolved from the snapshot taken when the pose began (never from a
//     renderer-supplied string), so it still works if the card expired —
//     unless onBoardContextMenu claims it (the stretch invite's sign has
//     nothing to copy and opens its own menu instead);
//   - the hit window's gate: it is told while the pose is up, so it forwards
//     pointer moves and keeps click reactions from replacing the pose.

const { noticeCopyText } = require("./notice-text");
const { pointInRect } = require("./notice-screen-layout");

const POINTER_TYPES = new Set(["move", "leave", "wheel"]);
const MAX_ID_LENGTH = 64;
// A pose that ended this way was shown in full or handed the sign to a newer
// notice; its card stays held. Every other ending gives the card back.
const KEEP_HELD_REASONS = new Set(["dwell", "replaced"]);

function isLiveWebContents(wc) {
  return !!(wc && !(typeof wc.isDestroyed === "function" && wc.isDestroyed()));
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeRect(value) {
  if (!value || typeof value !== "object") return null;
  const rect = { x: value.x, y: value.y, w: value.w, h: value.h };
  if (![rect.x, rect.y, rect.w, rect.h].every(isFiniteNumber)) return null;
  if (rect.w <= 0 || rect.h <= 0 || rect.w > 1000 || rect.h > 1000) return null;
  return rect;
}

function normalizeId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH ? value : null;
}

function createNoticeScreenRuntime(options = {}) {
  const getRenderWebContents = options.getRenderWebContents || (() => null);
  const getHitWebContents = options.getHitWebContents || (() => null);
  const getHitWindowBounds = options.getHitWindowBounds || (() => null);
  const getPetWindowBounds = options.getPetWindowBounds || (() => null);
  const getCursorScreenPoint = options.getCursorScreenPoint || (() => null);
  const getAssetPointerPayload = options.getAssetPointerPayload || (() => null);
  const getCommittedFile = options.getCommittedFile || (() => null);
  const sendToRenderer = options.sendToRenderer || (() => false);
  const sendToHitWin = options.sendToHitWin || (() => {});
  const writeClipboard = options.writeClipboard || (() => {});
  const onSignClick = options.onSignClick || (() => {});
  const onPoseInterrupted = options.onPoseInterrupted || (() => {});
  // Every ending, with the notice id and why: "dwell", "replaced", "cancel"
  // or "visual" (another visual took the pet over). Called before
  // onPoseInterrupted.
  const onPoseEnded = options.onPoseEnded || (() => {});
  // Right-click on the board: return true to take it instead of copying.
  const onBoardContextMenu = options.onBoardContextMenu || (() => false);
  const now = options.now || (() => Date.now());

  // The pose main asked for: which notice, which file. Set on begin(), cleared
  // when the renderer reports the pose over or a different visual commits.
  let pending = null;
  // What the renderer reports while the pose is on screen: the notice id and
  // the screen's current (possibly zoomed) rect in viewBox units.
  let reported = null;
  let hitWindowActive = false;
  let begunAt = 0;

  function isPoseLive() {
    return !!(
      pending
      && reported
      && reported.id === pending.id
      && getCommittedFile() === pending.file
    );
  }

  // The hit window needs exactly one bit; only send it when it flips.
  function syncHitWindow(force = false) {
    const active = isPoseLive();
    if (!force && active === hitWindowActive) return;
    hitWindowActive = active;
    sendToHitWin("hit-state-sync", { noticeScreenActive: active });
  }

  function begin(payload, notice, file) {
    if (!payload || typeof file !== "string" || !file) return false;
    pending = Object.freeze({
      id: payload.id || null,
      file,
      // Frozen store objects; keep the reference, not a copy of the store.
      notice: notice && typeof notice === "object" ? notice : null,
    });
    reported = null;
    begunAt = now();
    syncHitWindow();
    return true;
  }

  function reset() {
    pending = null;
    reported = null;
    syncHitWindow();
  }

  function handleRendererStatus(event, status) {
    const renderWc = getRenderWebContents();
    if (!event || !isLiveWebContents(renderWc) || event.sender !== renderWc) return false;
    if (!status || typeof status !== "object") return false;
    const id = normalizeId(status.id);
    if (status.active !== true) {
      // The pose is over (dwell finished, cancelled, replaced). Only the pose
      // it names: a newer notice's begin() may already be in flight, and the
      // renderer ends the old pose on its way to starting that one.
      if (reported && reported.id === id) reported = null;
      const wasCurrent = !!(pending && pending.id === id);
      if (wasCurrent) pending = null;
      syncHitWindow();
      if (wasCurrent) {
        const reason = KEEP_HELD_REASONS.has(status.reason) ? status.reason : "cancel";
        try { onPoseEnded(id, reason); } catch {}
        if (!KEEP_HELD_REASONS.has(reason)) onPoseInterrupted(id);
      }
      return true;
    }
    const rect = normalizeRect(status.rect);
    if (!pending || !rect || id !== pending.id) return false;
    reported = { id, rect };
    syncHitWindow();
    return true;
  }

  // The displayed-visual projection committed something else: whatever the
  // renderer last said, the head screen is no longer what the hit window sees.
  function handleVisualCommitted(visual) {
    if (!pending) return;
    if (visual && visual.file === pending.file) {
      syncHitWindow();
      return;
    }
    if (reported) {
      const id = pending.id;
      pending = null;
      reported = null;
      syncHitWindow();
      try { onPoseEnded(id, "visual"); } catch {}
      onPoseInterrupted(id);
      return;
    }
    syncHitWindow();
  }

  // Hit-window client coordinates → screen coordinates → viewBox units.
  // The hit window's own bounds turn its client point into a screen point;
  // the global cursor is only a fallback (it is unavailable on native Wayland).
  function toViewBoxPoint(clientX, clientY) {
    let screenPoint = null;
    const hitBounds = getHitWindowBounds();
    if (hitBounds && isFiniteNumber(clientX) && isFiniteNumber(clientY)
        && isFiniteNumber(hitBounds.x) && isFiniteNumber(hitBounds.y)) {
      screenPoint = { x: hitBounds.x + clientX, y: hitBounds.y + clientY };
    } else {
      const cursor = getCursorScreenPoint();
      if (cursor && isFiniteNumber(cursor.x) && isFiniteNumber(cursor.y)) screenPoint = cursor;
    }
    const petBounds = getPetWindowBounds();
    if (!screenPoint || !petBounds) return null;
    const raw = getAssetPointerPayload(petBounds, screenPoint);
    if (!raw || !isFiniteNumber(raw.x) || !isFiniteNumber(raw.y)) return null;
    return { x: raw.x, y: raw.y };
  }

  function handleHitPointer(event, input) {
    const hitWc = getHitWebContents();
    if (!event || !isLiveWebContents(hitWc) || event.sender !== hitWc) return false;
    if (!input || typeof input !== "object" || !POINTER_TYPES.has(input.type)) return false;
    if (!isPoseLive()) return false;
    if (input.type === "leave") {
      return sendToRenderer("notice-screen-pointer", { type: "leave" }) !== false;
    }
    const point = toViewBoxPoint(input.clientX, input.clientY);
    if (!point) return false;
    const out = { type: input.type, x: point.x, y: point.y };
    if (input.type === "wheel") {
      out.deltaY = isFiniteNumber(input.deltaY) ? Math.max(-10000, Math.min(10000, input.deltaY)) : 0;
      out.deltaMode = input.deltaMode === 1 || input.deltaMode === 2 ? input.deltaMode : 0;
    }
    return sendToRenderer("notice-screen-pointer", out) !== false;
  }

  // Left-click from the hit window while the sign is up. True means it landed
  // on the board and the card was asked for; false means it was an ordinary
  // click on the pet.
  function handleHitClick(event, point) {
    if (!isPoseLive()) return false;
    const hitWc = getHitWebContents();
    if (!event || !isLiveWebContents(hitWc) || event.sender !== hitWc) return false;
    const input = point && typeof point === "object" ? point : {};
    const viewBoxPoint = toViewBoxPoint(input.clientX, input.clientY);
    if (!viewBoxPoint || !pointInRect(viewBoxPoint, reported.rect)) return false;
    try {
      onSignClick(pending.id);
    } catch {}
    return true;
  }

  // Right-click from the hit window. True means the board took it (text
  // copied); false means the caller opens the normal context menu.
  function handleContextMenu(event, point) {
    if (!isPoseLive()) return false;
    const hitWc = getHitWebContents();
    if (!event || !isLiveWebContents(hitWc) || event.sender !== hitWc) return false;
    const input = point && typeof point === "object" ? point : {};
    const viewBoxPoint = toViewBoxPoint(input.clientX, input.clientY);
    if (!viewBoxPoint || !pointInRect(viewBoxPoint, reported.rect)) return false;
    let claimed = false;
    try {
      claimed = onBoardContextMenu(pending.id) === true;
    } catch {
      claimed = false;
    }
    if (claimed) return true;
    const text = noticeCopyText(pending.notice);
    if (!text) return false;
    try {
      writeClipboard(text);
    } catch {
      return false;
    }
    sendToRenderer("notice-screen-copied", { id: pending.id });
    return true;
  }

  return {
    begin,
    reset,
    handleRendererStatus,
    handleVisualCommitted,
    handleHitPointer,
    handleHitClick,
    handleContextMenu,
    // Re-announce the gate to a freshly (re)loaded hit window.
    syncHitWindow: () => syncHitWindow(true),
    isActive: isPoseLive,
    // How long the live pose has been up, or 0 when none is.
    liveForMs: () => (isPoseLive() ? Math.max(0, now() - begunAt) : 0),
    getPendingFile: () => (pending ? pending.file : null),
    getPendingId: () => (pending ? pending.id : null),
  };
}

function registerNoticeScreenIpc(options = {}) {
  const ipcMain = options.ipcMain;
  const runtime = options.noticeScreen;
  if (!ipcMain) throw new Error("registerNoticeScreenIpc requires ipcMain");
  if (!runtime) throw new Error("registerNoticeScreenIpc requires noticeScreen");
  const disposers = [];

  function on(channel, listener) {
    ipcMain.on(channel, listener);
    disposers.push(() => ipcMain.removeListener(channel, listener));
  }

  on("notice-screen-status", (event, status) => runtime.handleRendererStatus(event, status));
  on("notice-screen-hit-pointer", (event, input) => runtime.handleHitPointer(event, input));
  if (typeof ipcMain.handle === "function") {
    ipcMain.handle("notice-screen-hit-click", (event, input) => runtime.handleHitClick(event, input) === true);
    disposers.push(() => ipcMain.removeHandler("notice-screen-hit-click"));
  }

  return {
    dispose() {
      while (disposers.length) {
        const dispose = disposers.pop();
        dispose();
      }
    },
  };
}

module.exports = {
  createNoticeScreenRuntime,
  registerNoticeScreenIpc,
};
