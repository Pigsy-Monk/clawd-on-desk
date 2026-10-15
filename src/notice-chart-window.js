"use strict";

// The expanded chart window: one agent-pushed PNG, shown large.
//
// Opened by clicking a trend card on the notice stack (notice-bubble.js hands
// the id over through ctx.onNoticeExpand). Deliberately a separate window from
// the stack: the stack is a column of small cards that has to follow the pet
// and re-measure on every notice, while this is a single fixed picture that is
// placed once per open.
//
// It is created lazily on the first open and hidden rather than destroyed on
// close, exactly like the notice bubble, so reopening is cheap.

const { BrowserWindow } = require("electron");
const path = require("path");
const { keepOutOfTaskbar } = require("./taskbar");
const { clampTextScale, scaleWidth, scaleHeight, applyZoomToWindow } = require("./text-scale");
const { computeUpdateBubbleBounds } = require("./update-bubble");

const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const WIN_TOPMOST_LEVEL = "pop-up-menu";
const LINUX_WINDOW_TYPE = "toolbar";
// CSS px. The comfortable width a chart is shown at. A source image narrower
// than this is shown at its own size instead — the window never blows a chart
// up past its own pixels.
const TARGET_WIDTH = 900;
// The window never outgrows this share of the work area, in either axis.
const MAX_WORK_AREA_RATIO = 0.85;
// The card's own chrome — title line, paddings, the gap above the image — on
// top of the image, CSS px. Only an estimate: the renderer measures the real
// card once the image is in and reports it back.
const CARD_CHROME_HEIGHT = 72;
// Opened at this height when the image's natural size is not known yet; the
// renderer's first height report replaces it.
const PLACEHOLDER_HEIGHT = 640;
const EDGE_MARGIN = 8;
const GAP = 6;
const MAC_FLOATING_TOPMOST_DELAY_MS = 120;
// The renderer's hide animation must finish before the window is hidden.
const HIDE_ANIMATION_MS = 200;
// The 8-byte PNG signature: 89 50 4E 47 0D 0A 1A 0A.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// IHDR is the first chunk and carries the image's size: 8 signature bytes,
// 4 length bytes, 4 type bytes, then width and height as big-endian uint32s.
const IHDR_BYTES = 24;
// Enough base64 to cover IHDR_BYTES (4 characters per 3 bytes) with slack.
const IHDR_BASE64_CHARS = 64;

function requiredDependency(value, name, owner) {
  if (!value) throw new Error(`${owner} requires ${name}`);
  return value;
}

function registerNoticeChartIpc(options = {}) {
  const ipcMain = requiredDependency(options.ipcMain, "ipcMain", "registerNoticeChartIpc");
  const noticeChart = requiredDependency(options.noticeChart, "noticeChart", "registerNoticeChartIpc");
  requiredDependency(noticeChart.handleNoticeChartHeight, "noticeChart.handleNoticeChartHeight", "registerNoticeChartIpc");
  requiredDependency(noticeChart.handleNoticeChartClose, "noticeChart.handleNoticeChartClose", "registerNoticeChartIpc");
  const disposers = [];

  function on(channel, listener) {
    ipcMain.on(channel, listener);
    disposers.push(() => ipcMain.removeListener(channel, listener));
  }

  on("notice-chart-height", (event, height) => noticeChart.handleNoticeChartHeight(event, height));
  on("notice-chart-close", (event) => noticeChart.handleNoticeChartClose(event));

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

// Natural pixel size from the PNG's IHDR chunk, or null when it cannot be
// read. The store has already verified these bytes are a real PNG under its
// byte cap, so this only has to read the header it guarantees is there —
// anything unexpected degrades to "size unknown" rather than throwing.
function readPngSize(image) {
  if (!image || typeof image.data !== "string") return null;
  let header;
  try {
    header = Buffer.from(image.data.slice(0, IHDR_BASE64_CHARS), "base64");
  } catch {
    return null;
  }
  if (header.length < IHDR_BYTES) return null;
  if (!header.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  if (header.readUInt32BE(8) !== 13) return null;
  if (header.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height };
}

function maxWindowWidth(workArea) {
  return Math.max(1, Math.floor(workArea.width * MAX_WORK_AREA_RATIO));
}

function maxWindowHeight(workArea) {
  return Math.max(1, Math.floor(workArea.height * MAX_WORK_AREA_RATIO));
}

// Window size in DIP for one chart. The width is the comfortable target,
// clamped down to the image's own pixels (never upscaled) and to the work
// area; the height follows from the image's aspect ratio plus the card
// chrome. When even that would outgrow the display the width is squeezed so
// the whole chart still fits, rather than letting the image be cropped.
// A chart whose size is not known yet opens at the placeholder height.
function computeChartWindowSize({ natural, workArea, scale }) {
  const naturalWidth = natural && natural.width > 0 ? natural.width : null;
  const naturalHeight = natural && natural.height > 0 ? natural.height : null;
  const chrome = scaleHeight(CARD_CHROME_HEIGHT, scale);
  const maxWidth = maxWindowWidth(workArea);
  const maxHeight = maxWindowHeight(workArea);

  let width = Math.min(scaleWidth(TARGET_WIDTH, scale), maxWidth);
  if (naturalWidth) width = Math.min(width, naturalWidth);

  let height;
  if (naturalWidth && naturalHeight) {
    height = Math.ceil(width * (naturalHeight / naturalWidth)) + chrome;
  } else {
    height = scaleHeight(PLACEHOLDER_HEIGHT, scale);
  }

  if (height > maxHeight) {
    const room = maxHeight - chrome;
    if (naturalWidth && naturalHeight && room > 0) {
      width = Math.min(width, Math.max(1, Math.floor(room * (naturalWidth / naturalHeight))));
    }
    height = maxHeight;
  }

  return { width: Math.max(1, width), height: Math.max(1, height) };
}

module.exports = function initNoticeChartWindow(ctx) {
  let bubble = null;
  // CSS px, as reported by the renderer; converted to DIP where consumed.
  let measuredHeight = 0;
  // Natural pixel size of the chart on screen; null until it is known.
  let naturalSize = null;
  // The payload the renderer is showing, kept so a re-show after a pet-hide or
  // fullscreen pause does not need the notice to come back through the store.
  let activePayload = null;
  let activeNoticeId = null;
  let presentationActive = false;
  let fullscreenSuppressed = false;
  // A presentation paused by fullscreen or manual pet hiding stays pending
  // until both visibility layers are clear and the renderer is ready.
  let visibilityRestorePending = false;
  let hideTimer = null;
  let unsubscribeStore = null;

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
    const cx = petBounds.x + petBounds.width / 2;
    const cy = petBounds.y + petBounds.height / 2;
    return ctx.getNearestWorkArea(cx, cy);
  }

  // Follow rect for the follow-pet path: the pet's tight sprite rect, with the
  // same getters the other bubbles use so main.js needs no extra wiring.
  function getAnchorRect(petBounds) {
    const getter = typeof ctx.getNoticeChartAnchorRect === "function"
      ? ctx.getNoticeChartAnchorRect
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

  // The chart is opened from the notice stack, so it dodges that stack and
  // every other floating surface the way the stack itself does.
  function getAvoidRects() {
    const rects = [];
    for (const getterName of [
      "getPermissionBubbleBounds",
      "getSessionHudBounds",
      "getUpdateBubbleBounds",
      "getNoticeBubbleBounds",
    ]) {
      if (typeof ctx[getterName] !== "function") continue;
      try {
        pushRects(rects, ctx[getterName]());
      } catch {}
    }
    return rects;
  }

  function ensureBubble() {
    if (bubble && !bubble.isDestroyed()) return bubble;

    const petBounds = ctx.getPetWindowBounds();
    const workArea = getTargetWorkArea(petBounds);
    const scale = getTextScale(workArea);
    const size = computeChartWindowSize({ natural: naturalSize, workArea, scale });
    bubble = new BrowserWindow({
      width: size.width,
      height: size.height,
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
        preload: path.join(__dirname, "preload-notice-chart.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    if (isWin) bubble.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);

    // The two closes that need input this window never receives: a
    // focusable:false window is not activated by a click and never holds
    // keyboard focus, so neither its blur nor a key event reaches it on the
    // current window options. Both are wired anyway — they cost nothing and
    // start working the moment the window is created focusable — while the
    // guaranteed closes are the × button and the notice leaving the store.
    bubble.on("blur", () => hideNoticeChart());
    bubble.webContents.on("before-input-event", (event, input) => {
      if (!input || input.type !== "keyDown" || input.key !== "Escape") return;
      event.preventDefault();
      hideNoticeChart();
    });

    bubble.loadFile(path.join(__dirname, "notice-chart.html"));
    bubble.on("closed", () => {
      bubble = null;
      measuredHeight = 0;
      presentationActive = false;
      notifyOrbitGeometryChanged();
    });

    bubble.webContents.once("did-finish-load", () => {
      // Explicit even though same-origin propagation usually covers it — a
      // stale partition-persisted factor must never win over prefs.
      const petBounds = ctx.getPetWindowBounds();
      applyZoomToWindow(bubble, getTextScale(getTargetWorkArea(petBounds)));
      if (activePayload) bubble.webContents.send("notice-chart-show", activePayload);
    });

    if (typeof ctx.guardAlwaysOnTop === "function") ctx.guardAlwaysOnTop(bubble);
    return bubble;
  }

  function computeBounds(target = null) {
    if (!ctx.win || ctx.win.isDestroyed()) return null;
    const petBounds = target && target.petBounds ? target.petBounds : ctx.getPetWindowBounds();
    const wa = target && target.workArea ? target.workArea : getTargetWorkArea(petBounds);
    const scale = target && Number.isFinite(target.scale) ? target.scale : getTextScale(wa);
    const size = computeChartWindowSize({ natural: naturalSize, workArea: wa, scale });
    const height = Math.min(
      measuredHeight ? scaleHeight(measuredHeight, scale) : size.height,
      maxWindowHeight(wa)
    );
    const anchorRect = ctx.bubbleFollowPet ? getAnchorRect(petBounds) : null;
    const hitRect = ctx.bubbleFollowPet && typeof ctx.getHitRectScreen === "function"
      ? ctx.getHitRectScreen(petBounds)
      : null;

    return computeUpdateBubbleBounds({
      bubbleFollowPet: ctx.bubbleFollowPet,
      followPreference: ctx.bubbleFollowPreference,
      fixedCorner: ctx.bubbleFixedCorner,
      width: Math.min(size.width, maxWindowWidth(wa)),
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

  function repositionNoticeChart() {
    if (!bubble || bubble.isDestroyed()) return;
    // Resolve the scale ONCE and feed the same value to both the zoom
    // injection and the bounds math (see session-hud syncSessionHud).
    const petBounds = ctx.getPetWindowBounds();
    const workArea = getTargetWorkArea(petBounds);
    const scale = getTextScale(workArea);
    applyZoomToWindow(bubble, scale);
    const bounds = computeBounds({ petBounds, workArea, scale });
    if (bounds) bubble.setBounds(bounds);
  }

  function showPresentationWindow() {
    if (bubble.webContents.isLoading()) return false;
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
      || !activePayload
    ) return false;
    const hidden = typeof hiddenOverride === "boolean" ? hiddenOverride : ctx.petHidden;
    if (hidden) return false;
    if (bubble.webContents.isLoading()) return false;

    visibilityRestorePending = false;
    bubble.webContents.send("notice-chart-show", activePayload);
    repositionNoticeChart();
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

  // The renderer only ever gets the four fields it draws: the title, the level
  // that colours the bar, and the PNG. Nothing else about the notice is
  // forwarded, and the image is already a verified PNG from the store.
  function toPayload(notice) {
    const image = notice && notice.image && typeof notice.image === "object" ? notice.image : null;
    if (!image || typeof image.data !== "string" || !image.data) return null;
    return {
      id: typeof notice.id === "string" ? notice.id : "",
      title: typeof notice.title === "string" ? notice.title : "",
      level: typeof notice.level === "string" ? notice.level : "info",
      image: { mime: image.mime, data: image.data },
    };
  }

  function showNoticeChart(notice) {
    const payload = toPayload(notice);
    // A notice without a verified PNG has no chart to expand; the stack's
    // sparkline is the whole of it.
    if (!payload) return false;
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    activePayload = payload;
    activeNoticeId = payload.id;
    naturalSize = readPngSize(payload.image);
    // The previous chart's measurement describes the previous image.
    measuredHeight = 0;
    presentationActive = true;
    visibilityRestorePending = fullscreenSuppressed;
    const win = ensureBubble();

    const send = () => {
      measuredHeight = 0;
      repositionNoticeChart();
      if (win && !win.isDestroyed()) {
        win.webContents.send("notice-chart-show", activePayload);
        syncVisibility();
        notifyOrbitGeometryChanged();
      }
    };

    if (win.webContents.isLoading()) {
      win.webContents.once("did-finish-load", send);
    } else {
      send();
    }
    return true;
  }

  function hideNoticeChart() {
    if (!bubble || bubble.isDestroyed()) return false;
    presentationActive = false;
    visibilityRestorePending = false;
    activeNoticeId = null;
    bubble.webContents.send("notice-chart-hide");
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (bubble && !bubble.isDestroyed()) {
        bubble.hide();
        notifyOrbitGeometryChanged();
      }
    }, HIDE_ANIMATION_MS);
    return true;
  }

  function suspendActivePresentation() {
    if (!bubble || bubble.isDestroyed() || !activePayload) return true;
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
    if (!visibilityRestorePending || !bubble || bubble.isDestroyed() || !activePayload) {
      visibilityRestorePending = false;
      return true;
    }
    // A manual hide is a second, independent layer: keep the suspended
    // presentation until Show Pet calls syncVisibility(false).
    if (!ctx.petHidden) restoreSuspendedPresentation();
    return true;
  }

  function handleNoticeChartHeight(event, height) {
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    if (!bubble || senderWin !== bubble) return;
    if (typeof height === "number" && height > 0) {
      measuredHeight = Math.ceil(height);
      repositionNoticeChart();
      notifyOrbitGeometryChanged();
    }
  }

  // Renderer → main close: the × button, a click on the card's own margin, or
  // Escape when the window ever gets it. Only this window's own renderer may
  // close it.
  function handleNoticeChartClose(event) {
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    if (!bubble || senderWin !== bubble) return false;
    return hideNoticeChart();
  }

  // The shown chart follows the store: an expired or dismissed notice takes its
  // window down with it. Any other snapshot change is none of this window's
  // business.
  function handleNotices(snapshot) {
    if (!activeNoticeId) return;
    const list = Array.isArray(snapshot) ? snapshot : [];
    if (list.some((notice) => notice && notice.id === activeNoticeId)) return;
    hideNoticeChart();
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
    naturalSize = null;
    activePayload = null;
    activeNoticeId = null;
  }

  if (ctx.noticeStore && typeof ctx.noticeStore.subscribe === "function") {
    unsubscribeStore = ctx.noticeStore.subscribe(handleNotices);
  }

  return {
    showNoticeChart,
    hideNoticeChart,
    repositionNoticeChart,
    handleNoticeChartHeight,
    handleNoticeChartClose,
    syncVisibility,
    suspendForPetHidden,
    suspendForFullscreen,
    resumeFromFullscreen,
    cleanup,
    getBubbleWindow: () => bubble,
  };
};

module.exports.registerNoticeChartIpc = registerNoticeChartIpc;

module.exports.__test = {
  readPngSize,
  computeChartWindowSize,
};
