"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const layout = require("../src/notice-screen-layout");
const themeLoader = require("../src/theme-loader");
const hitGeometry = require("../src/hit-geometry");

const ROOT = path.join(__dirname, "..");
themeLoader.init(path.join(ROOT, "src"));

const FILE = "clawd-notice-screen.svg";
const near = (actual, expected, epsilon = 0.02) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} ≉ ${expected}`);
};

// The viewBox region a 230×230 pet window shows, derived the way the renderer
// does it: the media element's rect (here from hit-geometry, which mirrors
// the renderer's layout) fitted against the window.
function visibleRectAt(size) {
  const theme = themeLoader.loadTheme("clawd", { strict: true });
  const bounds = { x: 0, y: 0, width: size, height: size };
  const art = hitGeometry.getAssetRectScreen(theme, bounds, "idle", FILE);
  return {
    theme,
    bounds,
    rect: layout.computeVisibleViewBoxRect(
      { left: art.x, top: art.y, width: art.w, height: art.h },
      { width: size, height: size },
      theme.viewBox
    ),
  };
}

describe("notice sign line", () => {
  it("maps each level to its prompt and color, unknown levels to info", () => {
    assert.deepStrictEqual(
      Object.fromEntries(Object.entries(layout.LEVELS).map(([k, v]) => [k, [v.prompt, v.color]])),
      {
        info: [">", "#7FB2FF"],
        success: ["OK", "#6EE19A"],
        warn: ["!", "#FFC857"],
        error: ["✗", "#FF6B6B"],
      }
    );
    assert.strictEqual(layout.resolveLevel("nope"), layout.LEVELS.info);
  });

  it("lays out prompt and title in chalk and reports the overflow", () => {
    const short = layout.layoutLine(1.2, 3);
    assert.strictEqual(short.promptX, layout.LINE_START_X);
    near(short.titleX, layout.LINE_START_X + 1.2 + layout.PROMPT_GAP);
    near(short.endX, short.titleX + 3);
    assert.strictEqual(short.overflow, 0);

    const long = layout.layoutLine(1.2, 30);
    near(long.overflow, long.endX - layout.LINE_END_X);
    assert.ok(long.overflow > 0);

    // An empty title ends the line right after the prompt.
    const empty = layout.layoutLine(1.2, 0);
    near(empty.endX, empty.titleX);
  });

  it("estimates CJK glyphs at one em and ASCII at a bit over half", () => {
    near(layout.estimateTextWidth("构建", 2.5), 5);
    near(layout.estimateTextWidth("ab", 2.5), 3);
    assert.strictEqual(layout.estimateTextWidth("", 2.5), 0);
  });
});

describe("notice sign marquee and dwell", () => {
  it("does not scroll a line that fits and holds it 4 s", () => {
    const plan = layout.buildMarqueePlan(0);
    assert.strictEqual(plan.overflow, 0);
    assert.strictEqual(layout.marqueeOffsetAt(plan, 5000), 0);
    assert.strictEqual(layout.computeDwellMs(plan), 4000);
  });

  it("holds 800 ms, scrolls 260 ms per unit, holds 900 ms, three passes, then rests at the start", () => {
    const plan = layout.buildMarqueePlan(5);
    assert.strictEqual(plan.scrollMs, 1300);
    assert.strictEqual(plan.passMs, 800 + 1300 + 900);
    assert.strictEqual(plan.passes, 3);
    assert.strictEqual(plan.totalMs, 9000);

    assert.strictEqual(layout.marqueeOffsetAt(plan, 0), 0);
    assert.strictEqual(layout.marqueeOffsetAt(plan, 799), 0);
    near(layout.marqueeOffsetAt(plan, 800 + 650), -2.5);
    assert.strictEqual(layout.marqueeOffsetAt(plan, 800 + 1300), -5);
    assert.strictEqual(layout.marqueeOffsetAt(plan, 2999), -5);
    // Second pass starts again from the beginning of the line.
    assert.strictEqual(layout.marqueeOffsetAt(plan, 3000), 0);
    near(layout.marqueeOffsetAt(plan, 3000 + 800 + 650), -2.5);
    assert.strictEqual(layout.marqueeOffsetAt(plan, 8999), -5);
    assert.strictEqual(layout.marqueeOffsetAt(plan, 9000), 0);
    assert.strictEqual(layout.marqueeOffsetAt(plan, 60000), 0);
    assert.strictEqual(layout.computeDwellMs(plan), 9000);
  });

  it("clamps the dwell to [3 s, 15 s]", () => {
    // 0.1 unit: 3 × (800 + 26 + 900) = 5178 → inside the range.
    assert.strictEqual(layout.computeDwellMs(layout.buildMarqueePlan(0.1)), 5178);
    // A very long title would take far longer than 15 s.
    const longPlan = layout.buildMarqueePlan(80);
    assert.ok(longPlan.totalMs > 15000);
    assert.strictEqual(layout.computeDwellMs(longPlan), 15000);
    assert.strictEqual(layout.DWELL_MIN_MS, 3000);
    assert.ok(layout.computeDwellMs(layout.buildMarqueePlan(0.02)) >= 3000);
  });

  it("shows the start of the line under reduced motion", () => {
    const plan = layout.buildMarqueePlan(5);
    assert.strictEqual(layout.marqueeOffsetAt(plan, 2000, { reducedMotion: true }), 0);
    assert.strictEqual(layout.marqueeOffsetAt(plan, 2000, { reducedMotion: true, loop: true }), 0);
  });

  it("keeps scrolling past the last pass while looping (hovered screen)", () => {
    // 5 units → passMs 3000, totalMs 9000.
    const plan = layout.buildMarqueePlan(5);
    assert.strictEqual(layout.marqueeOffsetAt(plan, 9000 + 800 + 650), 0);
    near(layout.marqueeOffsetAt(plan, 9000 + 800 + 650, { loop: true }), -2.5);
    assert.strictEqual(layout.marqueeOffsetAt(plan, 30000 + 2999, { loop: true }), -5);
    // A line that fits never moves, looping or not.
    assert.strictEqual(layout.marqueeOffsetAt(layout.buildMarqueePlan(0), 5000, { loop: true }), 0);
  });
});

describe("notice sign zoom and hand-to-hand geometry", () => {
  it("derives the 230×230 visible window the spec measured", () => {
    const { rect } = visibleRectAt(230);
    near(rect.x, -9.74, 0.05);
    near(rect.y, -15.76, 0.05);
    near(rect.x + rect.w, 24.74, 0.05);
    near(rect.y + rect.h, 18.72, 0.05);
  });

  it("zooms the board 1.5× from its bottom edge, kept inside the visible window", () => {
    const { rect: visible } = visibleRectAt(230);
    for (const side of ["right", "left"]) {
      const board = layout.signRect(side);
      const one = layout.computeZoomRect(board, 1, visible);
      assert.deepStrictEqual({ x: one.x, y: one.y, w: one.w, h: one.h }, { ...board });

      const hover = layout.computeZoomRect(board, layout.HOVER_ZOOM_SCALE, visible);
      near(hover.w, board.w * 1.5);
      near(hover.h, board.h * 1.5);
      near(hover.y + hover.h, board.y + board.h, 0.001);
      assert.ok(hover.x >= visible.x - 1e-9 && hover.x + hover.w <= visible.x + visible.w + 1e-9, side);
    }
    // The right-hand board would run off the right edge, so it slides left.
    const right = layout.computeZoomRect(layout.signRect("right"), 1.5, visible);
    near(right.x + right.w, visible.x + visible.w, 0.001);
  });

  it("caps the wheel where the wide board stops fitting the window", () => {
    const { rect: visible } = visibleRectAt(230);
    const cap = layout.maxZoomScale(layout.SCREEN_RECT, visible);
    near(cap, visible.w / layout.SCREEN_RECT.w, 0.001);
    assert.ok(cap > layout.HOVER_ZOOM_SCALE && cap < layout.MAX_ZOOM_SCALE, String(cap));
    for (const side of ["right", "left"]) {
      const max = layout.computeZoomRect(layout.signRect(side), cap, visible);
      assert.ok(max.x >= visible.x - 1e-9 && max.x + max.w <= visible.x + visible.w + 1e-9, side);
      assert.ok(max.y >= visible.y - 1e-9 && max.y + max.h <= visible.y + visible.h + 1e-9, side);
    }
  });

  it("covers the body, both hands' boards and the largest zoom with the theme hit box", () => {
    const { theme, rect: visible } = visibleRectAt(230);
    const hit = theme.fileHitBoxes[FILE];
    const inside = (r) => (
      r.x >= hit.x && r.y >= hit.y && r.x + r.w <= hit.x + hit.w && r.y + r.h <= hit.y + hit.h
    );
    const body = { x: 0, y: 6, w: 15, h: 10 };
    assert.ok(inside(body), "body + shadow");
    const cap = layout.maxZoomScale(layout.SCREEN_RECT, visible);
    for (const side of ["right", "left"]) {
      for (const scale of [1, layout.HOVER_ZOOM_SCALE, cap]) {
        assert.ok(inside(layout.computeZoomRect(layout.signRect(side), scale, visible)), `${side} ${scale}×`);
      }
    }
  });

  it("maps the 1× board onto the zoom rect with one SVG transform", () => {
    const zoom = layout.computeZoomRect(layout.SCREEN_RECT, 1.5, { x: -9.74, y: -15.76, w: 34.48, h: 34.48 });
    const transform = layout.zoomTransform(layout.SCREEN_RECT, zoom);
    const [, tx, ty, s] = transform.match(/^translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)$/).map(Number);
    near(layout.SCREEN_RECT.x * s + tx, zoom.x, 0.002);
    near(layout.SCREEN_RECT.y * s + ty, zoom.y, 0.002);
    near((layout.SCREEN_RECT.x + layout.SCREEN_RECT.w) * s + tx, zoom.x + zoom.w, 0.002);
  });

  it("steps the wheel by 0.25 per notch inside [1, max] and accumulates trackpad deltas", () => {
    assert.strictEqual(layout.stepWheelZoom(1.5, -100).scale, 1.75);
    assert.strictEqual(layout.stepWheelZoom(1.5, 100).scale, 1.25);
    assert.strictEqual(layout.stepWheelZoom(1.5, -360).scale, 1.75, "a big notch is still one step");
    assert.strictEqual(layout.stepWheelZoom(1.5, -3, { deltaMode: 1 }).scale, 1.75);
    assert.strictEqual(layout.stepWheelZoom(2, -100).scale, 2);
    assert.strictEqual(layout.stepWheelZoom(1, 100).scale, 1);
    // A cap that is not a whole step: the wheel stops at it, not past it.
    assert.strictEqual(layout.stepWheelZoom(1.5, -100, { maxScale: 1.72 }).scale, 1.72);

    let state = { scale: 1.5, carry: 0 };
    for (let i = 0; i < 9; i++) {
      state = layout.stepWheelZoom(state.scale, -10, { carry: state.carry });
      assert.strictEqual(state.scale, 1.5, `trackpad step ${i}`);
    }
    state = layout.stepWheelZoom(state.scale, -10, { carry: state.carry });
    assert.strictEqual(state.scale, 1.75);
    assert.strictEqual(state.carry, 0);
  });

  it("tosses the sign over the head into the other hand", () => {
    assert.deepStrictEqual({ ...layout.signRect("right") }, { ...layout.SCREEN_RECT });
    near(layout.signRect("left").x, layout.SCREEN_RECT.x + layout.LEFT_HAND_DX);

    const start = layout.tossPose("right", 0);
    assert.deepStrictEqual([start.dx, start.arms], [0, "right"]);
    near(start.dy, 0);
    const top = layout.tossPose("right", 0.5);
    near(top.dx, layout.LEFT_HAND_DX / 2);
    near(top.dy, -layout.TOSS_LIFT);
    assert.strictEqual(top.arms, "left", "the arms swap at the top of the arc");
    const end = layout.tossPose("right", 1);
    near(end.dx, layout.LEFT_HAND_DX);
    near(end.dy, 0);
    // And back again.
    const back = layout.tossPose("left", 1);
    near(back.dx, 0);
    assert.strictEqual(back.arms, "right");
    assert.strictEqual(layout.tossPose("left", 0.2).arms, "left");
    // Out-of-range t clamps.
    assert.deepStrictEqual(layout.tossPose("right", 7).arms, "left");
  });

  it("tests points inside a rect, edges included", () => {
    const rect = { x: 0, y: 0, w: 10, h: 5 };
    assert.ok(layout.pointInRect({ x: 0, y: 5 }, rect));
    assert.ok(!layout.pointInRect({ x: 10.01, y: 1 }, rect));
    assert.ok(!layout.pointInRect({ x: NaN, y: 1 }, rect));
    assert.ok(!layout.pointInRect({ x: 1, y: 1 }, null));
  });
});
