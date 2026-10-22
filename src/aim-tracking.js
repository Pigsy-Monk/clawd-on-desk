"use strict";

// Aim tracking — the numeric core behind `eyeTracking.trackingLayers` layers
// whose `mode` is "rotate" or "foreshorten" (turret / gun follow). The renderer
// owns the DOM plumbing (wrappers, RAF loop, which way the pet is mirrored);
// every number lives here so it can be unit tested without a DOM.
//
// Conventions, all taken from the approved demo (see
// docs/project/theme-state-ui.md, "Aim Tracking"):
//   * Angles are screen degrees in SVG `rotate()` sign — negative = up.
//   * `restAngle` is the direction the art already points at rest; the applied
//     rotation is 0 when the cursor sits exactly on that direction.
//   * `minAngle` / `maxAngle` are relative to `restAngle`, so a layer that may
//     raise 15° and depress 8° declares -15 / +8.
//   * `rampPx` is measured in the same pixel space as the art rect tick.js
//     hands over (device px), and scales the angle back towards rest as the
//     cursor approaches `aimOrigin`.
//   * `foreshorten` shortens along the layer's own x axis by cos(yaw), which
//     is how a side view hints at turning towards/away from the camera.
(function exposeAimTracking(root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  } else if (root) {
    root.aimTracking = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createAimTracking() {
  const MODE_TRANSLATE = "translate";
  const MODE_ROTATE = "rotate";
  const MODE_FORESHORTEN = "foreshorten";
  const BEHIND_MIRROR = "mirror";
  const BEHIND_CLAMP = "clamp";

  const DEFAULT_RAMP_PX = 160;
  const DEFAULT_EASE = 0.15;
  const DEFAULT_REST_ANGLE = 0;
  const DEFAULT_BEHIND = BEHIND_MIRROR;
  // `foreshorten` only shortens while the cursor is behind the pet; the demo
  // reaches full yaw 80 viewBox units of "behind" distance out.
  const FORESHORTEN_SPAN_UNITS = 80;
  // The rest pose: no rotation, no shortening. Also the target whenever there
  // is no cursor sample at all (state change, mouse idle), which is how the
  // renderer's eye-move(0, 0) zeroing brings the aim back to rest.
  const REST = Object.freeze({ angle: 0, scaleX: 1 });

  const ANGLE_QUANTUM = 0.1;
  const SCALE_QUANTUM = 0.001;
  const SETTLE_EPSILON = 0.02;

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function isPoint(value) {
    return Array.isArray(value) && value.length === 2
      && isFiniteNumber(value[0]) && isFiniteNumber(value[1]);
  }

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  // Keeps -0 out of generated transform strings.
  function normalizeZero(value) {
    return value === 0 ? 0 : value;
  }

  /** Layer mode, defaulting to the pre-existing translate behaviour. */
  function resolveLayerMode(cfg) {
    const mode = cfg && cfg.mode;
    if (mode === MODE_ROTATE || mode === MODE_FORESHORTEN) return mode;
    return MODE_TRANSLATE;
  }

  /**
   * Parse one aim layer out of a theme's `trackingLayers` entry.
   * Returns null for translate layers — the renderer keeps its existing path
   * for those, so themes that never declare `mode` are untouched.
   *
   * The returned object also carries the layer's live eased state
   * (`angle`, `scaleX`), which starts at rest.
   */
  function createAimLayer(cfg) {
    const mode = resolveLayerMode(cfg);
    if (mode === MODE_TRANSLATE) return null;
    if (!cfg || !isPoint(cfg.pivot)) return null;

    const pivot = [cfg.pivot[0], cfg.pivot[1]];
    const aimOrigin = isPoint(cfg.aimOrigin)
      ? [cfg.aimOrigin[0], cfg.aimOrigin[1]]
      : [pivot[0], pivot[1]];
    const ease = isFiniteNumber(cfg.ease) && cfg.ease > 0 && cfg.ease <= 1
      ? cfg.ease
      : DEFAULT_EASE;
    const rampPx = isFiniteNumber(cfg.rampPx) && cfg.rampPx >= 0 ? cfg.rampPx : DEFAULT_RAMP_PX;

    if (mode === MODE_ROTATE) {
      return {
        mode,
        pivot,
        aimOrigin,
        restAngle: isFiniteNumber(cfg.restAngle) ? cfg.restAngle : DEFAULT_REST_ANGLE,
        minAngle: isFiniteNumber(cfg.minAngle) ? cfg.minAngle : 0,
        maxAngle: isFiniteNumber(cfg.maxAngle) ? cfg.maxAngle : 0,
        ease,
        rampPx,
        behind: cfg.behind === BEHIND_CLAMP ? BEHIND_CLAMP : DEFAULT_BEHIND,
        angle: 0,
        scaleX: 1,
      };
    }

    return {
      mode,
      pivot,
      aimOrigin,
      maxAngle: isFiniteNumber(cfg.maxAngle) && cfg.maxAngle > 0 ? cfg.maxAngle : 0,
      ease,
      rampPx,
      when: cfg.when === undefined ? "behind" : cfg.when,
      angle: 0,
      scaleX: 1,
    };
  }

  /**
   * Normalize the aim sample tick.js sends along with an eye-move:
   * the cursor position relative to the art rect's top-left corner plus that
   * rect's size, all in device px. Returns null for anything malformed — the
   * renderer then treats the frame as "no sample" and returns to rest.
   */
  function normalizeAimSample(sample) {
    if (!sample || typeof sample !== "object") return null;
    const { x, y, w, h } = sample;
    if (![x, y, w, h].every(isFiniteNumber)) return null;
    if (!(w > 0) || !(h > 0)) return null;
    return { x, y, w, h };
  }

  /**
   * Target angle / scale for one sample.
   *
   * sample: `{ x, y, w, h }` from `normalizeAimSample`, plus `mirrored` — true
   *   when the pet is currently drawn mirrored (mini at the left edge, walking
   *   left). Mirroring reflects the whole drawing, so the cursor's horizontal
   *   offset is reflected about `aimOrigin` and everything after that — the
   *   angle, the "behind" test, the yaw — falls out in the art's own frame.
   * viewBox: the effective viewBox of the SVG being tracked, used to turn the
   *   art rect into a px-per-unit scale.
   */
  function computeAimTarget(layer, sample, viewBox) {
    if (!layer || !sample || !viewBox) return null;
    if (layer.mode !== MODE_ROTATE && layer.mode !== MODE_FORESHORTEN) return null;
    if (![sample.x, sample.y, sample.w, sample.h].every(isFiniteNumber)) return null;
    if (!(sample.w > 0) || !(sample.h > 0)) return null;
    if (!(viewBox.width > 0) || !(viewBox.height > 0)) return null;

    const ppu = sample.w / viewBox.width;
    const origin = isPoint(layer.aimOrigin) ? layer.aimOrigin : layer.pivot;
    if (!isPoint(origin)) return null;

    let vx = sample.x - (origin[0] - viewBox.x) * ppu;
    const vy = sample.y - (origin[1] - viewBox.y) * ppu;
    if (sample.mirrored) vx = -vx;

    const dist = Math.sqrt(vx * vx + vy * vy);
    const ramp = layer.rampPx > 0 ? Math.min(1, dist / layer.rampPx) : 1;
    const behind = vx < 0;

    if (layer.mode === MODE_ROTATE) {
      // "mirror" folds a cursor behind the pet onto the same elevation as its
      // mirrored twin; "clamp" lets the raw angle saturate at min/max instead.
      const raw = behind && layer.behind === BEHIND_CLAMP
        ? Math.atan2(vy, vx)
        : Math.atan2(vy, Math.abs(vx));
      const degrees = raw * (180 / Math.PI);
      return {
        angle: clamp(degrees - layer.restAngle, layer.minAngle, layer.maxAngle) * ramp,
        scaleX: 1,
      };
    }

    const yaw = behind
      ? clamp(-vx / (ppu * FORESHORTEN_SPAN_UNITS), 0, 1) * layer.maxAngle * ramp
      : 0;
    return { angle: 0, scaleX: Math.cos(yaw * (Math.PI / 180)) };
  }

  function easeValue(from, to, ease, epsilon) {
    if (!isFiniteNumber(from) || !isFiniteNumber(to)) return to;
    const next = from + (to - from) * ease;
    return Math.abs(next - to) < epsilon ? to : next;
  }

  /** One frame of the per-layer easing, using the same coefficient style as
   *  the existing translate layers. */
  function easeAim(current, target, ease, epsilon = SETTLE_EPSILON) {
    const k = isFiniteNumber(ease) && ease > 0 && ease <= 1 ? ease : DEFAULT_EASE;
    const from = current || REST;
    const to = target || REST;
    return {
      angle: easeValue(from.angle, to.angle, k, epsilon),
      scaleX: easeValue(from.scaleX, to.scaleX, k, epsilon),
    };
  }

  function isAimSettled(current, target, epsilon = SETTLE_EPSILON) {
    const from = current || REST;
    const to = target || REST;
    return Math.abs(from.angle - to.angle) < epsilon
      && Math.abs(from.scaleX - to.scaleX) < epsilon;
  }

  /**
   * The SVG transform for one aim layer at the current eased state.
   * Both shapes are quantized the way the demo does it, so the attribute
   * string stays stable while the values are still converging.
   */
  function aimTransform(layer, current) {
    const pivot = (layer && isPoint(layer.pivot)) ? layer.pivot : [0, 0];
    const state = current || REST;
    if (layer && layer.mode === MODE_ROTATE) {
      const angle = normalizeZero(Math.round(state.angle * 10) / 10);
      return `rotate(${angle} ${pivot[0]} ${pivot[1]})`;
    }
    const scaleX = normalizeZero(Math.round(state.scaleX * 1000) / 1000);
    return `translate(${pivot[0]} ${pivot[1]}) scale(${scaleX} 1) `
      + `translate(${normalizeZero(-pivot[0])} ${normalizeZero(-pivot[1])})`;
  }

  return {
    MODE_TRANSLATE,
    MODE_ROTATE,
    MODE_FORESHORTEN,
    BEHIND_MIRROR,
    BEHIND_CLAMP,
    DEFAULT_RAMP_PX,
    DEFAULT_BEHIND,
    FORESHORTEN_SPAN_UNITS,
    SETTLE_EPSILON,
    REST,
    resolveLayerMode,
    createAimLayer,
    normalizeAimSample,
    computeAimTarget,
    easeAim,
    isAimSettled,
    aimTransform,
  };
});
