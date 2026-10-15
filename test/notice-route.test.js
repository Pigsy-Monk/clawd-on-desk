"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const { CLAWD_SERVER_HEADER, CLAWD_SERVER_ID } = require("../hooks/server-config");
const { createNoticeStore } = require("../src/notice-store");
const {
  MAX_NOTICE_BODY_BYTES,
  handleNoticePost,
  handleNoticeDelete,
} = require("../src/server-route-notice");

function makeReq(body) {
  const req = new EventEmitter();
  req.headers = {};
  setImmediate(() => {
    if (body != null) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function makeRes() {
  const res = new EventEmitter();
  res.statusCode = null;
  res.headers = {};
  res.body = "";
  res.headersSent = false;
  res.writeHead = function writeHead(code, headers) {
    this.statusCode = code;
    this.headersSent = true;
    if (headers) this.headers = headers;
  };
  res.end = function end(data) {
    if (data) this.body += String(data);
    this.writableFinished = true;
  };
  return res;
}

function callNoticePost(body, options = {}) {
  return new Promise((resolve) => {
    const res = makeRes();
    handleNoticePost(makeReq(body), res, options);
    setImmediate(() => resolve(res));
  });
}

describe("POST /notice", () => {
  it("accepts a valid notice into a real store", async () => {
    const store = createNoticeStore({ max: 5 });
    const res = await callNoticePost(
      JSON.stringify({ title: "Build done", body: "12 files", level: "success", ttl: 5000 }),
      { noticeStore: store }
    );

    assert.strictEqual(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.strictEqual(payload.ok, true);
    assert.match(payload.id, /^notice-\d+$/);
    assert.strictEqual(payload.count, 1);
    assert.strictEqual(payload.replaced, false, "an unkeyed push created a card");

    const landed = store.list();
    assert.strictEqual(landed.length, 1);
    assert.strictEqual(landed[0].id, payload.id);
    assert.strictEqual(landed[0].title, "Build done");
    assert.strictEqual(landed[0].level, "success");
  });

  it("reports a keyed push that refreshed a live notice instead of creating one", async () => {
    const store = createNoticeStore({ max: 5 });
    const first = await callNoticePost(
      JSON.stringify({ title: "hb 1", body: "beat", key: "heartbeat" }),
      { noticeStore: store }
    );
    const second = await callNoticePost(
      JSON.stringify({ title: "hb 2", body: "beat", key: "heartbeat" }),
      { noticeStore: store }
    );

    const created = JSON.parse(first.body);
    const refreshed = JSON.parse(second.body);
    assert.strictEqual(created.replaced, false);
    assert.strictEqual(refreshed.replaced, true);
    assert.strictEqual(refreshed.id, created.id, "the card keeps its id across a replace");
    assert.strictEqual(refreshed.count, 1, "and its place in the stack");
    assert.strictEqual(store.list()[0].title, "hb 2");
  });

  it("answers 200 with the clawd server header on success", async () => {
    const store = createNoticeStore({ max: 5 });
    const res = await callNoticePost(JSON.stringify({ body: "hi" }), { noticeStore: store });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
    assert.strictEqual(res.headers["Content-Type"], "application/json");
  });

  it("rejects malformed JSON with 400", async () => {
    const store = createNoticeStore({ max: 5 });
    const res = await callNoticePost("{not json", { noticeStore: store });

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body, "bad json");
    assert.strictEqual(store.list().length, 0);
  });

  it("rejects a body over the byte cap with 413", async () => {
    const store = createNoticeStore({ max: 5 });
    const oversized = JSON.stringify({ title: "x".repeat(MAX_NOTICE_BODY_BYTES + 1024) });
    assert.ok(Buffer.byteLength(oversized) > MAX_NOTICE_BODY_BYTES);
    const res = await callNoticePost(oversized, { noticeStore: store });

    assert.strictEqual(res.statusCode, 413);
    assert.strictEqual(res.body, "notice payload too large");
    assert.strictEqual(store.list().length, 0);
  });

  it("rejects a notice with neither title nor body with 400", async () => {
    const store = createNoticeStore({ max: 5 });
    const res = await callNoticePost(
      JSON.stringify({ title: "   ", body: "" }),
      { noticeStore: store }
    );

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body, "empty notice");
    assert.strictEqual(store.list().length, 0);
  });

  it("answers 503 when the store is missing", async () => {
    const res = await callNoticePost(JSON.stringify({ body: "hi" }), {});

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body, "notice store unavailable");
  });
});

function callNoticeDelete(body, options = {}) {
  return new Promise((resolve) => {
    const res = makeRes();
    handleNoticeDelete(makeReq(body), res, options);
    setImmediate(() => resolve(res));
  });
}

// Three live cards with the middle one keyed, so a retraction has neighbours on
// both sides to leave alone. Returns the store plus the ids the pushes were
// handed, which is what the id selector names.
async function seededStore() {
  const store = createNoticeStore({ max: 5 });
  const ids = [];
  for (const push of [
    { title: "a", body: "first" },
    { title: "pomodoro", body: "24:00", key: "pomodoro" },
    { title: "b", body: "third" },
  ]) {
    const res = await callNoticePost(JSON.stringify(push), { noticeStore: store });
    ids.push(JSON.parse(res.body).id);
  }
  return { store, ids };
}

describe("DELETE /notice", () => {
  it("removes the notice a key names and reports one removal", async () => {
    const { store } = await seededStore();
    const res = await callNoticeDelete(JSON.stringify({ key: "pomodoro" }), {
      noticeStore: store,
    });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { ok: true, removed: 1 });
    assert.deepStrictEqual(store.list().map((n) => n.title), ["a", "b"]);
  });

  it("removes the notice an id names", async () => {
    const { store, ids } = await seededStore();
    const res = await callNoticeDelete(JSON.stringify({ id: ids[0] }), {
      noticeStore: store,
    });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { ok: true, removed: 1 });
    assert.deepStrictEqual(store.list().map((n) => n.id), [ids[1], ids[2]]);
  });

  it("removes every live notice for all: true", async () => {
    const { store } = await seededStore();
    const res = await callNoticeDelete(JSON.stringify({ all: true }), {
      noticeStore: store,
    });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { ok: true, removed: 3 });
    assert.deepStrictEqual(store.list(), []);
  });

  it("answers 200 with removed: 0 when the selector matches nothing", async () => {
    const { store } = await seededStore();
    const res = await callNoticeDelete(JSON.stringify({ key: "already-gone" }), {
      noticeStore: store,
    });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { ok: true, removed: 0 });
    assert.strictEqual(store.list().length, 3, "and the stack is untouched");
  });

  it("treats a second removal of the same card as a normal 0", async () => {
    const { store } = await seededStore();
    await callNoticeDelete(JSON.stringify({ key: "pomodoro" }), { noticeStore: store });
    const res = await callNoticeDelete(JSON.stringify({ key: "pomodoro" }), {
      noticeStore: store,
    });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { ok: true, removed: 0 });
  });

  it("reads an unusable key as a selector that matches nothing, not a missing one", async () => {
    const { store } = await seededStore();
    const res = await callNoticeDelete(JSON.stringify({ key: 42 }), { noticeStore: store });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { ok: true, removed: 0 });
    assert.strictEqual(store.list().length, 3);
  });

  it("reads a body naming both a key and all as the key", async () => {
    const { store } = await seededStore();
    const res = await callNoticeDelete(JSON.stringify({ key: "pomodoro", all: true }), {
      noticeStore: store,
    });

    assert.deepStrictEqual(JSON.parse(res.body), { ok: true, removed: 1 });
    assert.strictEqual(store.list().length, 2, "the stray all did not wipe the stack");
  });

  it("answers 200 with the clawd server header on success", async () => {
    const { store } = await seededStore();
    const res = await callNoticeDelete(JSON.stringify({ all: true }), { noticeStore: store });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
    assert.strictEqual(res.headers["Content-Type"], "application/json");
  });

  it("refuses a body with no selector rather than clearing the stack", async () => {
    const { store } = await seededStore();

    for (const body of ["{}", '{"all": false}', '{"title": "x"}', "null", "[]", '""']) {
      const res = await callNoticeDelete(body, { noticeStore: store });
      assert.strictEqual(res.statusCode, 400, `body ${body}`);
      assert.strictEqual(res.body, "no selector");
    }
    assert.strictEqual(store.list().length, 3, "nothing was wiped");
  });

  it("rejects malformed JSON with 400", async () => {
    const { store } = await seededStore();
    const res = await callNoticeDelete("{not json", { noticeStore: store });

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body, "bad json");
    assert.strictEqual(store.list().length, 3);
  });

  it("rejects a body over the byte cap with 413", async () => {
    const { store } = await seededStore();
    const oversized = JSON.stringify({ key: "x".repeat(MAX_NOTICE_BODY_BYTES + 1024) });
    assert.ok(Buffer.byteLength(oversized) > MAX_NOTICE_BODY_BYTES);
    const res = await callNoticeDelete(oversized, { noticeStore: store });

    assert.strictEqual(res.statusCode, 413);
    assert.strictEqual(res.body, "notice payload too large");
    assert.strictEqual(store.list().length, 3);
  });

  it("answers 503 when the store is missing", async () => {
    const res = await callNoticeDelete(JSON.stringify({ all: true }), {});

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body, "notice store unavailable");
  });

  it("answers 503 for a store without the removal methods", async () => {
    const res = await callNoticeDelete(JSON.stringify({ all: true }), {
      noticeStore: { add: () => null, list: () => [] },
    });

    assert.strictEqual(res.statusCode, 503);
  });

  it("reports a store fault as 500 instead of letting it escape", async () => {
    const logged = [];
    const res = await callNoticeDelete(JSON.stringify({ key: "k" }), {
      noticeStore: {
        remove: () => false,
        clear: () => 0,
        removeByKey: () => { throw new Error("boom"); },
      },
      debugLog: (line) => logged.push(line),
    });

    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.body, "notice store error");
    assert.ok(logged.some((line) => line.includes("boom")));
  });
});
