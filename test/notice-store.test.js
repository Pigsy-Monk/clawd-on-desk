"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createNoticeStore,
  DEFAULT_KIND,
  TREND_KIND,
  LEVEL_TTL_MS,
  MAX_SERIES,
  MAX_SERIES_POINTS,
  MAX_SERIES_NAME_LENGTH,
  MAX_SERIES_UNIT_LENGTH,
  MAX_KEY_LENGTH,
  PNG_MIME,
  MAX_IMAGE_BYTES,
  __test,
} = require("../src/notice-store");

const { normalizeKind, normalizeKey, normalizePoints, normalizeSeries, normalizeImage } = __test;

// The 8-byte PNG signature, spelled out so the test does not lean on the
// module's own constant to decide what a PNG is.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A tiny but genuine PNG: the signature followed by filler. Only the signature
// is load-bearing for the store's check.
function pngBase64(fillerBytes = 16) {
  return Buffer.concat([PNG_SIGNATURE, Buffer.alloc(fillerBytes, 0x41)]).toString("base64");
}

function makeStore(options = {}) {
  return createNoticeStore({ max: 20, ...options });
}

// A manual clock, so the keyed-push tests can step past a notice's TTL without
// waiting for one. The timers are inert: with no real expiry callback there is
// nothing to leak between tests, and list()/add() prune off `now` anyway.
function makeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
  };
}

function makeTimedStore(clock) {
  return createNoticeStore({
    max: 20,
    now: clock.now,
    setTimer: () => null,
    clearTimer: () => {},
  });
}

// A series that survives normalization, with `points` overridable.
function series(name, points, extra = {}) {
  return { name, points, ...extra };
}

describe("notice store — kind and series", () => {
  it("defaults kind to text with an empty series and no image", () => {
    const store = makeStore();
    const { notice } = store.add({ body: "hello" });

    assert.strictEqual(notice.kind, DEFAULT_KIND);
    assert.deepStrictEqual(notice.series, []);
    assert.strictEqual(notice.image, null);
  });

  it("passes kind: trend through and keeps its series", () => {
    const store = makeStore();
    const { notice } = store.add({
      title: "引擎发布监控",
      kind: TREND_KIND,
      series: [series("SHA-ALI", [150, 152, 149], { value: 156, unit: "ms" })],
    });

    assert.strictEqual(notice.kind, TREND_KIND);
    assert.strictEqual(notice.series.length, 1);
    assert.strictEqual(notice.series[0].name, "SHA-ALI");
    assert.deepStrictEqual(notice.series[0].points, [150, 152, 149]);
    assert.strictEqual(notice.series[0].value, 156);
    assert.strictEqual(notice.series[0].unit, "ms");
  });

  it("falls back to text for an unknown kind", () => {
    const store = makeStore();
    const { notice } = store.add({ body: "x", kind: "chart" });

    assert.strictEqual(notice.kind, DEFAULT_KIND);
  });

  it("derives trend from series even when kind is omitted", () => {
    const store = makeStore();
    // Series exist to be drawn: a caller that sends them without declaring a
    // kind must get a chart, not a text card with the data silently unused.
    const { notice } = store.add({
      title: "引擎发布监控",
      series: [series("SHA-ALI", [150, 152, 149])],
    });

    assert.strictEqual(notice.kind, TREND_KIND);
    assert.strictEqual(notice.series.length, 1);
  });

  it("keeps a declared text kind when there are no series", () => {
    const store = makeStore();
    const { notice } = store.add({ body: "x", kind: DEFAULT_KIND });

    assert.strictEqual(notice.kind, DEFAULT_KIND);
    assert.strictEqual(notice.series.length, 0);
  });

  it("treats a non-string kind as text", () => {
    assert.strictEqual(normalizeKind(undefined), DEFAULT_KIND);
    assert.strictEqual(normalizeKind(null), DEFAULT_KIND);
    assert.strictEqual(normalizeKind(42), DEFAULT_KIND);
    assert.strictEqual(normalizeKind("Trend"), DEFAULT_KIND);
    assert.strictEqual(normalizeKind("trend"), TREND_KIND);
  });

  it("keeps at most 8 series", () => {
    const store = makeStore();
    const many = Array.from({ length: 12 }, (_, i) => series(`s${i}`, [i, i + 1]));
    const { notice } = store.add({ title: "t", kind: TREND_KIND, series: many });

    assert.strictEqual(notice.series.length, MAX_SERIES);
    assert.strictEqual(notice.series[0].name, "s0");
    assert.strictEqual(notice.series[MAX_SERIES - 1].name, `s${MAX_SERIES - 1}`);
  });

  it("caps points to the last 240", () => {
    const store = makeStore();
    const points = Array.from({ length: MAX_SERIES_POINTS + 60 }, (_, i) => i);
    const { notice } = store.add({
      title: "t",
      kind: TREND_KIND,
      series: [series("s", points)],
    });

    const kept = notice.series[0].points;
    assert.strictEqual(kept.length, MAX_SERIES_POINTS);
    // The tail, not the head: the last point is the newest sample.
    assert.strictEqual(kept[0], points.length - MAX_SERIES_POINTS);
    assert.strictEqual(kept[kept.length - 1], points.length - 1);
  });

  it("drops a series with fewer than 2 finite points", () => {
    assert.deepStrictEqual(normalizePoints([1]), [1]);
    assert.deepStrictEqual(normalizePoints([]), []);
    assert.deepStrictEqual(normalizePoints("nope"), []);

    const store = makeStore();
    const { notice } = store.add({
      title: "t",
      kind: TREND_KIND,
      series: [
        series("only-one", [5]),
        series("none", []),
        series("good", [1, 2]),
      ],
    });

    assert.strictEqual(notice.kind, TREND_KIND);
    assert.deepStrictEqual(notice.series.map((s) => s.name), ["good"]);
  });

  it("drops a series with an empty name", () => {
    const store = makeStore();
    const { notice } = store.add({
      title: "t",
      kind: TREND_KIND,
      series: [series("   ", [1, 2]), series("kept", [1, 2])],
    });

    assert.deepStrictEqual(notice.series.map((s) => s.name), ["kept"]);
  });

  it("trims and caps the series name and unit", () => {
    const store = makeStore();
    const { notice } = store.add({
      title: "t",
      kind: TREND_KIND,
      series: [
        series("  padded  ", [1, 2], { unit: "u".repeat(40) }),
        series("n".repeat(80), [1, 2]),
      ],
    });

    assert.strictEqual(notice.series[0].name, "padded");
    assert.strictEqual(notice.series[0].unit.length, MAX_SERIES_UNIT_LENGTH);
    assert.strictEqual(notice.series[1].name.length, MAX_SERIES_NAME_LENGTH);
  });

  it("filters out non-finite and string points", () => {
    const notice = normalizeSeries([
      series("s", [1, "2", NaN, Infinity, -Infinity, null, undefined, 3]),
    ])[0];

    assert.deepStrictEqual(notice.points, [1, 3]);
  });

  it("normalizes an absent unit to an empty string and an absent value to null", () => {
    const notice = normalizeSeries([series("s", [1, 2])])[0];

    assert.strictEqual(notice.unit, "");
    assert.strictEqual(notice.value, null);
  });

  it("keeps a finite numeric value and rejects a non-numeric one", () => {
    assert.strictEqual(normalizeSeries([series("a", [1, 2], { value: 0 })])[0].value, 0);
    assert.strictEqual(normalizeSeries([series("a", [1, 2], { value: 1.5 })])[0].value, 1.5);
    assert.strictEqual(normalizeSeries([series("a", [1, 2], { value: "5" })])[0].value, null);
    assert.strictEqual(normalizeSeries([series("a", [1, 2], { value: NaN })])[0].value, null);
  });

  it("ignores a non-array series field", () => {
    assert.deepStrictEqual(normalizeSeries("nope"), []);
    assert.deepStrictEqual(normalizeSeries(null), []);
    assert.deepStrictEqual(normalizeSeries({ name: "s" }), []);
  });

  it("falls back to text when every series is dropped", () => {
    const store = makeStore();
    const { notice } = store.add({
      title: "t",
      kind: TREND_KIND,
      series: [series("one-point", [1]), series("", [1, 2])],
    });

    assert.strictEqual(notice.kind, DEFAULT_KIND);
    assert.deepStrictEqual(notice.series, []);
  });

  it("accepts a chart-only notice with no title or body", () => {
    const store = makeStore();
    const { notice } = store.add({
      kind: TREND_KIND,
      series: [series("SHA-ALI", [150, 152, 149])],
    });

    assert.ok(notice);
    assert.strictEqual(notice.title, "");
    assert.strictEqual(notice.body, "");
    assert.strictEqual(notice.kind, TREND_KIND);
    assert.strictEqual(notice.series.length, 1);
  });
});

describe("notice store — image", () => {
  it("accepts a valid tiny PNG", () => {
    const store = makeStore();
    const data = pngBase64();
    const { notice } = store.add({ title: "shot", image: { mime: PNG_MIME, data } });

    assert.deepStrictEqual(notice.image, { mime: PNG_MIME, data });
  });

  it("accepts an image-only notice with no title or body", () => {
    const store = makeStore();
    const { notice } = store.add({ image: { mime: PNG_MIME, data: pngBase64() } });

    assert.ok(notice);
    assert.strictEqual(notice.image.mime, PNG_MIME);
  });

  it("rejects base64 that does not decode to a PNG", () => {
    const store = makeStore();
    const data = Buffer.from("not a png").toString("base64");
    const { notice } = store.add({ title: "shot", image: { mime: PNG_MIME, data } });

    assert.strictEqual(notice.image, null);
  });

  it("rejects a data: URI instead of a bare base64 payload", () => {
    const store = makeStore();
    const data = `data:${PNG_MIME};base64,${pngBase64()}`;
    const { notice } = store.add({ title: "shot", image: { mime: PNG_MIME, data } });

    assert.strictEqual(notice.image, null);
  });

  it("rejects a mime other than image/png", () => {
    const store = makeStore();
    const data = pngBase64();

    assert.strictEqual(store.add({ title: "a", image: { mime: "image/jpeg", data } }).notice.image, null);
    assert.strictEqual(store.add({ title: "b", image: { mime: "image/png;base64", data } }).notice.image, null);
    assert.strictEqual(store.add({ title: "c", image: { mime: undefined, data } }).notice.image, null);
  });

  it("rejects an image over the decoded size cap", () => {
    const store = makeStore();
    // One byte past the cap, still a well-formed PNG by signature.
    const oversized = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(MAX_IMAGE_BYTES)]);
    assert.ok(oversized.length > MAX_IMAGE_BYTES);
    const data = oversized.toString("base64");
    const { notice } = store.add({ title: "shot", image: { mime: PNG_MIME, data } });

    assert.strictEqual(notice.image, null);
  });

  it("accepts an image just under the cap", () => {
    const store = makeStore();
    const atCap = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(MAX_IMAGE_BYTES - PNG_SIGNATURE.length)]);
    assert.strictEqual(atCap.length, MAX_IMAGE_BYTES);
    const { notice } = store.add({
      title: "shot",
      image: { mime: PNG_MIME, data: atCap.toString("base64") },
    });

    assert.strictEqual(notice.image.mime, PNG_MIME);
  });

  it("rejects a missing or non-string data field", () => {
    assert.strictEqual(normalizeImage({ mime: PNG_MIME }), null);
    assert.strictEqual(normalizeImage({ mime: PNG_MIME, data: 42 }), null);
    assert.strictEqual(normalizeImage(null), null);
    assert.strictEqual(normalizeImage("nope"), null);
    assert.strictEqual(normalizeImage([]), null);
  });

  it("exports the 6 MB decoded cap", () => {
    assert.strictEqual(MAX_IMAGE_BYTES, 6 * 1024 * 1024);
  });
});

describe("notice store — empty-card refusal", () => {
  it("rejects a notice with no title, body, series or image", () => {
    const store = makeStore();

    assert.strictEqual(store.add({}), null);
    assert.strictEqual(store.add({ title: "   ", body: "" }), null);
    assert.strictEqual(store.add({ level: "error", ttl: 5000 }), null);
    assert.strictEqual(store.list().length, 0);
  });

  it("rejects a trend notice whose series all drop, with no text either", () => {
    const store = makeStore();

    assert.strictEqual(store.add({ kind: TREND_KIND, series: [series("s", [1])] }), null);
  });

  it("still accepts a plain text notice", () => {
    const store = makeStore();
    const { notice } = store.add({ title: "Build done", body: "12 files", level: "success" });

    assert.ok(notice);
    assert.strictEqual(notice.title, "Build done");
    assert.strictEqual(notice.level, "success");
    assert.strictEqual(notice.kind, DEFAULT_KIND);
  });
});

describe("notice store — per-level default lifetime", () => {
  it("gives every level its own default when no ttl is sent", () => {
    const store = makeStore();

    for (const level of Object.keys(LEVEL_TTL_MS)) {
      const { notice } = store.add({ title: level, level });
      assert.strictEqual(notice.ttl, LEVEL_TTL_MS[level], `level ${level}`);
    }
  });

  it("keeps an info card short — it is a glance, not a task", () => {
    const store = makeStore();
    const { notice } = store.add({ title: "done", level: "info" });

    assert.strictEqual(notice.ttl, 20_000);
    // The old flat default must not creep back in.
    assert.notStrictEqual(notice.ttl, 60_000);
  });

  it("gives an error card the longest life", () => {
    const store = makeStore();
    const { notice } = store.add({ title: "boom", level: "error" });

    assert.strictEqual(notice.ttl, 300_000);
    assert.ok(notice.ttl > LEVEL_TTL_MS.info);
    assert.ok(notice.ttl > LEVEL_TTL_MS.success);
    assert.ok(notice.ttl > LEVEL_TTL_MS.warn);
  });

  it("lets an explicit ttl override the level default", () => {
    const store = makeStore();
    const { notice } = store.add({ title: "t", level: "error", ttl: 5_000 });

    assert.strictEqual(notice.ttl, 5_000);
  });

  it("falls back to the info default for an unknown level", () => {
    const store = makeStore();
    const { notice } = store.add({ title: "t", level: "catastrophe" });

    assert.strictEqual(notice.level, "info");
    assert.strictEqual(notice.ttl, LEVEL_TTL_MS.info);
  });

  it("still clamps an explicit ttl to the allowed range", () => {
    const store = makeStore();

    assert.strictEqual(store.add({ title: "a", level: "info", ttl: 1 }).notice.ttl, 1_000);
    assert.strictEqual(
      store.add({ title: "b", level: "info", ttl: 99 * 24 * 60 * 60 * 1000 }).notice.ttl,
      24 * 60 * 60 * 1000
    );
  });
});

describe("notice store — keyed push", () => {
  // add() answers { notice, replaced } — or null when the push is refused. The
  // flag is the store reporting what it actually did, rather than a caller
  // predicting it from a key it looked up for itself first.

  it("carries the key on the notice and creates a card like any other push", () => {
    const store = makeStore();
    const { notice, replaced } = store.add({ title: "hb", key: "heartbeat" });

    assert.strictEqual(notice.key, "heartbeat");
    assert.strictEqual(replaced, false);
    assert.strictEqual(store.list().length, 1);
    assert.strictEqual(store.list()[0].key, "heartbeat");
  });

  it("replaces the live notice with the same key instead of stacking a twin", () => {
    const clock = makeClock();
    const store = makeTimedStore(clock);
    const first = store.add({ title: "hb 1", key: "heartbeat", level: "error", ttl: 300_000 });
    clock.advance(5_000);
    const second = store.add({ title: "hb 2", key: "heartbeat", level: "success", ttl: 30_000 });

    assert.strictEqual(second.replaced, true);
    assert.strictEqual(store.list().length, 1, "one live notice per key");

    const [notice] = store.list();
    assert.strictEqual(notice.id, first.notice.id, "the id is what the renderer diffs by");
    assert.strictEqual(notice.createdAt, first.notice.createdAt, "it is still the same card");
    assert.strictEqual(notice.key, "heartbeat");
    assert.strictEqual(notice.title, "hb 2");
    assert.strictEqual(notice.level, "success", "an error card re-pushed as success is a success card");
    assert.strictEqual(notice.ttl, 30_000, "the new push's ttl wins");
    assert.strictEqual(notice.expiresAt, clock.now() + 30_000, "the ttl clock restarts");
  });

  it("keeps a replaced card where it was in the stack", () => {
    const store = makeStore();
    const a = store.add({ title: "a" });
    const b = store.add({ title: "b", key: "mid" });
    const c = store.add({ title: "c" });
    const again = store.add({ title: "b again", key: "mid" });

    assert.strictEqual(again.notice.id, b.notice.id);
    assert.deepStrictEqual(store.list().map((n) => n.id), [a.notice.id, b.notice.id, c.notice.id]);
    assert.deepStrictEqual(store.list().map((n) => n.title), ["a", "b again", "c"]);
  });

  it("takes a replaced card's kind and series from the new push", () => {
    const store = makeStore();
    const first = store.add({ title: "t", key: "k" });
    const second = store.add({ title: "t", key: "k", series: [series("s", [1, 2])] });

    assert.strictEqual(first.notice.kind, DEFAULT_KIND);
    assert.strictEqual(second.replaced, true);
    assert.strictEqual(second.notice.kind, TREND_KIND, "the card becomes the chart it was re-pushed as");
    assert.strictEqual(second.notice.series.length, 1);
  });

  it("appends a push under a different key, and an unkeyed push under none", () => {
    const store = makeStore();
    store.add({ title: "a", key: "one" });
    store.add({ title: "b", key: "two" });
    store.add({ title: "c" });

    assert.strictEqual(store.list().length, 3);
  });

  it("does not burn a notice id on a replace", () => {
    const store = makeStore();
    const first = store.add({ title: "a", key: "k" });
    store.add({ title: "b", key: "k" });
    const next = store.add({ title: "c" });

    assert.strictEqual(first.notice.id, "notice-1");
    assert.strictEqual(next.notice.id, "notice-2");
    assert.strictEqual(store.list().length, 2);
  });

  it("keeps one card per key even at the notice cap", () => {
    const store = createNoticeStore({ max: 2 });
    const a = store.add({ title: "a" });
    const b = store.add({ title: "b", key: "k" });
    const again = store.add({ title: "b again", key: "k" });

    assert.strictEqual(again.replaced, true);
    assert.deepStrictEqual(store.list().map((n) => n.id), [a.notice.id, b.notice.id]);
  });

  it("trims the key, so a padded key matches its bare form", () => {
    const store = makeStore();
    const first = store.add({ title: "a", key: "  hb  " });
    assert.strictEqual(first.notice.key, "hb");

    const second = store.add({ title: "b", key: "hb" });
    assert.strictEqual(second.replaced, true);
    assert.strictEqual(store.list().length, 1);
  });

  it("starts a fresh card when the keyed notice has already expired", () => {
    const clock = makeClock();
    const store = makeTimedStore(clock);
    const first = store.add({ title: "hb", key: "heartbeat", level: "info", ttl: 20_000 });
    clock.advance(25_000);

    const second = store.add({ title: "hb again", key: "heartbeat", level: "info", ttl: 20_000 });

    assert.strictEqual(second.replaced, false, "there was nothing live to replace");
    assert.notStrictEqual(second.notice.id, first.notice.id, "so this is a new card, not a revived one");
    assert.strictEqual(store.list().length, 1);
  });

  it("treats an over-long key as absent", () => {
    const tooLong = "k".repeat(MAX_KEY_LENGTH + 1);
    const store = makeStore();
    const first = store.add({ title: "a", key: tooLong });

    assert.strictEqual(first.notice.key, "");
    assert.strictEqual(first.replaced, false);

    const second = store.add({ title: "b", key: tooLong });
    assert.strictEqual(second.replaced, false, "an unusable key never matches anything");
    assert.strictEqual(store.list().length, 2);
  });

  it("keeps a key of exactly the cap", () => {
    const atCap = "k".repeat(MAX_KEY_LENGTH);
    const store = makeStore();
    const first = store.add({ title: "a", key: atCap });
    const second = store.add({ title: "b", key: atCap });

    assert.strictEqual(first.notice.key, atCap);
    assert.strictEqual(second.replaced, true);
    assert.strictEqual(store.list().length, 1);
  });

  it("treats a key with control characters as absent", () => {
    const store = makeStore();

    for (const bad of ["a\nb", "a\tb", "a\u0000b", "a\u007fb", "a\u009fb"]) {
      const { notice, replaced } = store.add({ title: "x", key: bad });
      assert.strictEqual(notice.key, "", `key ${JSON.stringify(bad)}`);
      assert.strictEqual(replaced, false);
    }
    assert.strictEqual(store.list().length, 5, "every one of them appended");
  });

  it("treats an empty, whitespace or non-string key as absent", () => {
    assert.strictEqual(normalizeKey(""), "");
    assert.strictEqual(normalizeKey("   "), "");
    assert.strictEqual(normalizeKey(undefined), "");
    assert.strictEqual(normalizeKey(null), "");
    assert.strictEqual(normalizeKey(42), "");
    assert.strictEqual(normalizeKey({ key: "k" }), "");
    assert.strictEqual(normalizeKey([]), "");

    const store = makeStore();
    for (const absent of [undefined, "", "   ", 42]) {
      const { notice } = store.add({ title: "x", key: absent });
      assert.strictEqual(notice.key, "");
    }
    assert.strictEqual(store.list().length, 4, "no key means no match");
  });
});

describe("notice store — removal", () => {
  // removeByKey is the identity twin of the keyed push: add() refreshes the
  // live notice a key names, removeByKey takes it away. What it returns is what
  // the DELETE route reports, so 0 has to mean "nothing matched" rather than
  // "that failed" — removing a card that is already gone is not an error.

  it("removes the notice carrying the key and counts it", () => {
    const store = makeStore();
    const a = store.add({ title: "a" });
    const b = store.add({ title: "b", key: "pomodoro" });

    assert.strictEqual(store.removeByKey("pomodoro"), 1);
    assert.deepStrictEqual(store.list().map((n) => n.id), [a.notice.id]);
    assert.ok(!store.list().some((n) => n.id === b.notice.id));
  });

  it("answers 0 for a key nothing carries, and removes nothing", () => {
    const store = makeStore();
    store.add({ title: "a", key: "pomodoro" });

    assert.strictEqual(store.removeByKey("heartbeat"), 0);
    assert.strictEqual(store.list().length, 1);
  });

  it("trims the key, so a padded key matches its bare form", () => {
    const store = makeStore();
    store.add({ title: "a", key: "pomodoro" });

    assert.strictEqual(store.removeByKey("  pomodoro  "), 1);
    assert.deepStrictEqual(store.list(), []);
  });

  it("treats an unusable key as no match rather than an error", () => {
    const store = makeStore();
    store.add({ title: "a", key: "pomodoro" });

    for (const bad of [undefined, null, 42, "", "   ", "k".repeat(MAX_KEY_LENGTH + 1), "a\nb"]) {
      assert.strictEqual(store.removeByKey(bad), 0, `key ${JSON.stringify(bad)}`);
    }
    assert.strictEqual(store.list().length, 1, "the keyed notice survived every one of them");
  });

  it("leaves the other notices and their order intact", () => {
    const store = makeStore();
    const a = store.add({ title: "a" });
    const b = store.add({ title: "b", key: "mid" });
    const c = store.add({ title: "c" });

    assert.strictEqual(store.removeByKey("mid"), 1);
    assert.deepStrictEqual(store.list().map((n) => n.id), [a.notice.id, c.notice.id]);
    assert.deepStrictEqual(store.list().map((n) => n.title), ["a", "c"]);
    assert.ok(b.notice.id !== a.notice.id);
  });

  it("empties the list when the only notice goes", () => {
    const store = makeStore();
    store.add({ title: "a", key: "only" });

    assert.strictEqual(store.removeByKey("only"), 1);
    assert.deepStrictEqual(store.list(), []);
  });

  it("does not match a keyed notice that has already expired", () => {
    const clock = makeClock();
    const store = makeTimedStore(clock);
    store.add({ title: "hb", key: "heartbeat", level: "info", ttl: 20_000 });
    clock.advance(25_000);

    assert.strictEqual(store.removeByKey("heartbeat"), 0, "there was nothing live to remove");
    assert.deepStrictEqual(store.list(), []);
  });

  it("notifies subscribers when a keyed notice goes", () => {
    const store = makeStore();
    const seen = [];
    store.subscribe((snapshot) => seen.push(snapshot.length));
    store.add({ title: "a", key: "k" });
    store.removeByKey("k");

    assert.deepStrictEqual(seen, [1, 0]);
  });

  it("answers 0 once the store is disposed", () => {
    const store = makeStore();
    store.add({ title: "a", key: "k" });
    store.dispose();

    assert.strictEqual(store.removeByKey("k"), 0);
  });

  it("reports how many notices clear() took", () => {
    const store = makeStore();
    store.add({ title: "a" });
    store.add({ title: "b", key: "k" });
    store.add({ title: "c" });

    assert.strictEqual(store.clear(), 3);
    assert.deepStrictEqual(store.list(), []);
  });

  it("clears an empty store as a no-op answering 0", () => {
    const store = makeStore();

    assert.strictEqual(store.clear(), 0);
    assert.strictEqual(store.clear(), 0);
    assert.deepStrictEqual(store.list(), []);
  });

  it("counts only the live notices when clear() prunes first", () => {
    const clock = makeClock();
    const store = makeTimedStore(clock);
    store.add({ title: "gone", level: "info", ttl: 20_000 });
    clock.advance(25_000);
    store.add({ title: "live", level: "info", ttl: 20_000 });

    assert.strictEqual(store.clear(), 1, "the expired card is not a card that was cleared");
  });

  it("notifies subscribers when clear() empties the stack", () => {
    const store = makeStore();
    const seen = [];
    store.subscribe((snapshot) => seen.push(snapshot.length));
    store.add({ title: "a" });
    store.add({ title: "b" });
    store.clear();

    assert.deepStrictEqual(seen, [1, 2, 0]);
  });

  it("answers 0 from clear() once the store is disposed", () => {
    const store = makeStore();
    store.add({ title: "a" });
    store.dispose();

    assert.strictEqual(store.clear(), 0);
  });
});

describe("notice store — expiry paused during a stretch break", () => {
  it("keeps every card past its TTL while paused and gives back the wait", () => {
    const clock = makeClock();
    const store = makeTimedStore(clock);
    const before = store.add({ title: "before", ttl: 10_000 }).notice;
    clock.advance(4_000);
    assert.strictEqual(store.pauseExpiry(), true);
    assert.strictEqual(store.isExpiryPaused(), true);
    clock.advance(30_000);
    const during = store.add({ title: "during", ttl: 10_000 }).notice;
    clock.advance(60_000);
    assert.deepStrictEqual(store.list().map((n) => n.title), ["before", "during"]);
    assert.strictEqual(store.resumeExpiry(), true);
    const [b, d] = store.list();
    // "before" had 6 s left at the pause, "during" its whole 10 s.
    assert.strictEqual(b.expiresAt - clock.now(), 6_000);
    assert.strictEqual(d.expiresAt - clock.now(), 10_000);
    assert.strictEqual(b.id, before.id);
    assert.strictEqual(d.id, during.id);
    clock.advance(6_001);
    assert.deepStrictEqual(store.list().map((n) => n.title), ["during"]);
    clock.advance(4_000);
    assert.deepStrictEqual(store.list(), []);
  });

  it("pause and resume are idempotent", () => {
    const store = makeTimedStore(makeClock());
    assert.strictEqual(store.resumeExpiry(), false);
    assert.strictEqual(store.pauseExpiry(), true);
    assert.strictEqual(store.pauseExpiry(), false);
    assert.strictEqual(store.resumeExpiry(), true);
    assert.strictEqual(store.isExpiryPaused(), false);
  });
});

describe("notice store — sticky cards", () => {
  it("is off unless the caller says the literal true", () => {
    const store = makeStore();
    for (const value of [undefined, null, false, "true", 1, "yes", {}]) {
      const { notice } = store.add({ title: `s-${String(value)}`, sticky: value });
      assert.strictEqual(notice.sticky, false, `sticky=${String(value)}`);
    }
  });

  it("keeps an explicit true so a list card cannot be click-dismissed", () => {
    const store = makeStore();
    const { notice } = store.add({ title: "digest", sticky: true });
    assert.strictEqual(notice.sticky, true);
  });

  it("a keyed replace takes the new sticky value both ways", () => {
    const store = makeStore();
    store.add({ key: "k", title: "one", sticky: true });
    const { notice } = store.add({ key: "k", title: "two", sticky: false });
    assert.strictEqual(notice.sticky, false);
  });
});

describe("notice store — presentation", () => {
  it("defaults to the pet's bubble", () => {
    const store = makeStore();
    const { notice } = store.add({ title: "hello" });
    assert.strictEqual(notice.presentation, "bubble");
  });

  it("keeps an explicit card presentation", () => {
    const store = makeStore();
    const { notice } = store.add({ title: "hello", presentation: "card" });
    assert.strictEqual(notice.presentation, "card");
  });

  it("treats anything but the exact card string as the bubble", () => {
    const store = makeStore();
    for (const value of ["Card", "big", "", 1, null, undefined]) {
      const { notice } = store.add({ title: `t-${String(value)}`, presentation: value });
      assert.strictEqual(notice.presentation, "bubble", `presentation=${String(value)}`);
    }
  });

  it("a keyed replace takes the new presentation", () => {
    const store = makeStore();
    store.add({ key: "k", title: "one", presentation: "card" });
    const { notice, replaced } = store.add({ key: "k", title: "two", presentation: "bubble" });
    assert.strictEqual(replaced, true);
    assert.strictEqual(notice.presentation, "bubble");
  });
});
