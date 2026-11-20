"use strict";

// Manual-only Feishu "@me" digest. A pet click runs the feishu-atme-digest
// skill once and hands the rows to the pet's click panel (the Session HUD),
// where each row is one message the user can open in Feishu.
//
// Deliberately manual: nothing here schedules itself. No timer, no app-lifecycle
// hook, no Dashboard-visibility trigger, no retry loop — a click is the only
// trigger. Periodic pulls of external networks are policy-gated in this repo
// (see the header of kimi-quota-runtime.js: "a future periodic mode requires an
// upstream policy approval"), so the click is the whole feature.
//
// The skill is an optional external dependency living outside the app bundle. A
// machine without it is a normal state, not a fault: the run reports it and the
// panel says why it is empty instead of silently showing nothing.
//
// Privacy note: the skill's stdout carries other people's message text. Only the
// rows it explicitly marks for display reach the panel; nothing from a failed
// run is ever echoed there. Diagnostics go to the app log through debugLog.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_SCRIPT_PATH = path.join(
  os.homedir(), ".agents", "skills", "feishu-atme-digest", "bin", "feishu-atme-digest.py",
);
const RUN_TIMEOUT_MS = 120000;

// Time windows now live in ~/.feishu-atme/config.json (mentionWindowMinutes /
// allowWindowMinutes / directWindowMinutes / maxItems) and are read by the skill
// on every run, so changing them takes effect on the next poll with no restart.

const MAX_REASON_CHARS = 300;
const MAX_STREAM_BYTES = 4 * 1024 * 1024;
// The panel draws eight; the rest ride along so ignoring one row lets the next
// slide in without waiting for a refresh.
const MAX_ROWS = 60;

// `python` is the conventional name on Windows and on most Python installs, but
// a python3-only box (frequent on macOS and Linux) would otherwise look like a
// broken feature. Tried in order; the next candidate is used only when spawning
// the previous one failed with ENOENT.
const PYTHON_CANDIDATES = Object.freeze(["python", "python3"]);

// Debug-only: extra flags for the skill, e.g. "--include-read --keep-all-mentions"
// to demo the panel when there is nothing unread. Empty in normal use, so the
// shipped behaviour never includes read or @all messages.
const DEBUG_ARGS = String(process.env.FEISHU_ATME_DEBUG_ARGS || "")
  .split(/\s+/)
  .filter(Boolean);

function trimReason(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  return value.length > MAX_REASON_CHARS ? `${value.slice(0, MAX_REASON_CHARS)}…` : value;
}

function lastLine(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

function isMissingBinary(err) {
  return !!err && (err.code === "ENOENT" || /\bENOENT\b/.test(String(err.message || "")));
}

// A failed run reports the innermost thing worth reading. A python ENOENT, an
// unauthenticated lark-cli and a timeout all arrive on different streams, so
// prefer the script's own last stderr line when it produced one.
function failureReason(result) {
  if (result.timedOut) return "timed out";
  // spawnError is Node's own message about the interpreter, never message text.
  if (result.spawnError) return result.spawnError;
  if (result.overflow) return "output too large";
  return lastLine(result.stderr) || (result.code === null ? "unknown error" : `exit ${result.code}`);
}

// Only http(s) links are handed onward: a row click opens the OS browser, and
// the URL comes from message content.
function safeHref(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 2048) return "";
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? text : "";
  } catch {
    return "";
  }
}

function normalizeRows(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  const rows = [];
  for (const raw of rawItems) {
    if (rows.length >= MAX_ROWS) break;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const text = String(raw.text || "").trim();
    if (!text) continue;
    rows.push({
      tag: String(raw.tag || "").slice(0, 2),
      who: String(raw.who || "").slice(0, 40),
      where: String(raw.where || "").slice(0, 40),
      text: text.slice(0, 300),
      href: safeHref(raw.href),
      chatId: String(raw.chatId || "").slice(0, 64),
      messageId: String(raw.messageId || "").slice(0, 64),
      // One row per conversation: how many messages it stands for, and every id
      // it covers, so ignoring or handing off drops the whole conversation.
      count: Number.isInteger(raw.count) && raw.count > 0 ? raw.count : 1,
      messageIds: Array.isArray(raw.messageIds)
        ? raw.messageIds.filter((id) => typeof id === "string" && id).slice(0, 200)
        : [],
    });
  }
  return rows;
}

/**
 * Build the command. Returns { run } where run(options) resolves to a status
 * object and never rejects.
 *
 * @param {object} [options]
 * @param {string} [options.scriptPath]  skill entry point
 * @param {string[]} [options.pythonBins] interpreters to try in order
 * @param {Function} [options.spawnImpl] child_process.spawn seam for tests
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.debugLog]  app log sink (never user-visible)
 */
function createFeishuAtmeCommand(options = {}) {
  const scriptPath = options.scriptPath || DEFAULT_SCRIPT_PATH;
  const pythonBins = Array.isArray(options.pythonBins) && options.pythonBins.length
    ? options.pythonBins.slice()
    : PYTHON_CANDIDATES.slice();
  const spawnImpl = options.spawnImpl || spawn;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : RUN_TIMEOUT_MS;
  const existsSync = options.existsSync || fs.existsSync;
  const debugLog = typeof options.debugLog === "function" ? options.debugLog : null;

  let running = false;

  function log(message) {
    if (!debugLog) return;
    try { debugLog(`feishu-atme ${message}`); } catch {}
  }

  // Python encodes a redirected pipe with the locale codec on Windows (GBK on a
  // Chinese system) unless told otherwise. The script pins its own streams too;
  // setting it here as well means a stale installed copy still behaves.
  function childEnv() {
    return { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
  }

  function settle(status, extra = {}) {
    running = false;
    const result = { status, ...extra };
    log(`${status}${extra.reason ? ` (${extra.reason})` : ""}`);
    return result;
  }

  // python is usually a launcher: lark-cli ends up a grandchild. Killing only
  // python leaves it polling with nobody draining its output, and a second click
  // would overlap it.
  //
  // Overridable through `killTreeImpl`, and not only for tidiness: this reaches
  // for a real `taskkill` on a real pid, so a test that scripts a fake child
  // must never let the default run.
  function defaultKillTree(child) {
    try { child.kill(); } catch {}
    if (process.platform !== "win32") return;
    if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return;
    try {
      const tk = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      tk.on("error", () => {});
    } catch {}
  }

  const killTree = typeof options.killTreeImpl === "function" ? options.killTreeImpl : defaultKillTree;

  function spawnOnce(bin, onSettled) {
    const settled = {
      stdout: "", stderr: "", code: null, timedOut: false, overflow: false, spawnError: "",
    };
    let done = false;
    let timer = null;
    let child;

    const complete = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      onSettled(settled);
    };

    try {
      // The time windows and row cap come from the skill's config.json, which is
      // re-read on every run, so tuning them does not need an app restart.
      child = spawnImpl(bin, [
        scriptPath, "--json", "--no-push", "--no-dedupe",
        ...DEBUG_ARGS,
      ], {
        windowsHide: true,
        env: childEnv(),
      });
    } catch (err) {
      settled.spawnError = String((err && err.message) || err || "spawn failed");
      settled.spawnErrorCode = err && err.code;
      complete();
      return;
    }

    timer = setTimeout(() => {
      settled.timedOut = true;
      killTree(child);
      complete();
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    const take = (which, chunk) => {
      if (settled[which].length + chunk.length > MAX_STREAM_BYTES) {
        settled.overflow = true;
        return;
      }
      settled[which] += chunk;
    };

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => take("stdout", chunk));
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => take("stderr", chunk));
    }

    child.on("error", (err) => {
      settled.spawnError = String((err && err.message) || "spawn failed");
      settled.spawnErrorCode = err && err.code;
      complete();
    });
    child.on("close", (code) => {
      settled.code = code;
      complete();
    });
  }

  function run() {
    // A second click while the first is still talking to Feishu is not an error:
    // the callers already have the previous rows on screen.
    if (running) return Promise.resolve({ status: "busy" });

    if (!existsSync(scriptPath)) {
      return Promise.resolve(settle("missing", { scriptPath }));
    }

    running = true;

    const attempt = (index) => new Promise((resolveAttempt) => {
      spawnOnce(pythonBins[index], resolveAttempt);
    }).then((out) => {
      // Only an interpreter that does not exist warrants the next candidate; a
      // skill that ran and failed speaks for itself.
      if (index + 1 < pythonBins.length && !out.timedOut && isMissingBinary({
        code: out.spawnErrorCode,
        message: out.spawnError,
      })) {
        log(`interpreters.${pythonBins[index]} missing, trying ${pythonBins[index + 1]}`);
        return attempt(index + 1);
      }
      return out;
    });

    return attempt(0).then((out) => {
      if (out.spawnError || out.timedOut || out.overflow) {
        if (out.stdout) log(`stdout-head ${trimReason(out.stdout.slice(0, 400))}`);
        return settle("failed", { reason: failureReason(out) });
      }
      // Exit 3 means "nothing unread": a successful run with an empty answer, so
      // it must not be reported as a failure.
      if (out.code === 3) return settle("empty");
      if (out.code !== 0) return settle("failed", { reason: failureReason(out) });

      let payload;
      try {
        payload = JSON.parse(out.stdout);
      } catch {
        // Never echo stdout here: it holds other people's message text.
        if (out.stdout) log(`unparseable-stdout ${trimReason(out.stdout.slice(0, 400))}`);
        return settle("failed", { reason: "unparseable output" });
      }

      const total = payload && Number.isInteger(payload.total) ? payload.total : null;
      const card = payload && payload.card;
      const rows = normalizeRows(card && card.items);

      if (total === 0) return settle("empty");
      if (total === null || !rows.length) {
        // A positive count with no usable rows is an incompatible skill, not an
        // empty inbox — saying "nothing" would hide real mentions.
        log(`incompatible-output total=${total} rows=${rows.length}`);
        return settle("failed", { reason: "incompatible skill output" });
      }
      return settle("ready", {
        rows,
        title: String(card.title || ""),
        total,
        conversations: Number.isInteger(card.conversations) ? card.conversations : rows.length,
        truncated: payload.truncated === true,
      });
    }).catch((err) => settle("failed", { reason: trimReason(err && err.message) }));
  }

  return { run, scriptPath };
}

module.exports = {
  createFeishuAtmeCommand,
  DEFAULT_SCRIPT_PATH,
};
