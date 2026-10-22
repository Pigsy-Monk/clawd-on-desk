"use strict";

// src/server-route-notice.js — the agent → pet notice routes: POST /notice, the
// push, and DELETE /notice, the retraction.
//
// An agent (or a hook acting for one) hands the pet a short text card. The
// store owns every shape and limit decision — normalization, level/TTL clamps,
// the empty-card refusal (src/notice-store.js) — so this handler stays a
// transport shim: cap the body, parse the JSON, hand the raw object over and
// report what landed. A push may carry a `key`, which makes it replace the live
// card it matches rather than stacking a twin; the store decides that, and the
// answer comes back as `replaced`.
//
// DELETE is the other half: without it a card can only be taken back by its own
// TTL expiring, so a cancelled job (a stopped pomodoro, a build that got fixed)
// leaves a card lying on screen until its lifetime runs out. The caller names
// what to take back and is told how many cards actually went.

const { CLAWD_SERVER_HEADER, CLAWD_SERVER_ID } = require("../hooks/server-config");

// A notice body is not only agent-authored prose: it can carry a base64-encoded
// PNG chart, which inflates the payload by a third, so the transport cap is
// sized for an image rather than a paragraph. The store independently caps the
// *decoded* image at 6 MB (MAX_IMAGE_BYTES in src/notice-store.js) and refuses
// anything that is not a real PNG, so this number only bounds what a misbehaving
// pusher can make the process buffer. Local-only 127.0.0.1 endpoint — not an
// Internet DoS concern.
const MAX_NOTICE_BODY_BYTES = 8 * 1024 * 1024;

function isUsableNoticeStore(store) {
  return !!store
    && typeof store.add === "function"
    && typeof store.list === "function";
}

// The removal half of the same store. Checked separately rather than folded
// into the test above so each handler states the methods it actually calls.
function isUsableNoticeStoreForDelete(store) {
  return !!store
    && typeof store.remove === "function"
    && typeof store.removeByKey === "function"
    && typeof store.clear === "function";
}

function handleNoticePost(req, res, options) {
  const { noticeStore, debugLog } = options;
  let body = "";
  let bodySize = 0;
  let tooLarge = false;
  req.on("data", (chunk) => {
    if (tooLarge) return;
    bodySize += chunk.length;
    if (bodySize > MAX_NOTICE_BODY_BYTES) { tooLarge = true; return; }
    body += chunk;
  });
  req.on("end", () => {
    if (tooLarge) {
      res.writeHead(413);
      res.end("notice payload too large");
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end("bad json");
      return;
    }
    // main.js creates and owns the store; a route that fires before that wiring
    // lands (or after dispose) must fail closed rather than throw here.
    if (!isUsableNoticeStore(noticeStore)) {
      res.writeHead(503);
      res.end("notice store unavailable");
      return;
    }
    let added;
    try {
      added = noticeStore.add(parsed);
    } catch (err) {
      // The store is the only validator and is total by design, so a fault here
      // is a wiring bug: report it instead of letting it escape the handler.
      if (typeof debugLog === "function") {
        debugLog(`notice-route-error ${err && err.message ? err.message : "unknown"}`);
      }
      res.writeHead(500);
      res.end("notice store error");
      return;
    }
    if (!added) {
      res.writeHead(400);
      res.end("empty notice");
      return;
    }
    const { notice, replaced } = added;
    res.writeHead(200, {
      "Content-Type": "application/json",
      [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID,
    });
    // `replaced` tells a pusher whether its key refreshed a card that was
    // already up or started a new one — the difference between a heartbeat that
    // is working and one whose key silently stopped matching. `ttl` and
    // `presentation` echo the store's normalized values, so a caller can see
    // the lifetime it actually got (a level default when it sent no ttl) and
    // whether it asked for the card.
    res.end(JSON.stringify({
      ok: true,
      id: notice.id,
      count: noticeStore.list().length,
      replaced,
      ttl: notice.ttl,
      presentation: notice.presentation,
    }));
  });
}

// Which selector the body names, or null when it names none. Presence is what
// counts, not usability: a `key` or `id` the store cannot use is a selector
// that matches nothing (removed: 0), not a missing one — the store already
// reads an unusable key as absent. `all` is the exception, being a flag: only a
// literal true means "the whole stack".
//
// Narrowest first. A body naming both a key and `all` is read as the key, so a
// stray `all` cannot quietly turn a targeted retraction into a wipe.
function readDeleteSelector(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (Object.prototype.hasOwnProperty.call(parsed, "key")) {
    return { kind: "key", value: parsed.key };
  }
  if (Object.prototype.hasOwnProperty.call(parsed, "id")) {
    return { kind: "id", value: parsed.id };
  }
  if (parsed.all === true) return { kind: "all" };
  return null;
}

function applyDeleteSelector(store, selector) {
  if (selector.kind === "all") return store.clear();
  if (selector.kind === "key") return store.removeByKey(selector.value);
  // remove() answers whether it took anything; the route reports a count.
  return store.remove(selector.value) ? 1 : 0;
}

// DELETE /notice — take a card back.
//
// The body is JSON rather than a query string because the transport guard
// (rejectUnsafeLocalHookRequest in src/server.js) requires a JSON content type
// and refuses anything else with 415: a body-less `DELETE /notice?key=x` would
// never reach this handler. That guard is the CSRF protection and stays as it
// is, so callers send `{"key": "..."}`, `{"id": "..."}` or `{"all": true}`.
function handleNoticeDelete(req, res, options) {
  const { noticeStore, debugLog } = options;
  let body = "";
  let bodySize = 0;
  let tooLarge = false;
  req.on("data", (chunk) => {
    if (tooLarge) return;
    bodySize += chunk.length;
    if (bodySize > MAX_NOTICE_BODY_BYTES) { tooLarge = true; return; }
    body += chunk;
  });
  req.on("end", () => {
    if (tooLarge) {
      res.writeHead(413);
      res.end("notice payload too large");
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end("bad json");
      return;
    }
    const selector = readDeleteSelector(parsed);
    // A DELETE that names nothing is refused rather than read as "clear
    // everything": an accidentally empty body must not wipe the stack. This is
    // checked before the store because it is a property of the request, not of
    // what is wired up behind it.
    if (!selector) {
      res.writeHead(400);
      res.end("no selector");
      return;
    }
    // main.js creates and owns the store; a route that fires before that wiring
    // lands (or after dispose) must fail closed rather than throw here.
    if (!isUsableNoticeStoreForDelete(noticeStore)) {
      res.writeHead(503);
      res.end("notice store unavailable");
      return;
    }
    let removed;
    try {
      removed = applyDeleteSelector(noticeStore, selector);
    } catch (err) {
      // As in the push handler: the store is total by design, so a fault here
      // is a wiring bug worth reporting rather than letting escape.
      if (typeof debugLog === "function") {
        debugLog(`notice-route-error ${err && err.message ? err.message : "unknown"}`);
      }
      res.writeHead(500);
      res.end("notice store error");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID,
    });
    // `removed` counts what actually went, so a caller can tell a retraction
    // that landed from one that named nothing. 0 is a normal answer: removing a
    // card that has already expired or never existed is not an error.
    res.end(JSON.stringify({ ok: true, removed }));
  });
}

// POST /stretch/try — the same as Settings "Try it now" for stretch breaks:
// the pet raises its stretch invite at once instead of waiting for the
// interval. Takes no body; the answer is the runtime's own
// { status, phase[, alreadyActive] }. server.js only routes it for local
// (non-Remote-SSH) requests that pass the hook transport checks.
function handleStretchTryPost(req, res, options = {}) {
  if (req && typeof req.resume === "function") req.resume();
  let result = { status: "error", message: "stretch breaks unavailable" };
  try {
    if (typeof options.tryStretchNow === "function") result = options.tryStretchNow() || result;
  } catch (err) {
    result = { status: "error", message: err && err.message ? err.message : "failed" };
  }
  const ok = result && result.status === "ok";
  res.writeHead(ok ? 200 : 503, {
    "Content-Type": "application/json",
    [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID,
  });
  res.end(JSON.stringify(result));
}

module.exports = {
  handleStretchTryPost,
  MAX_NOTICE_BODY_BYTES,
  handleNoticePost,
  handleNoticeDelete,
};
