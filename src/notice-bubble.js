"use strict";

const { BrowserWindow } = require("electron");
const path = require("path");
const { keepOutOfTaskbar } = require("./taskbar");
const { resolveBubbleWorkArea } = require("./bubble-work-area");
const { clampTextScale, scaleWidth, scaleHeight, applyZoomToWindow } = require("./text-scale");
const { computeUpdateBubbleBounds } = require("./update-bubble");
const { noticeCopyText } = require("./notice-text");

const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const WIN_TOPMOST_LEVEL = "pop-up-menu";
const LINUX_WINDOW_TYPE = "toolbar";
// CSS px (multiple of 20 → integral DIP width at every 5% textScale step).
const WIDTH = 340;
const EDGE_MARGIN = 8;
const GAP = 6;
const MAX_WORK_AREA_WIDTH_RATIO = 0.9;
// A stack taller than this scrolls inside its own window instead of growing
// past the display; the page caps its painted height to match.
const MAX_WORK_AREA_HEIGHT_RATIO = 0.9;
const MAC_FLOATING_TOPMOST_DELAY_MS = 120;
// The renderer's hide animation must finish before the window is hidden.
const HIDE_ANIMATION_MS = 250;

// Height model, CSS px. One card is a fixed block plus one line per extra
// wrapped title/body line; the stack adds the gap between cards. Only an
// estimate: the renderer measures the real stack and reports it back.
const CARD_BASE_HEIGHT = 150;
const CARD_GAP = 8;
const TEXT_LINE_HEIGHT = 16;
const WRAP_CHARS = 40;
// A trend card trades the body block for one row per series.
const TREND_SERIES_ROW_HEIGHT = 30;
// An image notice's thumbnail on a text card: its CSS max-height plus margin.
const IMAGE_THUMB_HEIGHT = 130;

// The renderer's own presentation hints, validated here so a ctx that returns
// nothing (or nonsense) is normalized once instead of in the page.
const TAIL_SIDES = new Set(["top", "right", "bottom", "left"]);
const DEFAULT_THEME_ID = "clawd";
// The bubble's visual style (pref noticeBubbleStyle). The renderer applies the
// same fallback, so an older main and a newer page still agree.
const NOTICE_STYLES = new Set(["pixel", "comic", "card"]);
const DEFAULT_NOTICE_STYLE = "pixel";

// What a right-click copies lives in notice-text.js: the pet's head screen
// copies the same text, so both surfaces share one definition.

function requiredDependency(value, name, owner) {
  if (!value) throw new Error(`${owner} requires ${name}`);
  return value;
}

function registerNoticeBubbleIpc(options = {}) {
  const ipcMain = requiredDependency(options.ipcMain, "ipcMain", "registerNoticeBubbleIpc");
  const noticeBubble = requiredDependency(options.noticeBubble, "noticeBubble", "registerNoticeBubbleIpc");
  requiredDependency(noticeBubble.handleNoticeBubbleHeight, "noticeBubble.handleNoticeBubbleHeight", "registerNoticeBubbleIpc");
  requiredDependency(noticeBubble.handleNoticeBubbleDismiss, "noticeBubble.handleNoticeBubbleDismiss", "registerNoticeBubbleIpc");
  requiredDependency(noticeBubble.handleNoticeBubbleExpand, "noticeBubble.handleNoticeBubbleExpand", "registerNoticeBubbleIpc");
  requiredDependency(noticeBubble.handleNoticeBubbleCopy, "noticeBubble.handleNoticeBubbleCopy", "registerNoticeBubbleIpc");
  const disposers = [];

  function on(channel, listener) {
    ipcMain.on(channel, listener);
    disposers.push(() => ipcMain.removeListener(channel, listener));
  }

  on("notice-bubble-height", (event, height) => noticeBubble.handleNoticeBubbleHeight(event, height));
  on("notice-bubble-dismiss", (event, id) => noticeBubble.handleNoticeBubbleDismiss(event, id));
  on("notice-bubble-expand", (event, id) => noticeBubble.handleNoticeBubbleExpand(event, id));
  on("notice-bubble-copy", (event, id) => noticeBubble.handleNoticeBubbleCopy(event, id));

  return {
    dispose() {
      while (disposers.length) {
        const dispose = disposers.pop();
        dispose();
      }
    },
  };
}

function deferMacFloatingVisibility(ctx, win) {
  if (!isMac || !win || win.isDestroyed()) return;
  const deferUntil = Date.now() + MAC_FLOATING_TOPMOST_DELAY_MS;
  win.__clawdMacDeferredVisibilityUntil = deferUntil;
  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    if (win.__clawdMacDeferredVisibilityUntil === deferUntil) {
      delete win.__clawdMacDeferredVisibilityUntil;
    }
    if (typeof ctx.reapplyMacVisibility === "function") ctx.reapplyMacVisibility();
  }, MAC_FLOATING_TOPMOST_DELAY_MS);
}

// Extra lines a single text block adds on top of the card's base height.
function wrappedExtraLines(text) {
  if (typeof text !== "string" || !text) return 0;
  const hardLines = text.split(/\r?\n/).length;
  const wrappedLines = Math.ceil(text.length / WRAP_CHARS);
  return Math.max(0, Math.max(hardLines, wrappedLines) - 1);
}

// A trend notice carries a series list instead of prose, so it grows one row
// per series on top of the shared card block. Kept pure: __test asserts on it.
function estimateNoticeStackHeight(notices) {
  const list = Array.isArray(notices) ? notices : [];
  if (list.length === 0) return 0;
  let height = 0;
  for (const notice of list) {
    height += CARD_BASE_HEIGHT;
    if (notice) {
      height += wrappedExtraLines(notice.title) * TEXT_LINE_HEIGHT;
      if (notice.kind === "trend") {
        const series = Array.isArray(notice.series) ? notice.series : [];
        height += series.length * TREND_SERIES_ROW_HEIGHT;
      } else {
        height += wrappedExtraLines(notice.body) * TEXT_LINE_HEIGHT;
        if (notice.image && typeof notice.image.data === "string" && notice.image.data) {
          height += IMAGE_THUMB_HEIGHT;
        }
      }
    }
  }
  return height + (list.length - 1) * CARD_GAP;
}

module.exports = function initNoticeBubble(ctx) {
  let bubble = null;
  // CSS px, as reported by the renderer; converted to DIP where consumed.
  let measuredHeight = 0;
  // The bounds last handed to setBounds(). A keyed notice can refresh many
  // times a second, and each refresh re-reports its height — so without this
  // the window takes a SetWindowPos on every tick even when nothing moved.
  // On Windows that repaints a transparent, always-on-top window, which reads
  // as the card flickering. Repositioning is now idempotent.
  let appliedBounds = null;
  // The cards on show: the store's snapshot (oldest → newest) minus the ones
  // held back below.
  let notices = [];
  // The whole snapshot, held cards included.
  let allNotices = [];
  // Cards held back while the pet holds the notice up on its sign. A new
  // notice is held when ctx.shouldHoldNewNotices says the sign will show it;
  // revealHeldNotices() (a click on the sign, or a sign cut short) lets them
  // through. Ids leave the set once the store drops the notice.
  const heldIds = new Set();
  // Ids of the last snapshot, so a new notice can be told from a refreshed
  // one (a keyed re-push keeps its id). Null until the store's first list.
  let seenIds = null;
  // The tail side the renderer last heard, so a height-driven move that flips
  // the side can be told apart from one that does not.
  let lastSentTailSide = null;
  let presentationActive = false;
  let fullscreenSuppressed = false;
  // A presentation paused by fullscreen or manual pet hiding stays pending
  // until both visibility layers are clear and the renderer is ready.
  let visibilityRestorePending = false;
  let hideTimer = null;
  let unsubscribeStore = null;
  // Whether the page has finished loading. Electron still reports
  // isLoading() === true while did-finish-load is being dispatched, so a
  // show that runs from that event (the first notice after start) saw a
  // "loading" page and never showed the window. Tracked from the load events
  // instead; isLoading() remains the answer when no event has been seen.
  let pageLoaded = false;
  function pageReady() {
    return !!bubble && !bubble.isDestroyed() && (pageLoaded || !bubble.webContents.isLoading());
  }
  // Last notice the renderer asked to expand; the chart window that consumes
  // it lands in a follow-up change.
  let expandedNoticeId = null;

  function notifyOrbitGeometryChanged() {
    const reposition = typeof ctx.repositionQuotaRing === "function"
      ? ctx.repositionQuotaRing
      : ctx.repositionSessionHud;
    if (typeof reposition !== "function") return;
    try { reposition(); } catch {}
  }

  function getTextScale(workArea) {
    return clampTextScale(typeof ctx.getTextScale === "function" ? ctx.getTextScale(workArea) : 1);
  }

  function getTargetWorkArea(petBounds) {
    if (typeof ctx.getBubbleWorkArea === "function") {
      return ctx.getBubbleWorkArea(!!ctx.bubbleFollowPet, petBounds);
    }
    return resolveBubbleWorkArea({
      followPet: !!ctx.bubbleFollowPet,
      petBounds,
      getPrimaryWorkArea: ctx.getPrimaryWorkArea,
      getNearestWorkArea: ctx.getNearestWorkArea,
      syntheticWorkArea: typeof ctx.getSyntheticWorkArea === "function" ? ctx.getSyntheticWorkArea() : null,
    });
  }

  // Follow rect for the follow-pet path: the pet's tight sprite rect, with the
  // same getters update-bubble uses so main.js needs no extra wiring.
  function getAnchorRect(petBounds) {
    const getter = typeof ctx.getNoticeBubbleAnchorRect === "function"
      ? ctx.getNoticeBubbleAnchorRect
      : ctx.getUpdateBubbleAnchorRect;
    if (typeof getter !== "function") return null;
    try {
      return getter(petBounds);
    } catch {
      return null;
    }
  }

  // Accepts a rect, an array of rects, or anything exposing getBounds() (a
  // BrowserWindow); non-rect values are dropped by the geometry normalizer.
  function pushRects(target, value) {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) pushRects(target, item);
      return;
    }
    if (typeof value.getBounds === "function") {
      try {
        pushRects(target, value.getBounds());
        return;
      } catch {}
    }
    target.push(value);
  }

  // The notice stack keeps clear of every other floating surface: the
  // permission bubble stack, the Session HUD, and the update bubble.
  function getAvoidRects() {
    const rects = [];
    for (const getterName of ["getPermissionBubbleBounds", "getSessionHudBounds", "getUpdateBubbleBounds"]) {
      if (typeof ctx[getterName] !== "function") continue;
      try {
        pushRects(rects, ctx[getterName]());
      } catch {}
    }
    return rects;
  }

  function estimateHeight() {
    return Math.max(estimateNoticeStackHeight(notices), CARD_BASE_HEIGHT);
  }

  // Everything the renderer needs on top of the notice list itself. Resolved at
  // send time: the theme can change and the pet can move between snapshots, so
  // neither value is worth caching.
  function presentationPayload() {
    const themeId = typeof ctx.getThemeId === "function" ? ctx.getThemeId() : null;
    const tailSide = typeof ctx.getNoticeBubbleTailSide === "function"
      ? ctx.getNoticeBubbleTailSide()
      : null;
    const style = typeof ctx.getNoticeStyle === "function" ? ctx.getNoticeStyle() : null;
    lastSentTailSide = TAIL_SIDES.has(tailSide) ? tailSide : null;
    return {
      notices,
      themeId: typeof themeId === "string" && themeId ? themeId : DEFAULT_THEME_ID,
      tailSide: lastSentTailSide,
      style: NOTICE_STYLES.has(style) ? style : DEFAULT_NOTICE_STYLE,
    };
  }

  function currentTailSide() {
    const side = typeof ctx.getNoticeBubbleTailSide === "function" ? ctx.getNoticeBubbleTailSide() : null;
    return TAIL_SIDES.has(side) ? side : null;
  }

  // Re-send the current snapshot as it stands, e.g. after the style pref
  // changed. Only a bubble that is actually presenting gets one: a suspended or
  // hidden bubble picks the new value up when it is next restored or shown.
  function refreshPresentation() {
    if (
      !bubble
      || bubble.isDestroyed()
      || !presentationActive
      || visibilityRestorePending
      || notices.length === 0
      || !pageReady()
    ) return false;
    bubble.webContents.send("notice-bubble-show", presentationPayload());
    return true;
  }

  function maxWindowHeight(workArea) {
    return Math.max(CARD_BASE_HEIGHT, Math.floor(workArea.height * MAX_WORK_AREA_HEIGHT_RATIO));
  }

  function ensureBubble() {
    if (bubble && !bubble.isDestroyed()) return bubble;

    const petBounds = ctx.getPetWindowBounds();
    const workArea = getTargetWorkArea(petBounds);
    const scale = getTextScale(workArea);
    bubble = new BrowserWindow({
      width: scaleWidth(WIDTH, scale),
      height: scaleHeight(estimateHeight(), scale),
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: !isMac,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
      ...(isMac ? { type: "panel" } : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload-notice-bubble.js"),
        nodeIntegration: false,
        contextIsolation: true,
        // The window is shown inactive and never focused, and Chromium
        // throttles such a window's animation frames almost to zero; a pose
        // card's figure then stands still. Same setting as the pet windows.
        backgroundThrottling: false,
      },
    });

    if (isWin) bubble.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);

    // Registered before anything else listens, so it has run by the time the
    // deferred show below checks readiness.
    pageLoaded = false;
    bubble.webContents.on("did-start-loading", () => { pageLoaded = false; });
    bubble.webContents.on("did-finish-load", () => { pageLoaded = true; });
    bubble.loadFile(path.join(__dirname, "notice-bubble.html"));
    bubble.on("closed", () => {
      bubble = null;
      measuredHeight = 0;
      appliedBounds = null;
      presentationActive = false;
      notifyOrbitGeometryChanged();
    });

    bubble.webContents.once("did-finish-load", () => {
      // Explicit even though same-origin propagation usually covers it — a
      // stale partition-persisted factor must never win over prefs.
      const petBounds = ctx.getPetWindowBounds();
      applyZoomToWindow(bubble, getTextScale(getTargetWorkArea(petBounds)));
      if (notices.length) bubble.webContents.send("notice-bubble-show", presentationPayload());
    });

    if (typeof ctx.guardAlwaysOnTop === "function") ctx.guardAlwaysOnTop(bubble);
    return bubble;
  }

  function computeBounds(target = null) {
    if (!ctx.win || ctx.win.isDestroyed()) return null;
    const petBounds = target && target.petBounds ? target.petBounds : ctx.getPetWindowBounds();
    const wa = target && target.workArea ? target.workArea : getTargetWorkArea(petBounds);
    const scale = target && Number.isFinite(target.scale) ? target.scale : getTextScale(wa);
    const height = Math.min(
      scaleHeight(measuredHeight || estimateHeight(), scale),
      maxWindowHeight(wa)
    );
    const anchorRect = ctx.bubbleFollowPet ? getAnchorRect(petBounds) : null;
    const hitRect = ctx.bubbleFollowPet ? ctx.getHitRectScreen(petBounds) : null;

    return computeUpdateBubbleBounds({
      bubbleFollowPet: ctx.bubbleFollowPet,
      followPreference: ctx.bubbleFollowPreference,
      fixedCorner: ctx.bubbleFixedCorner,
      width: Math.min(scaleWidth(WIDTH, scale), Math.floor(wa.width * MAX_WORK_AREA_WIDTH_RATIO)),
      edgeMargin: Math.round(EDGE_MARGIN * scale),
      gap: Math.round(GAP * scale),
      height,
      reservedHeight: 0,
      hudReservedOffset: 0,
      workArea: wa,
      petBounds,
      anchorRect,
      hitRect,
      avoidRects: getAvoidRects(),
    });
  }

  function repositionNoticeBubble() {
    if (!bubble || bubble.isDestroyed()) return;
    // Resolve the scale ONCE and feed the same value to both the zoom
    // injection and the bounds math (see session-hud syncSessionHud).
    const petBounds = ctx.getPetWindowBounds();
    const workArea = getTargetWorkArea(petBounds);
    const scale = getTextScale(workArea);
    applyZoomToWindow(bubble, scale);
    const bounds = computeBounds({ petBounds, workArea, scale });
    if (!bounds) return;
    // Idempotent on purpose: see appliedBounds. A refreshed card re-reports its
    // height on every tick, and moving a window that is already in the right
    // place is pure flicker.
    if (appliedBounds
      && appliedBounds.x === bounds.x
      && appliedBounds.y === bounds.y
      && appliedBounds.width === bounds.width
      && appliedBounds.height === bounds.height) {
      return;
    }
    appliedBounds = bounds;
    bubble.setBounds(bounds);
  }

  function showPresentationWindow() {
    if (!pageReady()) return false;
    bubble.showInactive();
    keepOutOfTaskbar(bubble);
    if (isMac) deferMacFloatingVisibility(ctx, bubble);
    else if (typeof ctx.reapplyMacVisibility === "function") ctx.reapplyMacVisibility();
    return true;
  }

  function restoreSuspendedPresentation(hiddenOverride) {
    if (
      fullscreenSuppressed
      || !visibilityRestorePending
      || !bubble
      || bubble.isDestroyed()
      || notices.length === 0
    ) return false;
    const hidden = typeof hiddenOverride === "boolean" ? hiddenOverride : ctx.petHidden;
    if (hidden) return false;
    if (!pageReady()) return false;

    visibilityRestorePending = false;
    // Position first: the payload carries the tail side, and that is read off
    // the bubble's own bounds.
    repositionNoticeBubble();
    bubble.webContents.send("notice-bubble-show", presentationPayload());
    const shown = syncVisibility(hiddenOverride);
    notifyOrbitGeometryChanged();
    return shown;
  }

  function syncVisibility(hiddenOverride) {
    if (!bubble || bubble.isDestroyed()) return false;
    const hidden = fullscreenSuppressed
      || (typeof hiddenOverride === "boolean" ? hiddenOverride : ctx.petHidden);
    if (hidden) {
      bubble.hide();
      return false;
    }
    if (visibilityRestorePending) {
      return restoreSuspendedPresentation(hiddenOverride);
    }
    if (!presentationActive) return false;
    return showPresentationWindow();
  }

  function showNoticeBubble(next) {
    if (Array.isArray(next)) notices = next.slice();
    if (notices.length === 0) {
      hideNoticeBubble();
      return false;
    }
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    presentationActive = true;
    visibilityRestorePending = fullscreenSuppressed;
    const win = ensureBubble();

    const send = () => {
      measuredHeight = 0;
      repositionNoticeBubble();
      if (win && !win.isDestroyed()) {
        win.webContents.send("notice-bubble-show", presentationPayload());
        syncVisibility();
        notifyOrbitGeometryChanged();
      }
    };

    if (!pageReady()) {
      win.webContents.once("did-finish-load", send);
    } else {
      send();
    }
    return true;
  }

  function hideNoticeBubble() {
    if (!bubble || bubble.isDestroyed()) return;
    presentationActive = false;
    visibilityRestorePending = false;
    bubble.webContents.send("notice-bubble-hide");
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (bubble && !bubble.isDestroyed()) {
        bubble.hide();
        notifyOrbitGeometryChanged();
      }
    }, HIDE_ANIMATION_MS);
  }

  function suspendActivePresentation() {
    if (!bubble || bubble.isDestroyed() || notices.length === 0) return true;
    visibilityRestorePending = presentationActive;
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    bubble.hide();
    notifyOrbitGeometryChanged();
    return true;
  }

  function suspendForPetHidden() {
    return suspendActivePresentation();
  }

  function suspendForFullscreen() {
    if (fullscreenSuppressed) return false;
    fullscreenSuppressed = true;
    return suspendActivePresentation();
  }

  function resumeFromFullscreen() {
    if (!fullscreenSuppressed) return false;
    fullscreenSuppressed = false;
    if (!visibilityRestorePending || !bubble || bubble.isDestroyed() || notices.length === 0) {
      visibilityRestorePending = false;
      return true;
    }
    // A manual hide is a second, independent layer: keep the suspended
    // presentation until Show Pet calls syncVisibility(false).
    if (!ctx.petHidden) restoreSuspendedPresentation();
    return true;
  }

  function handleNoticeBubbleHeight(event, height) {
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    if (!bubble || senderWin !== bubble) return;
    if (typeof height === "number" && height > 0) {
      const next = Math.ceil(height);
      // A refreshed card reports the same height every tick. Re-running the
      // reposition for an unchanged height is what made a 1 Hz countdown
      // flicker; the geometry only needs revisiting when it actually changes.
      if (next === measuredHeight) return;
      measuredHeight = next;
      repositionNoticeBubble();
      notifyOrbitGeometryChanged();
      // The measured height can move the bubble from below the pet to above it
      // (or across); the tail would keep pointing at the old side until the
      // next snapshot, so a changed side re-sends the presentation now.
      if (currentTailSide() !== lastSentTailSide) refreshPresentation();
    }
  }

  // Renderer → main dismissal. Only the bubble's own renderer may retire a
  // notice, and a store without remove() is a no-op rather than a throw.
  function handleNoticeBubbleDismiss(event, id) {
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    if (!bubble || senderWin !== bubble) return false;
    if (typeof id !== "string" || id.length === 0) return false;
    const store = ctx.noticeStore;
    if (!store || typeof store.remove !== "function") return false;
    try {
      store.remove(id);
    } catch {
      return false;
    }
    return true;
  }

  // Renderer → main copy (right-click on a card). The page sends only the id:
  // the text comes from the store, never from the renderer, and main owns the
  // clipboard, so the page needs no clipboard access and no focus.
  function handleNoticeBubbleCopy(event, id) {
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    if (!bubble || senderWin !== bubble) return false;
    if (typeof id !== "string" || id.length === 0) return false;
    const notice = notices.find((entry) => entry && entry.id === id);
    const text = noticeCopyText(notice);
    if (!text) return false;
    try {
      const write = typeof ctx.writeClipboard === "function"
        ? ctx.writeClipboard
        : (value) => require("electron").clipboard.writeText(value);
      write(text);
    } catch {
      return false;
    }
    return true;
  }

  // The expanded chart window owns the actual presentation; this only records
  // the request and hands it on. A throwing consumer must never take the IPC
  // handler (and with it the recorded id) down.
  function handleNoticeBubbleExpand(event, id) {
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    if (!bubble || senderWin !== bubble) return false;
    if (typeof id !== "string" || id.length === 0) return false;
    expandedNoticeId = id;
    if (typeof ctx.onNoticeExpand === "function") {
      try {
        ctx.onNoticeExpand(id);
      } catch {}
    }
    return true;
  }

  function shouldHold(fresh) {
    if (fresh.length === 0 || typeof ctx.shouldHoldNewNotices !== "function") return false;
    try {
      return ctx.shouldHoldNewNotices(fresh) === true;
    } catch {
      return false;
    }
  }

  // Store snapshots drive the window: a new snapshot re-renders the shown
  // stack, an empty one hides it. TTL expiry is the store's job.
  function handleNotices(snapshot) {
    allNotices = Array.isArray(snapshot) ? snapshot.filter((n) => n && typeof n.id === "string") : [];
    const ids = new Set(allNotices.map((n) => n.id));
    for (const id of heldIds) if (!ids.has(id)) heldIds.delete(id);
    const fresh = seenIds ? allNotices.filter((n) => !seenIds.has(n.id)) : [];
    seenIds = ids;
    if (shouldHold(fresh)) for (const n of fresh) heldIds.add(n.id);
    notices = allNotices.filter((n) => !heldIds.has(n.id));
    if (notices.length === 0) {
      hideNoticeBubble();
      return;
    }
    showNoticeBubble();
  }

  // Shows every card that was held back for the sign. Returns how many.
  function revealHeldNotices() {
    if (heldIds.size === 0) return 0;
    const count = heldIds.size;
    heldIds.clear();
    notices = allNotices.slice();
    if (notices.length > 0) showNoticeBubble();
    return count;
  }

  function cleanup() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
    if (unsubscribeStore) {
      try { unsubscribeStore(); } catch {}
      unsubscribeStore = null;
    }
    if (bubble && !bubble.isDestroyed()) bubble.destroy();
    bubble = null;
    presentationActive = false;
    visibilityRestorePending = false;
    fullscreenSuppressed = false;
    measuredHeight = 0;
    lastSentTailSide = null;
    expandedNoticeId = null;
    heldIds.clear();
    allNotices = [];
    seenIds = null;
  }

  if (ctx.noticeStore && typeof ctx.noticeStore.subscribe === "function") {
    unsubscribeStore = ctx.noticeStore.subscribe(handleNotices);
    const initial = typeof ctx.noticeStore.list === "function" ? ctx.noticeStore.list() : [];
    // The store does not replay on subscribe: what is in it now is the
    // baseline, so the first notice pushed after this counts as new.
    const baseline = Array.isArray(initial) ? initial : [];
    seenIds = new Set(baseline.filter((n) => n && typeof n.id === "string").map((n) => n.id));
    if (baseline.length) handleNotices(baseline);
  }

  return {
    showNoticeBubble,
    hideNoticeBubble,
    repositionNoticeBubble,
    refreshPresentation,
    handleNoticeBubbleHeight,
    handleNoticeBubbleDismiss,
    handleNoticeBubbleExpand,
    handleNoticeBubbleCopy,
    syncVisibility,
    revealHeldNotices,
    hasHeldNotices: () => heldIds.size > 0,
    suspendForPetHidden,
    suspendForFullscreen,
    resumeFromFullscreen,
    cleanup,
    getBubbleWindow: () => bubble,
    getExpandedNoticeId: () => expandedNoticeId,
  };
};

module.exports.registerNoticeBubbleIpc = registerNoticeBubbleIpc;

module.exports.__test = {
  estimateNoticeStackHeight,
  noticeCopyText,
};
