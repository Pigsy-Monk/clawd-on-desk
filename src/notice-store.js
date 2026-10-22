"use strict";

// In-memory store for agent-pushed notices.
//
// Deliberately memory-only: a notice is a transient "the agent wants to say
// something right now" card, not history. Nothing here is persisted, and the
// store is bounded twice over (count cap + per-notice TTL) so a misbehaving
// pusher cannot grow the main process without limit. The opt-out local
// record of what cards said lives in notice-history.js, which only observes
// this store's snapshots.
//
// The store is the single validator. `/notice` parses JSON and hands the raw
// object here; anything malformed is normalized or dropped at this boundary so
// no consumer (bubble window, renderer, IPC) has to re-check shapes.
//
// A push may carry a `key`: an optional identity label that makes the push
// idempotent. A keyed push whose key matches a live notice replaces that notice
// in place — same id, same createdAt, same position in the stack — instead of
// stacking a twin, which is what lets a heartbeat or a countdown refresh one
// card forever rather than piling up twenty.
//
// A key is also how a notice is taken back: removeByKey matches on the same
// identity the push used, so an agent that cancels a countdown retracts the
// exact card it pushed instead of leaving a lying countdown on screen until the
// TTL runs out. Removing by id and clearing the whole stack are the other two
// selectors; all three report how many notices actually went, and 0 is a normal
// answer rather than an error.
//
// Beyond a line of prose a notice may carry a trend chart (`kind: "trend"` plus
// a bounded `series` list) and a PNG image. Both are validated hard here for the
// same reason: the renderer hands `image.data` straight to an image loader and
// draws `series` straight into a sparkline, so a blob that merely claims to be a
// PNG or a series that is not a list of finite numbers must never get through.

const { normalizePose } = require("./notice-pose");

const DEFAULT_MAX_NOTICES = 20;
const DEFAULT_TTL_MS = 60_000;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 4000;
const MAX_KEY_LENGTH = 64;

const LEVELS = Object.freeze(["info", "success", "warn", "error"]);
const LEVEL_SET = new Set(LEVELS);
const DEFAULT_LEVEL = "info";

// How a push wants to be shown. `bubble` is the pet's own way: it holds the
// notice up on its sign and keeps the card back until the board is clicked
// (src/main.js shouldHoldNotice). `card` asks for the card itself, at once —
// no sign, no click, visible for the notice's ttl — which is what a monitoring
// pusher that cannot rely on the user noticing a 4-second sign needs.
const PRESENTATIONS = Object.freeze(["bubble", "card"]);
const DEFAULT_PRESENTATION = "bubble";

const DEFAULT_KIND = "text";
const TREND_KIND = "trend";
// A card with a little figure acting something out (`pose`, see
// src/notice-pose.js). Like a trend card, the data decides the kind.
const POSE_KIND = "pose";
// A sparkline needs a handful of series, not a wall of them, and only the
// recent tail of a series is worth drawing. Both caps keep a pusher from
// handing the renderer an unbounded amount of work per card.
const MAX_SERIES = 8;
const MAX_SERIES_POINTS = 240;
const MAX_SERIES_NAME_LENGTH = 40;
const MAX_SERIES_UNIT_LENGTH = 12;

const PNG_MIME = "image/png";
// The decoded byte cap. The route accepts a much larger body because base64
// inflates the payload by a third and a legitimate screenshot is a few hundred
// KB, but nothing above this reaches the renderer.
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
// The 8-byte PNG signature: 89 50 4E 47 0D 0A 1A 0A.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Standard base64 alphabet with optional padding — nothing else. A `data:` URI
// prefix, embedded whitespace or the URL-safe alphabet all fail this test, and
// they have to: `Buffer.from(value, "base64")` silently skips the characters it
// does not recognize, so without the check a `data:image/png;base64,...` string
// would decode into plausible-looking garbage.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// Every Unicode control character (C0, DEL and C1). Written as a property
// escape rather than a literal character class so this file stays plain ASCII.
// Tab and newline are the two the card actually renders, so they survive; the
// rest become spaces instead of vanishing mid-word.
const CONTROL_CHARS_RE = /\p{Cc}/gu;

function stripControlChars(text) {
  return text.replace(CONTROL_CHARS_RE, (ch) => (ch === "\n" || ch === "\t" ? ch : " "));
}

function normalizeText(value, maxLength) {
  if (typeof value !== "string") return "";
  const text = stripControlChars(value.replace(/\r\n?/g, "\n"))
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

// The same control-character definition the text policy uses — the C0, DEL and
// C1 ranges — as a plain (non-global) pattern. `.test()` against the /g
// CONTROL_CHARS_RE above would advance lastIndex and then miss every other key.
const HAS_CONTROL_CHARS_RE = /\p{Cc}/u;

// A key is an identity label, not text: it is matched against other pushes and
// never rendered, so unlike a title there is nothing worth preserving. It gets
// the same control-character definition the text policy uses, plus a hard trim,
// and anything else — empty, over-long, a stray newline, a non-string — collapses
// to the same "" as "no key at all". That is deliberate: a malformed key is
// treated as absent, so it degrades to an ordinary append rather than becoming
// an error the pusher has to go and debug. Note this is stricter than
// normalizeText, which keeps the newline and tab it can render.
function normalizeKey(value) {
  if (typeof value !== "string") return "";
  const key = value.trim();
  if (!key || key.length > MAX_KEY_LENGTH) return "";
  if (HAS_CONTROL_CHARS_RE.test(key)) return "";
  return key;
}

function normalizeLevel(value) {
  return typeof value === "string" && LEVEL_SET.has(value) ? value : DEFAULT_LEVEL;
}

// Default lifetime per level. A card's level is how loudly it speaks, so it also
// decides how long it is worth screen time: an info card is a glance, an error
// card is something the user has to come back and deal with.
const LEVEL_TTL_MS = Object.freeze({
  info: 20_000,
  success: 30_000,
  warn: 120_000,
  error: 300_000,
});

// Invalid or absent TTL falls back to the level's default rather than rejecting
// the notice: a card with a slightly wrong lifetime is still useful, and the
// clamp keeps an absurd value from parking a card on screen indefinitely.
function normalizeTtl(value, level) {
  const ttl = Number(value);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    return LEVEL_TTL_MS[level] || DEFAULT_TTL_MS;
  }
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.round(ttl)));
}

// Only the exact string "card" asks for the card straight away; everything
// else — absent, "bubble", a misspelling, a different casing — is the pet's
// own presentation. Guessing at near-misses would mean a typo silently changes
// how loud a card is.
function normalizePresentation(value) {
  return value === "card" ? "card" : DEFAULT_PRESENTATION;
}

// Only the exact string "trend" makes a chart card; everything else — absent,
// misspelled, a different casing — is prose. Guessing at near-misses would mean
// a typo silently changes what the card renders.
function normalizeKind(value) {
  return value === TREND_KIND ? TREND_KIND : DEFAULT_KIND;
}

function normalizePoints(value) {
  if (!Array.isArray(value)) return [];
  const points = [];
  for (const point of value) {
    if (typeof point === "number" && Number.isFinite(point)) points.push(point);
  }
  // Keep the tail: a sparkline shows where a metric is going, and the newest
  // samples are the ones worth the pixels.
  return points.length > MAX_SERIES_POINTS ? points.slice(-MAX_SERIES_POINTS) : points;
}

// One series, or null when it has nothing drawable. A line needs a name to
// label it and at least two finite points to span; anything less is dropped
// rather than rendered as a degenerate stub.
function normalizeSeriesEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const name = normalizeText(value.name, MAX_SERIES_NAME_LENGTH);
  if (!name) return null;
  const points = normalizePoints(value.points);
  if (points.length < 2) return null;
  const current = typeof value.value === "number" && Number.isFinite(value.value)
    ? value.value
    : null;
  return Object.freeze({
    name,
    points: Object.freeze(points),
    value: current,
    unit: normalizeText(value.unit, MAX_SERIES_UNIT_LENGTH),
  });
}

function normalizeSeries(value) {
  if (!Array.isArray(value)) return [];
  const series = [];
  for (const entry of value) {
    if (series.length >= MAX_SERIES) break;
    const normalized = normalizeSeriesEntry(entry);
    if (normalized) series.push(normalized);
  }
  return series;
}

function isPng(bytes) {
  return bytes.length >= PNG_SIGNATURE.length
    && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

// A PNG, or null. The mime has to be exactly image/png, the payload a bare
// base64 string (no `data:` prefix), the decoded size under the cap, and the
// decoded bytes have to actually begin with the PNG signature — the renderer
// feeds these bytes to an image loader, so "it decoded without throwing" is not
// good enough. Anything else is dropped instead of failing the whole notice.
function normalizeImage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.mime !== PNG_MIME) return null;
  const data = value.data;
  if (typeof data !== "string" || data.length % 4 !== 0 || !BASE64_RE.test(data)) return null;
  // Base64 spends four characters per three bytes, so a payload longer than
  // this cannot possibly decode under the cap — reject before allocating.
  if (data.length > (MAX_IMAGE_BYTES / 3) * 4) return null;
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > MAX_IMAGE_BYTES) return null;
  if (!isPng(bytes)) return null;
  return Object.freeze({ mime: PNG_MIME, data });
}

function createNoticeStore(options = {}) {
  const maxNotices = Number.isInteger(options.max) && options.max > 0
    ? options.max
    : DEFAULT_MAX_NOTICES;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const setTimer = typeof options.setTimer === "function" ? options.setTimer : setTimeout;
  const clearTimer = typeof options.clearTimer === "function" ? options.clearTimer : clearTimeout;

  // Oldest → newest. The bubble renders this order, so the newest card sits
  // closest to the pet.
  let notices = [];
  const listeners = new Set();
  let expiryTimer = null;
  let nextId = 1;
  let disposed = false;
  // While paused (a stretch break is on screen and new cards wait for it)
  // nothing expires; resumeExpiry() gives every card back the time it spent
  // waiting, so a card pushed mid-break still gets its whole TTL afterwards.
  let pausedAt = null;

  function pruneExpired(at) {
    if (pausedAt !== null) return false;
    const before = notices.length;
    notices = notices.filter((notice) => notice.expiresAt > at);
    return notices.length !== before;
  }

  function scheduleExpiry() {
    if (expiryTimer !== null) {
      clearTimer(expiryTimer);
      expiryTimer = null;
    }
    if (disposed || notices.length === 0 || pausedAt !== null) return;
    // One timer aimed at the earliest deadline; on fire it prunes everything
    // due and re-arms. Avoids a timer per notice.
    const earliest = Math.min(...notices.map((notice) => notice.expiresAt));
    const delay = Math.max(1, earliest - now());
    expiryTimer = setTimer(() => {
      expiryTimer = null;
      if (disposed) return;
      if (pruneExpired(now())) emit();
      scheduleExpiry();
    }, delay);
    if (expiryTimer && typeof expiryTimer.unref === "function") expiryTimer.unref();
  }

  function emit() {
    const snapshot = list();
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch {}
    }
  }

  function list() {
    pruneExpired(now());
    return notices.slice();
  }

  function add(raw) {
    if (disposed || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const key = normalizeKey(raw.key);
    const title = normalizeText(raw.title, MAX_TITLE_LENGTH);
    const body = normalizeText(raw.body, MAX_BODY_LENGTH);
    const series = normalizeSeries(raw.series);
    const image = normalizeImage(raw.image);
    const declared = normalizeKind(raw.kind);
    // Series exist to be drawn, so their presence is what makes a chart card —
    // `kind` is a declaration of intent, not the only way in. Deriving this way
    // means a caller who sends `series` without `kind` gets the chart it asked
    // for, instead of a text card with the data silently unused. And a declared
    // chart card with nothing to draw degrades to text, so the renderer is never
    // handed a sparkline with no points behind it.
    const pose = series.length > 0 ? null : normalizePose(raw.pose);
    const kind = series.length > 0
      ? TREND_KIND
      : (pose ? POSE_KIND : (declared === TREND_KIND ? DEFAULT_KIND : declared));
    // A card with no line, no chart, no picture and no figure has nothing to
    // say; refuse rather than render an empty box. A chart-only, image-only or
    // figure-only card is a legitimate notice, so those count as content too.
    if (!title && !body && series.length === 0 && !image && !pose) return null;

    const level = normalizeLevel(raw.level);
    const ttl = normalizeTtl(raw.ttl, level);
    const presentation = normalizePresentation(raw.presentation);
    const at = now();
    // Everything a replace takes wholesale from the new push. The two identity
    // fields are not in here: they are what the replace preserves.
    const content = {
      key,
      title,
      body,
      level,
      kind,
      presentation,
      series: Object.freeze(series),
      image,
      pose,
      ttl,
      expiresAt: at + ttl,
    };

    // A keyed push is idempotent by identity: the same key names the same card,
    // so a repeat refreshes the live one instead of stacking a twin. Pruning
    // first is what makes that "live" honest — a key whose notice has already
    // timed out starts a fresh card rather than reviving one the user has
    // stopped seeing. An unkeyed push never matches anything.
    pruneExpired(at);
    const index = key ? notices.findIndex((notice) => notice.key === key) : -1;
    if (index !== -1) {
      const previous = notices[index];
      // Same id, same createdAt, same slot in the array — all three on purpose.
      // The renderer diffs by id, so a stable id makes this an update in place
      // rather than a remove and a re-add, which would replay the entrance
      // bounce and the tail wiggle on every heartbeat; and holding the index
      // keeps the card where it is in the stack instead of hopping to the end.
      const notice = Object.freeze({
        id: previous.id,
        createdAt: previous.createdAt,
        ...content,
      });
      notices[index] = notice;
      scheduleExpiry();
      emit();
      return { notice, replaced: true };
    }

    const notice = Object.freeze({
      id: `notice-${nextId++}`,
      createdAt: at,
      ...content,
    });

    notices.push(notice);
    if (notices.length > maxNotices) notices = notices.slice(notices.length - maxNotices);
    scheduleExpiry();
    emit();
    return { notice, replaced: false };
  }

  function remove(id) {
    if (disposed || typeof id !== "string") return false;
    const next = notices.filter((notice) => notice.id !== id);
    if (next.length === notices.length) return false;
    notices = next;
    scheduleExpiry();
    emit();
    return true;
  }

  // The identity twin of the keyed push: where add() refreshes the live notice a
  // key names, removeByKey takes that notice away. Pruning first is what makes
  // the match honest — a key whose notice has already timed out is not a live
  // notice to remove — and a key this store cannot vouch for is "no match"
  // rather than an error, the same reading add() takes when it treats an
  // unusable key as absent. The answer is a count, because the caller (the
  // DELETE route) has to report it: 0 is a normal answer, not a failure.
  function removeByKey(key) {
    if (disposed) return 0;
    const normalized = normalizeKey(key);
    if (!normalized) return 0;
    const pruned = pruneExpired(now());
    const next = notices.filter((notice) => notice.key !== normalized);
    const removed = notices.length - next.length;
    if (removed === 0 && !pruned) return 0;
    notices = next;
    scheduleExpiry();
    emit();
    return removed;
  }

  // Empty the stack, reporting how many live notices went — a caller that says
  // "cleared N" then counts what actually happened rather than what it asked
  // for. Pruning first keeps that count honest against the same clock list()
  // uses, and an already-empty store is a no-op answering 0.
  function clear() {
    if (disposed) return 0;
    pruneExpired(now());
    const removed = notices.length;
    if (removed === 0) return 0;
    notices = [];
    scheduleExpiry();
    emit();
    return removed;
  }

  function pauseExpiry() {
    if (disposed || pausedAt !== null) return false;
    pruneExpired(now());
    pausedAt = now();
    scheduleExpiry();
    return true;
  }

  // Each card's deadline moves by the time it spent waiting: since the pause
  // for a card that was already up, since its own push for one that arrived
  // during the pause. Ids and createdAt stay, so nothing re-renders.
  function resumeExpiry() {
    if (disposed || pausedAt === null) return false;
    const at = now();
    const since = pausedAt;
    pausedAt = null;
    notices = notices.map((notice) => {
      const pushedAt = notice.expiresAt - notice.ttl;
      const waited = Math.max(0, at - Math.max(since, pushedAt));
      return waited > 0 ? Object.freeze({ ...notice, expiresAt: notice.expiresAt + waited }) : notice;
    });
    scheduleExpiry();
    return true;
  }

  function subscribe(listener) {
    if (typeof listener !== "function" || disposed) return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function dispose() {
    disposed = true;
    if (expiryTimer !== null) {
      clearTimer(expiryTimer);
      expiryTimer = null;
    }
    listeners.clear();
    notices = [];
  }

  return {
    add,
    remove,
    removeByKey,
    clear,
    list,
    subscribe,
    pauseExpiry,
    resumeExpiry,
    isExpiryPaused: () => pausedAt !== null,
    dispose,
    maxNotices,
  };
}

module.exports = {
  createNoticeStore,
  DEFAULT_MAX_NOTICES,
  DEFAULT_TTL_MS,
  MIN_TTL_MS,
  MAX_TTL_MS,
  MAX_TITLE_LENGTH,
  MAX_BODY_LENGTH,
  MAX_KEY_LENGTH,
  LEVELS,
  DEFAULT_LEVEL,
  LEVEL_TTL_MS,
  PRESENTATIONS,
  DEFAULT_PRESENTATION,
  DEFAULT_KIND,
  TREND_KIND,
  POSE_KIND,
  MAX_SERIES,
  MAX_SERIES_POINTS,
  MAX_SERIES_NAME_LENGTH,
  MAX_SERIES_UNIT_LENGTH,
  PNG_MIME,
  MAX_IMAGE_BYTES,
  __test: {
    normalizeText,
    normalizeKey,
    normalizeLevel,
    normalizeTtl,
    normalizePresentation,
    normalizeKind,
    normalizePoints,
    normalizeSeriesEntry,
    normalizeSeries,
    normalizeImage,
    isPng,
  },
};
