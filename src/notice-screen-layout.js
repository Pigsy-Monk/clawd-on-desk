// Pure geometry and timing for the notice sign: a theme's "notice-screen"
// reaction, where the notice title scrolls across a board the pet shows. The
// constants below are clawd's sign (a small chalkboard on a stick, passed from
// hand to hand); a theme can declare its own board with `reactions
// ["notice-screen"].sign`, which resolveSign() validates into the same shape.
//
// Everything here is in the SVG's own viewBox units and plain milliseconds so
// the same functions drive the render window (renderer.js loads this file via
// index.html), the main-process hit tests (notice-screen-runtime.js) and the
// unit tests. No DOM, no timers, no Electron.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.noticeScreenLayout = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // The chalkboard in clawd-notice-screen.svg while the right hand holds it
  // (wooden frame included), absolute viewBox units. Keep in step with the
  // asset.
  const SCREEN_RECT = Object.freeze({ x: 4.6, y: -9, w: 20, h: 9.6 });
  // The left hand holds the stick 14.2 units further left; the whole sign
  // (#notice-sign-car) moves with it.
  const LEFT_HAND_DX = -14.2;
  // The text line inside the slate: a padding in from the clip's left edge,
  // overflowing once it runs past the same padding before the right edge.
  const LINE_START_X = 6.4;
  const LINE_END_X = 22.8;
  const LINE_BASELINE_Y = -2.6;
  const PROMPT_FONT_SIZE = 3.6;
  const TITLE_FONT_SIZE = 3.6;
  const PROMPT_GAP = 0.7;

  const LEVELS = Object.freeze({
    info: Object.freeze({ prompt: ">", color: "#7FB2FF" }),
    success: Object.freeze({ prompt: "OK", color: "#6EE19A" }),
    warn: Object.freeze({ prompt: "!", color: "#FFC857" }),
    error: Object.freeze({ prompt: "✗", color: "#FF6B6B" }),
  });

  // Hand to hand: the sign rests in one hand, then arcs over the head into the
  // other. Hovering holds it where it is.
  const TOSS_HOLD_MS = 4500;
  const TOSS_MS = 650;
  const TOSS_LIFT = 3;

  // Marquee: hold, scroll until the end shows, hold, jump back; three passes.
  const MARQUEE_START_HOLD_MS = 800;
  const MARQUEE_END_HOLD_MS = 900;
  const MARQUEE_MS_PER_UNIT = 260;
  const MARQUEE_PASSES = 3;
  // Dwell: as long as the passes take, inside [3 s, 15 s]; a line that fits
  // has nothing to wait for and stays a fixed 4 s.
  const DWELL_MIN_MS = 3000;
  const DWELL_MAX_MS = 15000;
  const DWELL_FIT_MS = 4000;

  // Hover zoom. The board is wide, so the visible window caps the wheel well
  // below MAX_ZOOM_SCALE (about 1.7× in a square window).
  const HOVER_ZOOM_SCALE = 1.5;
  const MAX_ZOOM_SCALE = 2;
  const MIN_ZOOM_SCALE = 1;
  const ZOOM_STEP = 0.25;
  const ZOOM_TRANSITION_MS = 180;
  const ZOOM_LEAVE_DELAY_MS = 300;
  // One wheel notch (deltaMode 0) is ~100 px on Windows/Chromium; finer
  // trackpad deltas accumulate until they add up to a notch.
  const WHEEL_NOTCH_PX = 100;

  const COPY_FEEDBACK_MS = 1200;
  const COPY_FEEDBACK_TEXT = "已复制 ✓";
  const TITLE_COLOR = "#F2F2E6";

  function isFiniteRect(rect) {
    return !!rect && [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite);
  }

  // clawd's sign, in the shape resolveSign() returns. `leftHandDx` is null for
  // a board that stays where it is (no hand-to-hand toss).
  const DEFAULT_SIGN = Object.freeze({
    screen: SCREEN_RECT,
    line: Object.freeze({
      startX: LINE_START_X,
      endX: LINE_END_X,
      baselineY: LINE_BASELINE_Y,
      promptFontSize: PROMPT_FONT_SIZE,
      titleFontSize: TITLE_FONT_SIZE,
      promptGap: PROMPT_GAP,
      align: "start",
    }),
    titleColor: TITLE_COLOR,
    feedbackColor: LEVELS.success.color,
    levels: LEVELS,
    leftHandDx: LEFT_HAND_DX,
    tossLift: TOSS_LIFT,
    // The scroll speed is set per title em, so a bigger board reads as fast.
    marqueeMsPerUnit: MARQUEE_MS_PER_UNIT,
  });

  const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  const SIGN_EXTENT = 10000;
  const SIGN_FONT_MAX = 1000;
  const LEVEL_GLYPH_MAX = 4;

  function finiteIn(value, min, max) {
    return Number.isFinite(value) && value >= min && value <= max;
  }

  function readSignRect(value) {
    if (!value || typeof value !== "object") return null;
    const rect = { x: value.x, y: value.y, w: value.w, h: value.h };
    if (!finiteIn(rect.x, -SIGN_EXTENT, SIGN_EXTENT) || !finiteIn(rect.y, -SIGN_EXTENT, SIGN_EXTENT)) return null;
    if (!finiteIn(rect.w, 0, SIGN_EXTENT) || !finiteIn(rect.h, 0, SIGN_EXTENT) || rect.w <= 0 || rect.h <= 0) return null;
    return Object.freeze(rect);
  }

  function readSignLine(value) {
    if (!value || typeof value !== "object") return null;
    const { startX, endX, baselineY, titleFontSize } = value;
    if (!finiteIn(startX, -SIGN_EXTENT, SIGN_EXTENT) || !finiteIn(endX, -SIGN_EXTENT, SIGN_EXTENT) || endX <= startX) return null;
    if (!finiteIn(baselineY, -SIGN_EXTENT, SIGN_EXTENT)) return null;
    if (!finiteIn(titleFontSize, 0, SIGN_FONT_MAX) || titleFontSize <= 0) return null;
    const promptFontSize = finiteIn(value.promptFontSize, 0, SIGN_FONT_MAX) && value.promptFontSize > 0
      ? value.promptFontSize
      : titleFontSize;
    const promptGap = finiteIn(value.promptGap, 0, SIGN_EXTENT)
      ? value.promptGap
      : PROMPT_GAP * (titleFontSize / TITLE_FONT_SIZE);
    return Object.freeze({
      startX,
      endX,
      baselineY,
      promptFontSize,
      titleFontSize,
      promptGap,
      align: value.align === "center" ? "center" : "start",
    });
  }

  function readColor(value, fallback) {
    return typeof value === "string" && HEX_COLOR_RE.test(value) ? value : fallback;
  }

  function readLevels(value) {
    const out = {};
    for (const name of Object.keys(LEVELS)) {
      const entry = value && typeof value === "object" && value[name] && typeof value[name] === "object"
        ? value[name]
        : {};
      const glyph = typeof entry.glyph === "string" && entry.glyph.length > 0 && entry.glyph.length <= LEVEL_GLYPH_MAX
        ? entry.glyph
        : LEVELS[name].prompt;
      out[name] = Object.freeze({
        prompt: glyph,
        color: readColor(entry.color, LEVELS[name].color),
      });
    }
    return Object.freeze(out);
  }

  // A theme's `reactions["notice-screen"].sign`, validated: the board rect
  // and the text line are taken together or not at all (a board from one and a
  // line from the other would put the text off the board), so anything
  // malformed falls back to clawd's sign as a whole. Theme-supplied strings
  // only ever become colours or a short level glyph.
  function resolveSign(raw) {
    if (!raw || typeof raw !== "object") return DEFAULT_SIGN;
    const screen = readSignRect(raw.screen);
    const line = readSignLine(raw.line);
    if (!screen || !line) return DEFAULT_SIGN;
    const leftHandDx = finiteIn(raw.leftHandDx, -SIGN_EXTENT, SIGN_EXTENT) && raw.leftHandDx !== 0
      ? raw.leftHandDx
      : null;
    const scale = line.titleFontSize / TITLE_FONT_SIZE;
    return Object.freeze({
      screen,
      line,
      titleColor: readColor(raw.titleColor, TITLE_COLOR),
      feedbackColor: readColor(raw.feedbackColor, LEVELS.success.color),
      levels: readLevels(raw.levels),
      leftHandDx,
      tossLift: TOSS_LIFT * (screen.h / SCREEN_RECT.h),
      marqueeMsPerUnit: MARQUEE_MS_PER_UNIT / scale,
    });
  }

  function resolveLevel(level, sign = DEFAULT_SIGN) {
    const levels = (sign && sign.levels) || LEVELS;
    return Object.prototype.hasOwnProperty.call(levels, level) ? levels[level] : levels.info;
  }

  // A pre-measurement stand-in for getComputedTextLength(): CJK and other
  // wide glyphs take about one em, everything else a bit over half. Only used
  // when the real measurement is unavailable (detached node, zero length).
  function estimateTextWidth(text, fontSize) {
    if (typeof text !== "string" || !text || !Number.isFinite(fontSize)) return 0;
    let ems = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0);
      const wide = code >= 0x1100 && (
        code <= 0x115f
        || (code >= 0x2e80 && code <= 0xa4cf)
        || (code >= 0xac00 && code <= 0xd7a3)
        || (code >= 0xf900 && code <= 0xfaff)
        || (code >= 0xfe30 && code <= 0xfe4f)
        || (code >= 0xff00 && code <= 0xff60)
        || (code >= 0xffe0 && code <= 0xffe6)
        || code >= 0x1f300
      );
      ems += wide ? 1 : 0.6;
    }
    return ems * fontSize;
  }

  // Horizontal layout of one line given the measured prompt and title widths:
  // where the prompt and the title go, and how far the whole line overflows
  // the space the board gives it. A sign with `align: "center"` centres a line
  // that fits; a line that overflows always starts at the left so it can
  // scroll.
  function layoutLine(promptWidth, titleWidth, sign = DEFAULT_SIGN) {
    const line = (sign && sign.line) || DEFAULT_SIGN.line;
    const prompt = Number.isFinite(promptWidth) && promptWidth > 0 ? promptWidth : 0;
    const title = Number.isFinite(titleWidth) && titleWidth > 0 ? titleWidth : 0;
    const width = prompt + (prompt > 0 ? line.promptGap : 0) + title;
    const room = line.endX - line.startX;
    const overflow = Math.max(0, width - room);
    const startX = line.align === "center" && overflow === 0
      ? line.startX + (room - width) / 2
      : line.startX;
    const titleX = startX + prompt + (prompt > 0 ? line.promptGap : 0);
    return {
      promptX: startX,
      titleX,
      endX: titleX + title,
      overflow,
    };
  }

  function buildMarqueePlan(overflow, sign = DEFAULT_SIGN) {
    const units = Number.isFinite(overflow) && overflow > 0.01 ? overflow : 0;
    if (units === 0) {
      return { overflow: 0, scrollMs: 0, passMs: 0, passes: 0, totalMs: 0 };
    }
    const msPerUnit = sign && Number.isFinite(sign.marqueeMsPerUnit) && sign.marqueeMsPerUnit > 0
      ? sign.marqueeMsPerUnit
      : MARQUEE_MS_PER_UNIT;
    const scrollMs = Math.round(units * msPerUnit);
    const passMs = MARQUEE_START_HOLD_MS + scrollMs + MARQUEE_END_HOLD_MS;
    return {
      overflow: units,
      scrollMs,
      passMs,
      passes: MARQUEE_PASSES,
      totalMs: passMs * MARQUEE_PASSES,
    };
  }

  // Horizontal shift of the line (≤ 0) after `elapsedMs` of scrolling.
  // Reduced motion rests at the start of the line; so does a finished plan,
  // unless `loop` keeps the passes coming (the screen is being hovered).
  function marqueeOffsetAt(plan, elapsedMs, options = {}) {
    if (!plan || !(plan.overflow > 0) || options.reducedMotion === true) return 0;
    const t = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
    if (t >= plan.totalMs && options.loop !== true) return 0;
    const within = t % plan.passMs;
    if (within < MARQUEE_START_HOLD_MS) return 0;
    const scrolled = within - MARQUEE_START_HOLD_MS;
    if (scrolled >= plan.scrollMs) return -plan.overflow;
    return -plan.overflow * (scrolled / plan.scrollMs);
  }

  function computeDwellMs(plan) {
    if (!plan || !(plan.overflow > 0)) return DWELL_FIT_MS;
    return Math.min(DWELL_MAX_MS, Math.max(DWELL_MIN_MS, plan.totalMs));
  }

  // The part of the viewBox actually visible in the render window. The media
  // element is laid out larger than the window (objectScale / layout ratios),
  // so the window shows a crop; the SVG is fitted into the element with the
  // default preserveAspectRatio (xMidYMid meet).
  function computeVisibleViewBoxRect(elementRect, viewport, viewBox) {
    if (!elementRect || !viewport || !viewBox) return null;
    const ew = elementRect.width;
    const eh = elementRect.height;
    if (!(ew > 0) || !(eh > 0) || !(viewBox.width > 0) || !(viewBox.height > 0)) return null;
    if (!(viewport.width > 0) || !(viewport.height > 0)) return null;
    const scale = Math.min(ew / viewBox.width, eh / viewBox.height);
    const artLeft = elementRect.left + (ew - viewBox.width * scale) / 2;
    const artTop = elementRect.top + (eh - viewBox.height * scale) / 2;
    const x0 = viewBox.x + (0 - artLeft) / scale;
    const y0 = viewBox.y + (0 - artTop) / scale;
    const x1 = viewBox.x + (viewport.width - artLeft) / scale;
    const y1 = viewBox.y + (viewport.height - artTop) / scale;
    const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    return isFiniteRect(rect) ? rect : null;
  }

  // Largest scale (≤ cap) at which the screen still fits the visible window.
  function maxZoomScale(screenRect = SCREEN_RECT, visibleRect = null, cap = MAX_ZOOM_SCALE) {
    if (!isFiniteRect(screenRect) || !isFiniteRect(visibleRect)) return cap;
    const fit = Math.min(visibleRect.w / screenRect.w, visibleRect.h / screenRect.h);
    return Math.max(MIN_ZOOM_SCALE, Math.min(cap, fit));
  }

  // The screen scaled about its bottom-center, then slid back inside the
  // visible window: down if its top would leave it (the usual case — the
  // screen sits high in the frame), and sideways for narrow windows.
  function computeZoomRect(screenRect = SCREEN_RECT, scale = 1, visibleRect = null) {
    const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const w = screenRect.w * s;
    const h = screenRect.h * s;
    const cx = screenRect.x + screenRect.w / 2;
    const bottom = screenRect.y + screenRect.h;
    let x = cx - w / 2;
    let y = bottom - h;
    if (s > 1 && isFiniteRect(visibleRect)) {
      if (y < visibleRect.y) y = visibleRect.y;
      if (y + h > visibleRect.y + visibleRect.h) y = Math.max(visibleRect.y, visibleRect.y + visibleRect.h - h);
      if (x < visibleRect.x) x = visibleRect.x;
      if (x + w > visibleRect.x + visibleRect.w) x = Math.max(visibleRect.x, visibleRect.x + visibleRect.w - w);
    }
    return { x, y, w, h, scale: s };
  }

  // SVG transform that maps the 1× screen onto `zoomRect`.
  function zoomTransform(screenRect, zoomRect) {
    const s = zoomRect.scale;
    const tx = zoomRect.x - screenRect.x * s;
    const ty = zoomRect.y - screenRect.y * s;
    const round = (value) => Math.round(value * 1000) / 1000;
    return `translate(${round(tx)} ${round(ty)}) scale(${round(s)})`;
  }

  function interpolateRect(from, to, t) {
    const k = Math.max(0, Math.min(1, t));
    const mix = (a, b) => a + (b - a) * k;
    return {
      x: mix(from.x, to.x),
      y: mix(from.y, to.y),
      w: mix(from.w, to.w),
      h: mix(from.h, to.h),
      scale: mix(from.scale, to.scale),
    };
  }

  function easeOutCubic(t) {
    const k = Math.max(0, Math.min(1, t));
    return 1 - Math.pow(1 - k, 3);
  }

  // One wheel event → next zoom scale; scrolling up (negative deltaY) zooms
  // in. A mouse wheel notch (tens of px or more, or line/page mode) is exactly
  // one step however large Chromium scales its delta; fine trackpad deltas
  // accumulate in `carry` until they add up to a notch.
  function stepWheelZoom(scale, deltaY, options = {}) {
    const max = Number.isFinite(options.maxScale) ? options.maxScale : MAX_ZOOM_SCALE;
    const current = Number.isFinite(scale) ? scale : HOVER_ZOOM_SCALE;
    const deltaMode = options.deltaMode || 0;
    const px = deltaMode === 1 ? deltaY * 33 : (deltaMode === 2 ? deltaY * 400 : deltaY);
    let carry = Number.isFinite(options.carry) ? options.carry : 0;
    let direction = 0;
    if (!Number.isFinite(px) || px === 0) return { scale: current, carry };
    if (Math.abs(px) >= WHEEL_NOTCH_PX * 0.4) {
      direction = px < 0 ? 1 : -1;
      carry = 0;
    } else {
      carry += px;
      if (Math.abs(carry) >= WHEEL_NOTCH_PX) {
        direction = carry < 0 ? 1 : -1;
        carry = 0;
      }
    }
    let next = current + direction * ZOOM_STEP;
    next = Math.round(next / ZOOM_STEP) * ZOOM_STEP;
    next = Math.max(MIN_ZOOM_SCALE, Math.min(max, next));
    return { scale: next, carry };
  }

  // The board's rect while the given hand holds it ("right" or "left"). A
  // sign without a second hand (leftHandDx null) is always where it starts.
  function signRect(side, sign = DEFAULT_SIGN) {
    const screen = (sign && sign.screen) || SCREEN_RECT;
    const dx = sign ? sign.leftHandDx : LEFT_HAND_DX;
    if (side !== "left" || !Number.isFinite(dx)) return screen;
    return Object.freeze({ ...screen, x: screen.x + dx });
  }

  // Where the sign is `t` (0..1) of the way through a toss that starts in
  // `fromSide`: the carrier's offset from its right-hand position, and which
  // hand the arms show (they swap at the top of the arc).
  function tossPose(fromSide, t, sign = DEFAULT_SIGN) {
    const handDx = sign && Number.isFinite(sign.leftHandDx) ? sign.leftHandDx : LEFT_HAND_DX;
    const lift = sign && Number.isFinite(sign.tossLift) ? sign.tossLift : TOSS_LIFT;
    const k = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
    const from = fromSide === "left" ? handDx : 0;
    const to = fromSide === "left" ? 0 : handDx;
    const eased = k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k);
    return {
      dx: from + (to - from) * eased,
      dy: -lift * Math.sin(Math.PI * k),
      arms: k >= 0.5 ? (fromSide === "left" ? "right" : "left") : (fromSide === "left" ? "left" : "right"),
    };
  }

  function pointInRect(point, rect) {
    return !!(
      point
      && Number.isFinite(point.x)
      && Number.isFinite(point.y)
      && isFiniteRect(rect)
      && point.x >= rect.x
      && point.x <= rect.x + rect.w
      && point.y >= rect.y
      && point.y <= rect.y + rect.h
    );
  }

  return Object.freeze({
    SCREEN_RECT,
    LINE_START_X,
    LINE_END_X,
    LINE_BASELINE_Y,
    PROMPT_FONT_SIZE,
    TITLE_FONT_SIZE,
    PROMPT_GAP,
    LEFT_HAND_DX,
    LEVELS,
    TOSS_HOLD_MS,
    TOSS_MS,
    TOSS_LIFT,
    MARQUEE_START_HOLD_MS,
    MARQUEE_END_HOLD_MS,
    MARQUEE_MS_PER_UNIT,
    MARQUEE_PASSES,
    DWELL_MIN_MS,
    DWELL_MAX_MS,
    DWELL_FIT_MS,
    HOVER_ZOOM_SCALE,
    MAX_ZOOM_SCALE,
    MIN_ZOOM_SCALE,
    ZOOM_STEP,
    ZOOM_TRANSITION_MS,
    ZOOM_LEAVE_DELAY_MS,
    WHEEL_NOTCH_PX,
    COPY_FEEDBACK_MS,
    COPY_FEEDBACK_TEXT,
    TITLE_COLOR,
    DEFAULT_SIGN,
    resolveSign,
    resolveLevel,
    estimateTextWidth,
    layoutLine,
    buildMarqueePlan,
    marqueeOffsetAt,
    computeDwellMs,
    computeVisibleViewBoxRect,
    maxZoomScale,
    computeZoomRect,
    zoomTransform,
    interpolateRect,
    easeOutCubic,
    stepWheelZoom,
    signRect,
    tossPose,
    pointInRect,
  });
});
