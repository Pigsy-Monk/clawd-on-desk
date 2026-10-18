"use strict";

// Local history of agent-pushed notices (~/.clawd/notice-history-v1/).
//
// notice-store.js is deliberately memory-only: a card is "the agent wants to
// say something right now". This module is the separate, opt-out record of
// what those cards said, so the text survives a dismissal, an expiry or a
// restart. It is fed from the store's snapshots and never sits on the /notice
// path itself: observe() only touches memory, and every disk write happens
// later on a timer. Failures are logged (throttled) and swallowed.
//
// Storage. One append-only JSONL file per local day, `YYYY-MM-DD.jsonl`. Each
// line is the full current version of one notice, identified by `hid` — this
// run's random id plus the store's notice id. The store keeps the id on a
// keyed replace, so every refresh of one card shares one hid, and readers
// collapse lines by hid with the newest version winning. That is what turns a
// monitor re-pushing every 2 s into exactly one history row.
//
// What gets written is bounded by distinct notices, not by pushes: one line
// when a notice first appears, one when it leaves the stack (dismissed,
// expired, evicted, retracted) if it changed in between, and a checkpoint at
// most every CHECKPOINT_MS for a card that keeps changing while it stays up —
// so a crash loses at most that much of a long-lived card's latest text, and
// never the card itself. A day file whose lines are mostly superseded is
// compacted to one line per entry (temp file + rename), and the in-memory
// index is capped at MAX_ENTRIES. Retention is RETENTION_DAYS: entries and
// whole day files past it are pruned at startup and hourly.
//
// Never stored: the image (up to 6 MB of base64; only a hasImage flag is
// kept) and the raw series points (only each series' name, latest value and
// unit). Notice text is the agent's own words and may contain anything it
// chose to push, so the directory and files are created owner-only (0700 /
// 0600 — POSIX modes; on Windows this relies on the user profile's ACL).

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  LEVELS,
  DEFAULT_LEVEL,
  DEFAULT_KIND,
  TREND_KIND,
  POSE_KIND,
  MAX_TITLE_LENGTH,
  MAX_BODY_LENGTH,
  MAX_KEY_LENGTH,
  MAX_SERIES,
  MAX_SERIES_NAME_LENGTH,
  MAX_SERIES_UNIT_LENGTH,
} = require("./notice-store");

const SCHEMA_VERSION = 1;
const HISTORY_DIR_NAME = "notice-history-v1";
const DEFAULT_DIR = path.join(os.homedir(), ".clawd", HISTORY_DIR_NAME);
const RETENTION_DAYS = 7;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
// The in-memory index (and therefore what one compaction can rewrite) never
// holds more than this many entries; the oldest by last update go first.
const MAX_ENTRIES = 1000;
// One line is one notice: a 4000-char body plus a 200-char title, JSON-escaped
// and UTF-8 encoded, stays well under this. A line over it is not ours.
const MAX_LINE_BYTES = 32 * 1024;
// A day file this large is rewritten from memory before the next append, and
// one larger than the read cap is not read at all (and never rewritten).
const MAX_DAY_FILE_BYTES = 4 * 1024 * 1024;
const MAX_READ_FILE_BYTES = 8 * 1024 * 1024;
// A day file is compacted once it carries this many superseded lines beyond
// its live ones; small enough to keep files tight, large enough that a busy
// day is not rewritten on every maintenance tick.
const COMPACT_SLACK_LINES = 200;
const FLUSH_DELAY_MS = 1000;
const FLUSH_RETRY_MS = 30 * 1000;
const CHECKPOINT_MS = 5 * 60 * 1000;
const MAINTENANCE_INTERVAL_MS = 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
// The dashboard re-reads on change; a live monitor must not make it re-read
// every two seconds.
const CHANGE_THROTTLE_MS = 1000;
const WARN_THROTTLE_MS = 10 * 60 * 1000;
const TEMP_FILE_TTL_MS = 24 * 60 * 60 * 1000;

const LEVEL_SET = new Set(LEVELS);
// A pose card is kept as its title and body; the animation itself is not.
const KIND_SET = new Set([DEFAULT_KIND, TREND_KIND, POSE_KIND]);
const DAY_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
const TEMP_FILE_RE = /^\.\d{4}-\d{2}-\d{2}\.jsonl\.\d+\.[0-9a-f]+\.tmp$/;
// `<run id>:<store notice id>`. The store's ids are `notice-<n>`; the pattern
// is a little wider so a future id format still reads back.
const HID_RE = /^[A-Za-z0-9_-]{6,32}:[A-Za-z0-9_-]{1,64}$/;
const NOTICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// The local calendar day an instant falls in. Local on purpose: the dashboard
// shows wall-clock days, and retention is "a week of the user's days".
function dayKeyOf(ms) {
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// [start, end) of a day key in epoch ms, or null for a malformed or
// impossible date. Local midnight to local midnight, so a DST day is 23 or 25
// hours long rather than drifting by one.
function dayBounds(dayKey) {
  const match = DAY_FILE_RE.exec(`${dayKey}.jsonl`);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const start = new Date(year, month, day);
  if (start.getFullYear() !== year || start.getMonth() !== month || start.getDate() !== day) {
    return null;
  }
  return { start: start.getTime(), end: new Date(year, month, day + 1).getTime() };
}

function boundedText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// The part of a trend series worth keeping: what the card showed as the
// current reading. A store series carries `value` (explicit) and `points`
// (the sparkline); the latest reading is `value`, else the last point —
// the same rule the bubble uses. A history series carries `value` already.
function summarizeSeries(series) {
  if (!Array.isArray(series)) return [];
  const out = [];
  for (const entry of series) {
    if (out.length >= MAX_SERIES) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const name = boundedText(entry.name, MAX_SERIES_NAME_LENGTH);
    if (!name) continue;
    const points = Array.isArray(entry.points) ? entry.points : [];
    const value = finiteOrNull(entry.value) ?? finiteOrNull(points[points.length - 1]);
    out.push({ name, value, unit: boundedText(entry.unit, MAX_SERIES_UNIT_LENGTH) });
  }
  return out;
}

// One history entry, or null. The single validator for both directions: a
// line read back from disk and an entry built from a live notice go through
// the same shape check, so nothing the dashboard receives has to be re-checked.
function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.hid !== "string" || !HID_RE.test(raw.hid)) return null;
  const createdAt = raw.createdAt;
  const updatedAt = raw.updatedAt;
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) return null;
  if (!Number.isSafeInteger(updatedAt) || updatedAt < createdAt) return null;
  if (!LEVEL_SET.has(raw.level)) return null;
  if (!KIND_SET.has(raw.kind)) return null;
  const title = boundedText(raw.title, MAX_TITLE_LENGTH);
  const body = boundedText(raw.body, MAX_BODY_LENGTH);
  const series = summarizeSeries(raw.series);
  const hasImage = raw.hasImage === true;
  // Same rule as the store: a notice with nothing to say is not a notice.
  if (!title && !body && series.length === 0 && !hasImage) return null;
  return {
    hid: raw.hid,
    createdAt,
    updatedAt,
    level: raw.level,
    kind: raw.kind,
    title,
    body,
    key: boundedText(raw.key, MAX_KEY_LENGTH),
    series,
    hasImage,
  };
}

function parseLine(line) {
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return null;
  let raw;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!raw || raw.v !== SCHEMA_VERSION) return null;
  return normalizeEntry(raw);
}

// Optional fields are omitted when empty, which keeps a plain text card to a
// couple of hundred bytes.
function serializeEntry(entry) {
  const record = {
    v: SCHEMA_VERSION,
    hid: entry.hid,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    level: entry.level,
    kind: entry.kind,
    title: entry.title,
    body: entry.body,
  };
  if (entry.key) record.key = entry.key;
  if (entry.series.length) record.series = entry.series;
  if (entry.hasImage) record.hasImage = true;
  return JSON.stringify(record);
}

// What decides "this card changed". Timestamps are left out on purpose: a
// heartbeat that re-pushes identical content is not a change worth a write.
function contentSignature(entry) {
  return JSON.stringify([
    entry.level, entry.kind, entry.title, entry.body, entry.key, entry.series, entry.hasImage,
  ]);
}

function entryFromNotice(hid, notice, previous, at) {
  const createdAt = previous
    ? previous.createdAt
    : (Number.isSafeInteger(notice.createdAt) && notice.createdAt > 0 ? notice.createdAt : at);
  return normalizeEntry({
    hid,
    createdAt,
    updatedAt: Math.max(createdAt, Math.round(at)),
    level: LEVEL_SET.has(notice.level) ? notice.level : DEFAULT_LEVEL,
    kind: KIND_SET.has(notice.kind) ? notice.kind : DEFAULT_KIND,
    title: notice.title,
    body: notice.body,
    key: notice.key,
    series: notice.series,
    hasImage: !!notice.image,
  });
}

function errorDetail(err) {
  return err && (err.code || err.message) ? (err.code || err.message) : String(err);
}

function unsafePathError(label) {
  const err = new Error(`notice history ${label} must be a plain directory or file`);
  err.code = "NOTICE_HISTORY_UNSAFE_PATH";
  return err;
}

// Create (or re-check) the history directory without ever following a link:
// the parent `.clawd` and the directory itself must both be real directories.
// Same shape as hooks/session-history.js ensureHistoryDir.
function ensureDirectory(dir) {
  const parent = path.dirname(dir);
  let parentStat;
  try {
    parentStat = fs.lstatSync(parent);
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
    fs.mkdirSync(parent, { mode: 0o700 });
    parentStat = fs.lstatSync(parent);
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw unsafePathError("parent");
  try { fs.mkdirSync(dir, { mode: 0o700 }); }
  catch (err) { if (!err || err.code !== "EEXIST") throw err; }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafePathError("directory");
  try { fs.chmodSync(dir, 0o700); } catch {}
  return dir;
}

function createNoticeHistory(options = {}) {
  const dir = typeof options.dir === "string" && options.dir ? path.resolve(options.dir) : DEFAULT_DIR;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const logWarn = typeof options.logWarn === "function" ? options.logWarn : console.warn;
  const isEnabled = typeof options.isEnabled === "function" ? options.isEnabled : () => true;
  const onChange = typeof options.onChange === "function" ? options.onChange : null;
  const setTimer = typeof options.setTimer === "function" ? options.setTimer : setTimeout;
  const clearTimer = typeof options.clearTimer === "function" ? options.clearTimer : clearTimeout;
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : MAX_ENTRIES;
  const runId = typeof options.runId === "string" && /^[A-Za-z0-9_-]{6,32}$/.test(options.runId)
    ? options.runId
    : crypto.randomBytes(9).toString("base64url");

  // hid -> entry: the collapsed view, latest version of every notice.
  const entries = new Map();
  // hid -> day key of the file holding that entry's latest line on disk.
  const fileOf = new Map();
  // day key -> non-blank lines in that file (live + superseded), for compaction.
  const lineCounts = new Map();
  // hids to write on the next flush (new, removed-after-change, checkpoint).
  const pending = new Set();
  // hid -> when it first changed without being written (checkpoint clock).
  const dirtySince = new Map();
  // hids currently on the notice stack, as of the last snapshot.
  let live = new Set();
  // hid -> signature of a card that was on screen when history was cleared.
  // Its next heartbeat must not bring it straight back; a real change does.
  const suppressed = new Map();
  let loaded = false;
  let disposed = false;
  let flushTimer = null;
  let maintenanceTimer = null;
  let changeTimer = null;
  let lastChangeAt = 0;
  let lastPruneAt = 0;
  const lastWarnAt = new Map();

  function warn(key, err) {
    const at = now();
    const last = lastWarnAt.get(key);
    if (last !== undefined && at - last < WARN_THROTTLE_MS) return;
    lastWarnAt.set(key, at);
    try { logWarn(`Clawd: notice history ${key} failed:`, errorDetail(err)); } catch {}
  }

  function timer(fn, delay) {
    const handle = setTimer(fn, delay);
    if (handle && typeof handle.unref === "function") handle.unref();
    return handle;
  }

  // Coalesced "the history changed" signal for the dashboard. Always deferred,
  // so the notification never runs inside the store snapshot that caused it,
  // and throttled so a monitor refreshing every 2 s costs one re-read a second
  // at most.
  function notifyChange() {
    if (!onChange || disposed || changeTimer !== null) return;
    const delay = Math.max(0, CHANGE_THROTTLE_MS - (now() - lastChangeAt));
    changeTimer = timer(() => {
      changeTimer = null;
      if (disposed) return;
      lastChangeAt = now();
      try { onChange(); } catch (err) { warn("change notification", err); }
    }, delay);
  }

  // Store subscriber. Memory only; the write is scheduled, never done here.
  function observe(snapshot) {
    if (disposed) return;
    try {
      recordSnapshot(Array.isArray(snapshot) ? snapshot : []);
    } catch (err) {
      warn("record", err);
    }
  }

  function recordSnapshot(notices) {
    // Off means no new text is captured. Anything already captured still
    // reaches disk through the normal checkpoint, and the live set starts over
    // so turning it back on records what is on screen at that moment.
    if (isEnabled() !== true) {
      live = new Set();
      return;
    }
    const at = now();
    const nextLive = new Set();
    let changed = false;
    for (const notice of notices) {
      if (!notice || typeof notice.id !== "string" || !NOTICE_ID_RE.test(notice.id)) continue;
      const hid = `${runId}:${notice.id}`;
      nextLive.add(hid);
      const previous = entries.get(hid) || null;
      const candidate = entryFromNotice(hid, notice, previous, at);
      if (!candidate) continue;
      const signature = contentSignature(candidate);
      if (suppressed.has(hid)) {
        if (suppressed.get(hid) === signature) continue;
        suppressed.delete(hid);
      }
      if (previous && contentSignature(previous) === signature) continue;
      entries.set(hid, candidate);
      changed = true;
      if (!previous || !fileOf.has(hid)) {
        // First sighting (or never written yet): on disk within a second.
        pending.add(hid);
      } else if (!dirtySince.has(hid)) {
        // A refresh of a card already on disk waits for the checkpoint, or
        // for the card to leave the stack, whichever comes first.
        dirtySince.set(hid, at);
      }
    }
    let left = false;
    for (const hid of live) {
      if (nextLive.has(hid)) continue;
      suppressed.delete(hid);
      // The card left the stack: whatever it last said is now final.
      if (dirtySince.has(hid)) pending.add(hid);
      // Its row loses the "on screen" mark, which the dashboard has to see.
      if (entries.has(hid)) left = true;
    }
    live = nextLive;
    if (changed) enforceCap();
    if (pending.size) scheduleFlush(FLUSH_DELAY_MS);
    if (changed || left) notifyChange();
  }

  // Oldest by last update go first; a card still on screen is never dropped.
  function enforceCap() {
    if (entries.size <= maxEntries) return;
    const candidates = [...entries.values()]
      .filter((entry) => !live.has(entry.hid))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    for (const entry of candidates) {
      if (entries.size <= maxEntries) break;
      dropEntry(entry.hid);
    }
  }

  // Forget an entry. Its lines stay in their file as superseded weight until
  // that file is compacted or ages out.
  function dropEntry(hid) {
    entries.delete(hid);
    fileOf.delete(hid);
    pending.delete(hid);
    dirtySince.delete(hid);
  }

  function scheduleFlush(delay) {
    if (disposed || flushTimer !== null) return;
    flushTimer = timer(() => {
      flushTimer = null;
      flush();
    }, delay);
  }

  // Append every pending entry's current version to today's file. Nothing is
  // written before start() has read the disk: compaction's line bookkeeping
  // comes from that read, and start() flushes whatever queued up meanwhile.
  function flush() {
    if (!loaded || pending.size === 0) return;
    const batch = [...pending].filter((hid) => entries.has(hid));
    pending.clear();
    if (batch.length === 0) return;
    const day = dayKeyOf(now());
    try {
      appendLines(day, batch.map((hid) => serializeEntry(entries.get(hid))));
    } catch (err) {
      for (const hid of batch) if (entries.has(hid)) pending.add(hid);
      warn("write", err);
      scheduleFlush(FLUSH_RETRY_MS);
      return;
    }
    for (const hid of batch) {
      fileOf.set(hid, day);
      dirtySince.delete(hid);
    }
    lineCounts.set(day, (lineCounts.get(day) || 0) + batch.length);
  }

  function dayPath(day) {
    return path.join(dir, `${day}.jsonl`);
  }

  // Size of a day file we may write to, or 0 when it does not exist. A link or
  // anything other than a plain file refuses the write rather than following.
  function writableFileSize(filePath) {
    let stat;
    try { stat = fs.lstatSync(filePath); } catch (err) {
      if (err && err.code === "ENOENT") return 0;
      throw err;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw unsafePathError("file");
    return stat.size;
  }

  function endsWithNewline(filePath, size) {
    if (size <= 0) return true;
    const fd = fs.openSync(filePath, "r");
    try {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      return last[0] === 0x0a;
    } finally {
      fs.closeSync(fd);
    }
  }

  function appendLines(day, lines) {
    ensureDirectory(dir);
    const filePath = dayPath(day);
    const payload = `${lines.join("\n")}\n`;
    let size = writableFileSize(filePath);
    // Past the soft cap, rewrite the day down to one line per entry first.
    if (size + Buffer.byteLength(payload, "utf8") > MAX_DAY_FILE_BYTES) {
      rewriteDay(day);
      size = writableFileSize(filePath);
    }
    // A crash mid-append can leave a torn last line; never glue onto it.
    const prefix = endsWithNewline(filePath, size) ? "" : "\n";
    fs.appendFileSync(filePath, `${prefix}${payload}`, { encoding: "utf8", mode: 0o600 });
    if (size === 0) {
      try { fs.chmodSync(filePath, 0o600); } catch {}
    }
  }

  // Compaction: rewrite a day file to one line per entry whose newest copy
  // lives there, or remove it when none does. Temp file + rename, so a crash
  // leaves either the old file or the new one, never half of each.
  function rewriteDay(day) {
    const filePath = dayPath(day);
    const keep = [];
    for (const [hid, fileDay] of fileOf) {
      if (fileDay === day && entries.has(hid)) keep.push(entries.get(hid));
    }
    if (keep.length === 0) {
      try { fs.unlinkSync(filePath); } catch (err) {
        if (!err || err.code !== "ENOENT") throw err;
      }
      lineCounts.delete(day);
      return;
    }
    keep.sort((a, b) => a.createdAt - b.createdAt);
    writeFileAtomic(filePath, `${keep.map(serializeEntry).join("\n")}\n`);
    lineCounts.set(day, keep.length);
  }

  function writeFileAtomic(filePath, text) {
    ensureDirectory(dir);
    writableFileSize(filePath);
    const tempPath = path.join(
      dir,
      `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      fs.writeFileSync(tempPath, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(tempPath, filePath);
    } catch (err) {
      try { fs.unlinkSync(tempPath); } catch {}
      throw err;
    }
  }

  // Read what earlier runs left, prune it, and start the maintenance clock.
  // Synchronous and bounded (≤ MAX_READ_FILE_BYTES per file, a week of files);
  // called once after the app is up, never from the notice path. A failed read
  // leaves an empty but working history: new notices still get recorded.
  function start() {
    if (disposed || loaded) return;
    try {
      loadFromDisk();
    } catch (err) {
      warn("load", err);
    }
    loaded = true;
    try {
      prune();
    } catch (err) {
      warn("prune", err);
    }
    enforceCap();
    flush();
    scheduleMaintenance();
    notifyChange();
  }

  // Every day file is read, expired ones included, so prune() can still see
  // an entry whose newest copy sits in an old file before that file goes.
  // Oldest day first; within a day, a later line wins a tie.
  function loadFromDisk() {
    const files = listOwnFiles();
    if (!files) return;
    const at = now();
    for (const name of files.temps) cleanupStaleTemp(name, at);
    for (const day of files.days) {
      const filePath = dayPath(day);
      let stat;
      try { stat = fs.lstatSync(filePath); } catch (err) {
        warn("read", err);
        continue;
      }
      // Not a plain file, or larger than anything we write: leave it alone.
      // It is never compacted (it has no line count), only aged out.
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_READ_FILE_BYTES) continue;
      let text;
      try { text = fs.readFileSync(filePath, "utf8"); } catch (err) {
        warn("read", err);
        continue;
      }
      let count = 0;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        count += 1;
        const entry = parseLine(line);
        if (!entry) continue;
        const existing = entries.get(entry.hid);
        if (existing && existing.updatedAt > entry.updatedAt) continue;
        entries.set(entry.hid, entry);
        fileOf.set(entry.hid, day);
      }
      lineCounts.set(day, count);
    }
  }

  // { days, temps } in this directory, or null when there is no directory yet
  // (or it is not one we may use). Day keys come back oldest first.
  function listOwnFiles() {
    let names;
    try {
      const parentStat = fs.lstatSync(path.dirname(dir));
      const dirStat = fs.lstatSync(dir);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return null;
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return null;
      names = fs.readdirSync(dir);
    } catch (err) {
      if (err && err.code === "ENOENT") return null;
      throw err;
    }
    const days = [];
    const temps = [];
    for (const name of names) {
      const match = DAY_FILE_RE.exec(name);
      if (match) {
        const day = name.slice(0, -".jsonl".length);
        if (dayBounds(day)) days.push(day);
      } else if (TEMP_FILE_RE.test(name)) {
        temps.push(name);
      }
    }
    days.sort();
    return { days, temps };
  }

  function cleanupStaleTemp(name, at, force = false) {
    const filePath = path.join(dir, name);
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() && !stat.isSymbolicLink()) return;
      if (!force && at - stat.mtimeMs < TEMP_FILE_TTL_MS) return;
      fs.unlinkSync(filePath);
    } catch (err) {
      if (!err || err.code !== "ENOENT") warn("temp cleanup", err);
    }
  }

  // Retention. An entry goes once its last update is RETENTION_DAYS old (a
  // card still on screen stays); a day file goes once its whole day is. A
  // compaction can leave a still-retained entry's newest copy in an old file,
  // so anything that file still holds is re-queued for today's file first.
  function prune() {
    const at = now();
    lastPruneAt = at;
    const cutoff = at - RETENTION_MS;
    let changed = false;
    for (const entry of [...entries.values()]) {
      if (entry.updatedAt >= cutoff || live.has(entry.hid)) continue;
      dropEntry(entry.hid);
      changed = true;
    }
    const files = listOwnFiles();
    const days = new Set([...(files ? files.days : []), ...lineCounts.keys()]);
    for (const day of days) {
      const bounds = dayBounds(day);
      if (!bounds || bounds.end > cutoff) continue;
      for (const [hid, fileDay] of fileOf) {
        if (fileDay !== day) continue;
        fileOf.delete(hid);
        if (entries.has(hid)) pending.add(hid);
      }
      lineCounts.delete(day);
      try { fs.unlinkSync(dayPath(day)); } catch (err) {
        if (!err || err.code !== "ENOENT") warn("prune", err);
      }
    }
    if (pending.size) scheduleFlush(FLUSH_DELAY_MS);
    if (changed) notifyChange();
  }

  function scheduleMaintenance() {
    if (disposed || maintenanceTimer !== null) return;
    maintenanceTimer = timer(() => {
      maintenanceTimer = null;
      runMaintenance();
      scheduleMaintenance();
    }, MAINTENANCE_INTERVAL_MS);
  }

  // One tick: checkpoint cards that kept changing on screen, prune hourly
  // (which also covers a midnight rollover), compact, flush.
  function runMaintenance() {
    if (disposed || !loaded) return;
    try {
      const at = now();
      for (const [hid, since] of dirtySince) {
        if (at - since >= CHECKPOINT_MS) pending.add(hid);
      }
      if (at - lastPruneAt >= PRUNE_INTERVAL_MS) prune();
      compact();
      flush();
    } catch (err) {
      warn("maintenance", err);
    }
  }

  // Rewrite each day file that carries too many superseded lines, and remove
  // one that holds nothing live. Only files we read or wrote are touched.
  function compact() {
    const liveLines = new Map();
    for (const day of fileOf.values()) liveLines.set(day, (liveLines.get(day) || 0) + 1);
    for (const [day, total] of [...lineCounts]) {
      const kept = liveLines.get(day) || 0;
      if (kept > 0 && total - kept < COMPACT_SLACK_LINES) continue;
      try {
        rewriteDay(day);
      } catch (err) {
        warn("compaction", err);
      }
    }
  }

  // Forget everything and delete every day file. A card still on screen keeps
  // its signature in `suppressed`, so its next identical heartbeat does not
  // re-create the row the user just cleared; if it says something new, it
  // comes back as a new row. Reports how many visible rows went.
  function clear() {
    if (disposed) return { status: "error", reason: "disposed", removed: 0 };
    const removed = list().length;
    for (const hid of live) {
      const entry = entries.get(hid);
      if (entry) suppressed.set(hid, contentSignature(entry));
    }
    entries.clear();
    fileOf.clear();
    pending.clear();
    dirtySince.clear();
    lineCounts.clear();
    let failed = false;
    try {
      const files = listOwnFiles();
      if (files) {
        for (const day of files.days) {
          try { fs.unlinkSync(dayPath(day)); } catch (err) {
            if (!err || err.code !== "ENOENT") {
              failed = true;
              warn("clear", err);
            }
          }
        }
        for (const name of files.temps) cleanupStaleTemp(name, now(), true);
      }
    } catch (err) {
      failed = true;
      warn("clear", err);
    }
    notifyChange();
    return failed
      ? { status: "error", reason: "delete-failed", removed }
      : { status: "ok", removed };
  }

  // `live` is "on screen and being recorded": once recording is off, the live
  // set is only cleared by the next snapshot, so the pref is checked here too.
  function toPublic(entry, recording = isEnabled() === true) {
    return {
      id: entry.hid,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      level: entry.level,
      kind: entry.kind,
      title: entry.title,
      body: entry.body,
      key: entry.key,
      series: entry.series.map((item) => ({ ...item })),
      hasImage: entry.hasImage,
      live: recording && live.has(entry.hid),
    };
  }

  // Newest first by first appearance, so a card that keeps refreshing holds
  // its place in the list instead of jumping to the top on every push.
  function list() {
    const cutoff = now() - RETENTION_MS;
    const recording = isEnabled() === true;
    return [...entries.values()]
      .filter((entry) => entry.updatedAt >= cutoff || live.has(entry.hid))
      .sort((a, b) => (b.createdAt - a.createdAt)
        || (b.updatedAt - a.updatedAt)
        || (a.hid < b.hid ? 1 : a.hid > b.hid ? -1 : 0))
      .map((entry) => toPublic(entry, recording));
  }

  function get(id) {
    if (typeof id !== "string") return null;
    const entry = entries.get(id);
    return entry ? toPublic(entry) : null;
  }

  function getSnapshot() {
    return {
      enabled: isEnabled() === true,
      retentionDays: RETENTION_DAYS,
      entries: list(),
    };
  }

  // Quit: write every card's final version now, then stop all timers.
  function dispose() {
    if (disposed) return;
    for (const hid of dirtySince.keys()) pending.add(hid);
    try { flush(); } catch (err) { warn("write", err); }
    disposed = true;
    for (const handle of [flushTimer, maintenanceTimer, changeTimer]) {
      if (handle !== null) clearTimer(handle);
    }
    flushTimer = null;
    maintenanceTimer = null;
    changeTimer = null;
  }

  return {
    start,
    observe,
    flush,
    runMaintenance,
    prune,
    clear,
    list,
    get,
    getSnapshot,
    dispose,
    dir,
    runId,
  };
}

module.exports = {
  createNoticeHistory,
  DEFAULT_DIR,
  HISTORY_DIR_NAME,
  SCHEMA_VERSION,
  RETENTION_DAYS,
  RETENTION_MS,
  MAX_ENTRIES,
  MAX_LINE_BYTES,
  MAX_DAY_FILE_BYTES,
  CHECKPOINT_MS,
  FLUSH_DELAY_MS,
  MAINTENANCE_INTERVAL_MS,
  PRUNE_INTERVAL_MS,
  COMPACT_SLACK_LINES,
  __test: {
    dayKeyOf,
    dayBounds,
    summarizeSeries,
    normalizeEntry,
    parseLine,
    serializeEntry,
    contentSignature,
  },
};
