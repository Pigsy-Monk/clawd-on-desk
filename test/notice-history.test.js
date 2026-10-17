"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createNoticeHistory,
  RETENTION_MS,
  CHECKPOINT_MS,
  FLUSH_DELAY_MS,
  PRUNE_INTERVAL_MS,
  COMPACT_SLACK_LINES,
  __test,
} = require("../src/notice-history");
const { createNoticeStore } = require("../src/notice-store");
const { noticeCopyText } = require("../src/notice-text");

const DAY_MS = 24 * 60 * 60 * 1000;
// Local noon, so a few hours either way never crosses midnight.
const NOON = new Date(2026, 9, 10, 12, 0, 0).getTime();

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function tempHistoryDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-notice-history-"));
  roots.push(root);
  return path.join(root, ".clawd", "notice-history-v1");
}

function makeTimers() {
  let nextId = 0;
  const timers = new Map();
  return {
    setTimer: (fn, delay) => {
      nextId += 1;
      timers.set(nextId, { fn, delay });
      return nextId;
    },
    clearTimer: (id) => timers.delete(id),
    delays: () => [...timers.values()].map((entry) => entry.delay),
    // Runs what is armed now; anything a callback re-arms waits for next time.
    run() {
      const due = [...timers.values()];
      timers.clear();
      for (const entry of due) entry.fn();
    },
  };
}

function harness(options = {}) {
  let clock = options.start || NOON;
  const timers = makeTimers();
  const warnings = [];
  let enabled = true;
  let changes = 0;
  const dir = options.dir || tempHistoryDir();
  const create = () => createNoticeHistory({
    dir,
    now: () => clock,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    logWarn: (...args) => warnings.push(args.join(" ")),
    isEnabled: () => enabled,
    onChange: () => { changes += 1; },
    maxEntries: options.maxEntries,
  });
  return {
    dir,
    timers,
    warnings,
    history: create(),
    restart() { this.history.dispose(); this.history = create(); return this.history; },
    now: () => clock,
    advance: (ms) => { clock += ms; },
    setEnabled: (value) => { enabled = value; },
    changes: () => changes,
  };
}

function dayFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort();
}

function diskLines(dir) {
  return dayFiles(dir).flatMap((name) =>
    fs.readFileSync(path.join(dir, name), "utf8").split("\n").filter(Boolean));
}

function notice(id, overrides = {}) {
  return {
    id,
    createdAt: NOON,
    key: "",
    title: `Title ${id}`,
    body: `Body ${id}`,
    level: "info",
    kind: "text",
    series: [],
    image: null,
    ...overrides,
  };
}

function writeDayFile(dir, ms, records) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${__test.dayKeyOf(ms)}.jsonl`);
  fs.writeFileSync(file, records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
  return file;
}

function record(overrides = {}) {
  return {
    v: 1,
    hid: "oldrun01:notice-1",
    createdAt: NOON - DAY_MS,
    updatedAt: NOON - DAY_MS,
    level: "warn",
    kind: "text",
    title: "Build",
    body: "slow",
    ...overrides,
  };
}

describe("notice history recording", () => {
  it("collapses a keyed card re-pushed many times into one entry holding its latest version", () => {
    const h = harness();
    h.history.start();
    const store = createNoticeStore({ now: h.now, setTimer: () => null, clearTimer: () => {} });
    store.subscribe((snapshot) => h.history.observe(snapshot));
    for (let i = 1; i <= 30; i += 1) {
      store.add({ key: "cpu", title: "CPU", body: `load ${i}%`, level: "warn" });
      h.advance(2000);
    }
    h.history.flush();

    const rows = h.history.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].body, "load 30%");
    assert.equal(rows[0].key, "cpu");
    assert.equal(rows[0].live, true);
    // Thirty pushes before the first flush: one line on disk, not thirty.
    assert.equal(diskLines(h.dir).length, 1);

    // Further refreshes of the card already on disk wait for the checkpoint.
    for (let i = 31; i <= 60; i += 1) {
      store.add({ key: "cpu", title: "CPU", body: `load ${i}%`, level: "warn" });
      h.advance(2000);
    }
    h.history.flush();
    assert.equal(diskLines(h.dir).length, 1, "a refresh is not written on every push");
    h.advance(CHECKPOINT_MS);
    h.history.runMaintenance();
    assert.equal(diskLines(h.dir).length, 2, "the checkpoint writes the latest version once");

    // A restart reads both lines back as the same single row.
    const restarted = h.restart();
    restarted.start();
    const after = restarted.list();
    assert.equal(after.length, 1);
    assert.equal(after[0].body, "load 60%");
    store.dispose();
  });

  it("keeps an unkeyed push as its own row and lists newest first", () => {
    const h = harness();
    h.history.start();
    h.history.observe([notice("notice-1", { createdAt: NOON })]);
    h.history.observe([
      notice("notice-1", { createdAt: NOON }),
      notice("notice-2", { createdAt: NOON + 1000, level: "error" }),
    ]);
    assert.deepEqual(h.history.list().map((row) => row.title), ["Title notice-2", "Title notice-1"]);
    assert.equal(h.history.list()[0].level, "error");
  });

  it("never writes the image or the raw series points", () => {
    const h = harness();
    h.history.start();
    const image = { mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==" };
    h.history.observe([notice("notice-1", {
      kind: "trend",
      title: "Latency",
      body: "",
      image,
      series: [
        { name: "p50", points: [11, 12, 13.5], value: null, unit: "ms" },
        { name: "p99", points: [80, 90], value: 95, unit: "ms" },
      ],
    })]);
    h.history.flush();

    const text = diskLines(h.dir).join("\n");
    assert.ok(!text.includes(image.data), "the image payload must never reach disk");
    assert.ok(!text.includes("points"), "the sparkline points are not history");
    const [row] = h.history.list();
    assert.equal(row.hasImage, true);
    assert.deepEqual(row.series, [
      { name: "p50", value: 13.5, unit: "ms" },
      { name: "p99", value: 95, unit: "ms" },
    ]);
    // The bubble's copy formatter reads a history row the same way.
    assert.equal(noticeCopyText(row), "Latency\np50 13.5ms\np99 95ms");
  });

  it("does no disk work inside observe() and nothing at all before start()", () => {
    const h = harness();
    h.history.observe([notice("notice-1")]);
    assert.equal(fs.existsSync(h.dir), false, "observe() must not touch the disk");
    assert.ok(h.timers.delays().includes(FLUSH_DELAY_MS), "the write is scheduled instead");
    h.timers.run();
    assert.equal(dayFiles(h.dir).length, 0, "no write before start() has read the disk");
    h.history.start();
    assert.equal(diskLines(h.dir).length, 1, "start() flushes what queued up meanwhile");
  });

  it("writes an identical heartbeat zero times and a changed card's final text when it leaves", () => {
    const h = harness();
    h.history.start();
    h.history.observe([notice("notice-1")]);
    h.history.flush();
    for (let i = 0; i < 20; i += 1) h.history.observe([notice("notice-1")]);
    h.history.flush();
    assert.equal(diskLines(h.dir).length, 1, "an unchanged heartbeat is not a write");

    h.history.observe([notice("notice-1", { body: "final words" })]);
    h.history.flush();
    assert.equal(diskLines(h.dir).length, 1, "a refresh waits for the checkpoint or removal");
    h.history.observe([]);
    h.history.flush();
    const lines = diskLines(h.dir);
    assert.equal(lines.length, 2, "leaving the stack writes the final version");
    assert.equal(JSON.parse(lines[1]).body, "final words");
    assert.equal(h.history.list()[0].live, false);
  });

  it("dispose writes every on-screen card's unsaved version", () => {
    const h = harness();
    h.history.start();
    h.history.observe([notice("notice-1")]);
    h.history.flush();
    h.history.observe([notice("notice-1", { body: "at quit" })]);
    h.history.dispose();
    const lines = diskLines(h.dir);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1]).body, "at quit");
  });

  it("collapses lines by id on restart and skips corrupt, oversized and foreign lines", () => {
    const h = harness();
    writeDayFile(h.dir, NOON - DAY_MS, [
      record({ body: "first" }),
      "{not json",
      JSON.stringify(record({ hid: "oldrun01:notice-2", body: "x".repeat(40 * 1024) })),
      record({ v: 2, hid: "oldrun01:notice-3" }),
      record({ hid: "../../etc:passwd" }),
      record({ body: "second", updatedAt: NOON - DAY_MS + 5000 }),
      record({ body: "stale copy", updatedAt: NOON - DAY_MS + 1000 }),
    ]);
    h.history.start();
    const rows = h.history.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].body, "second", "the newest version of an id wins regardless of line order");
    assert.equal(rows[0].live, false);
    assert.deepEqual(h.warnings, [], "bad lines are skipped quietly");
  });

  it("caps the index, dropping the oldest entries that are no longer on screen", () => {
    const h = harness({ maxEntries: 5 });
    h.history.start();
    for (let i = 1; i <= 8; i += 1) {
      h.advance(1000);
      h.history.observe([notice(`notice-${i}`, { createdAt: h.now() })]);
    }
    const titles = h.history.list().map((row) => row.title);
    assert.equal(titles.length, 5);
    assert.equal(titles[0], "Title notice-8");
    assert.ok(!titles.includes("Title notice-1"));
  });

  it("stops recording while the pref is off and records what is on screen once it is back on", () => {
    const h = harness();
    h.history.start();
    h.setEnabled(false);
    h.history.observe([notice("notice-1")]);
    h.history.flush();
    assert.equal(h.history.list().length, 0);
    assert.equal(dayFiles(h.dir).length, 0);

    h.setEnabled(true);
    h.history.observe([notice("notice-1")]);
    h.history.flush();
    assert.equal(h.history.list().length, 1);
    assert.equal(diskLines(h.dir).length, 1);
    assert.equal(h.history.getSnapshot().enabled, true);
    assert.equal(h.history.list()[0].live, true);
    h.setEnabled(false);
    assert.equal(h.history.getSnapshot().enabled, false);
    assert.equal(h.history.list()[0].live, false,
      "a row is not marked on screen once recording is off, even before the next snapshot");
    assert.equal(h.history.list().length, 1, "turning recording off keeps what was saved");
  });

  it("clears every file and does not resurrect an unchanged on-screen card", () => {
    const h = harness();
    h.history.start();
    const onScreen = [notice("notice-1"), notice("notice-2")];
    h.history.observe(onScreen);
    h.history.flush();
    assert.equal(dayFiles(h.dir).length, 1);

    assert.deepEqual(h.history.clear(), { status: "ok", removed: 2 });
    assert.equal(dayFiles(h.dir).length, 0);
    h.history.observe(onScreen);
    h.history.flush();
    assert.equal(h.history.list().length, 0, "an identical heartbeat must not bring a cleared row back");
    assert.equal(dayFiles(h.dir).length, 0);

    h.history.observe([notice("notice-1", { body: "new text" }), notice("notice-2")]);
    h.history.flush();
    assert.deepEqual(h.history.list().map((row) => row.body), ["new text"]);
  });

  it("logs a broken history directory once and keeps the notice path working", () => {
    const h = harness();
    const clawd = path.dirname(h.dir);
    fs.mkdirSync(path.dirname(clawd), { recursive: true });
    fs.writeFileSync(clawd, "not a directory");
    assert.doesNotThrow(() => h.history.start());
    assert.doesNotThrow(() => h.history.observe([notice("notice-1")]));
    h.history.flush();
    h.history.flush();
    h.history.observe([notice("notice-1"), notice("notice-2")]);
    h.history.flush();
    assert.equal(h.history.list().length, 2, "memory keeps working when the disk does not");
    assert.equal(h.warnings.filter((line) => line.includes("write failed")).length, 1,
      "the same failure is not logged on every retry");
  });

  it("signals the dashboard once per burst, never inside the snapshot", () => {
    const h = harness();
    h.history.start();
    h.timers.run();
    const base = h.changes();
    for (let i = 0; i < 10; i += 1) h.history.observe([notice("notice-1", { body: `v${i}` })]);
    assert.equal(h.changes(), base, "observe() never calls back synchronously");
    h.timers.run();
    assert.equal(h.changes(), base + 1);
    // An unchanged card leaving the stack still changes its row (no longer
    // "on screen"), so that is a signal too; an identical heartbeat is not.
    h.history.observe([notice("notice-1", { body: "v9" })]);
    h.timers.run();
    assert.equal(h.changes(), base + 1);
    h.history.observe([]);
    h.timers.run();
    assert.equal(h.changes(), base + 2);
  });
});

describe("notice history retention and compaction", () => {
  it("prunes entries and whole day files past 7 days at startup and hourly", () => {
    const h = harness();
    const expired = writeDayFile(h.dir, NOON - 8 * DAY_MS, [
      record({ hid: "oldrun01:notice-8", createdAt: NOON - 8 * DAY_MS, updatedAt: NOON - 8 * DAY_MS }),
    ]);
    const justOver = NOON - RETENTION_MS - 1000;
    const edge = writeDayFile(h.dir, justOver, [
      record({ hid: "oldrun01:notice-7", createdAt: justOver, updatedAt: justOver }),
    ]);
    writeDayFile(h.dir, NOON - 6 * DAY_MS, [
      record({ hid: "oldrun01:notice-6", createdAt: NOON - 6 * DAY_MS, updatedAt: NOON - 6 * DAY_MS }),
    ]);
    h.history.start();
    assert.equal(fs.existsSync(expired), false, "a day file wholly past retention is deleted");
    assert.equal(fs.existsSync(edge), true, "a day still partly inside the window stays on disk");
    assert.deepEqual(h.history.list().map((row) => row.id), ["oldrun01:notice-6"],
      "an entry just over 7 days old is no longer shown");

    h.advance(2 * DAY_MS + PRUNE_INTERVAL_MS);
    h.history.runMaintenance();
    assert.equal(fs.existsSync(edge), false, "the hourly prune catches up after midnight");
    assert.deepEqual(h.history.list(), []);
  });

  it("moves a still-retained entry out of an expiring day file instead of losing it", () => {
    const h = harness();
    // A compaction can leave an entry's newest copy in an older day's file.
    const old = writeDayFile(h.dir, NOON - 8 * DAY_MS, [
      record({ createdAt: NOON - 8 * DAY_MS, updatedAt: NOON - DAY_MS, body: "still fresh" }),
    ]);
    h.history.start();
    assert.equal(fs.existsSync(old), false);
    h.history.flush();
    const restarted = h.restart();
    restarted.start();
    assert.deepEqual(restarted.list().map((row) => row.body), ["still fresh"]);
  });

  it("compacts a day file whose lines are mostly superseded", () => {
    const h = harness();
    const lines = [];
    for (let i = 0; i <= COMPACT_SLACK_LINES + 50; i += 1) {
      lines.push(record({ createdAt: NOON - 1000, updatedAt: NOON - 1000 + i, body: `v${i}` }));
    }
    const file = writeDayFile(h.dir, NOON, lines);
    h.history.start();
    assert.equal(diskLines(h.dir).length, lines.length, "startup itself does not rewrite");
    h.history.runMaintenance();
    const after = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    assert.equal(after.length, 1);
    assert.equal(JSON.parse(after[0]).body, `v${COMPACT_SLACK_LINES + 50}`);
    assert.equal(fs.readdirSync(h.dir).some((name) => name.endsWith(".tmp")), false,
      "the rewrite leaves no temp file behind");
  });

  it("keeps a card that is still on screen even when its last change is older than 7 days", () => {
    const h = harness();
    h.history.start();
    h.history.observe([notice("notice-1")]);
    h.history.flush();
    h.advance(RETENTION_MS + PRUNE_INTERVAL_MS);
    h.history.observe([notice("notice-1")]);
    h.history.runMaintenance();
    assert.equal(h.history.list().length, 1, "a card the user can still see stays listed");
    h.history.observe([]);
    h.advance(PRUNE_INTERVAL_MS);
    h.history.runMaintenance();
    assert.equal(h.history.list().length, 0, "once it has left the stack it ages out");
  });
});

describe("notice history line format", () => {
  const { normalizeEntry, parseLine, serializeEntry, dayBounds, dayKeyOf } = __test;

  it("round-trips an entry through one JSONL line", () => {
    const entry = normalizeEntry(record({ hid: "abcdef12:notice-9", key: "k", series: [{ name: "a", value: 1, unit: "%" }] }));
    assert.ok(entry);
    const line = serializeEntry(entry);
    assert.ok(!line.includes("\n"));
    assert.deepEqual(parseLine(line), entry);
  });

  it("rejects entries that are malformed rather than guessing", () => {
    for (const bad of [
      record({ hid: "short:1" }),
      record({ hid: "abcdef12:no/slash" }),
      record({ level: "fatal" }),
      record({ kind: "chart" }),
      record({ updatedAt: NOON - 2 * DAY_MS }),
      record({ createdAt: 1.5 }),
      record({ title: "", body: "" }),
    ]) {
      assert.equal(normalizeEntry(bad), null, JSON.stringify(bad));
    }
    assert.equal(parseLine(JSON.stringify(record({ v: 2 }))), null, "a future schema is not read as this one");
    assert.equal(parseLine("[1,2,3]"), null);
    assert.equal(normalizeEntry(record({ title: "t".repeat(500) })).title.length, 200,
      "over-long text is bounded on read, the same caps the store applies");
  });

  it("uses local calendar days and refuses impossible dates", () => {
    assert.equal(dayKeyOf(NOON), "2026-10-10");
    const bounds = dayBounds("2026-10-10");
    assert.ok(bounds.start <= NOON && NOON < bounds.end);
    assert.equal(dayBounds("2026-02-30"), null);
    assert.equal(dayBounds("2026-13-01"), null);
    assert.equal(dayBounds("../etc"), null);
  });
});
