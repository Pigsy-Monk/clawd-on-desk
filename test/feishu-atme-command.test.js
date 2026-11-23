"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const { createFeishuAtmeCommand } = require("../src/feishu-atme-command");

// A child_process.spawn stand-in: the test drives stdout/stderr/close so the
// module's outcome mapping can be checked without python, lark-cli or Feishu.
function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => { child.killed = true; };
  return child;
}

const PAYLOAD = {
  total: 2,
  truncated: false,
  buckets: { urgent: [], reply: [], notice: [], bot: [] },
  card: {
    title: "飞书 @你：2 条",
    level: "warn",
    ttl: 900,
    sticky: true,
    items: [
      { tag: "回", who: "庄敏", where: "Shopping群", text: "问进度",
        href: "https://applink.feishu.cn/client/chat/open?openChatId=oc_1",
        createTime: "2026-11-19 21:18" },
      { tag: "知", who: "方菊", where: "RCA群", text: "漏洞通知", href: "https://applink.feishu.cn/client/chat/open?openChatId=oc_2" },
    ],
  },
};

function harness({ script, exists = true, pythonBins, timeoutMs } = {}) {
  const calls = [];
  const kills = [];
  const command = createFeishuAtmeCommand({
    scriptPath: "/fake/feishu-atme-digest.py",
    ...(pythonBins ? { pythonBins } : {}),
    ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
    existsSync: () => exists,
    killTreeImpl: (child) => { child.killed = true; kills.push(child); },
    spawnImpl: (bin, args, opts) => {
      calls.push({ bin, args, opts });
      const child = fakeChild(4242);
      process.nextTick(() => script(child, calls.length - 1));
      return child;
    },
  });
  return { command, calls, kills, promise: command.run() };
}

describe("feishu-atme-command", () => {
  it("returns the digest rows for the pet's click panel", async () => {
    const { promise } = harness({
      script: (child) => {
        child.stdout.emit("data", JSON.stringify(PAYLOAD));
        child.emit("close", 0);
      },
    });

    const result = await promise;

    assert.strictEqual(result.status, "ready");
    assert.strictEqual(result.total, 2);
    assert.strictEqual(result.rows.length, 2);
    assert.deepStrictEqual(result.rows[0], {
      tag: "回",
      who: "庄敏",
      where: "Shopping群",
      text: "问进度",
      href: "https://applink.feishu.cn/client/chat/open?openChatId=oc_1",
      createTime: "2026-11-19 21:18",
      chatId: "",
      messageId: "",
      count: 1,
      messageIds: [],
      read: null,
    });
  });

  it("asks python for UTF-8 on the pipe and never pushes a card", async () => {
    const { promise, calls } = harness({
      script: (child) => child.emit("close", 3),
    });
    await promise;

    assert.deepStrictEqual(calls[0].args, [
      "/fake/feishu-atme-digest.py", "--json", "--no-push", "--no-dedupe",
    ]);
    assert.strictEqual(calls[0].opts.env.PYTHONIOENCODING, "utf-8");
    assert.strictEqual(calls[0].opts.env.PYTHONUTF8, "1");
    assert.strictEqual(calls[0].opts.windowsHide, true);
  });

  it("drops rows whose link is not http(s)", async () => {
    const payload = {
      total: 2,
      card: {
        title: "t",
        items: [
          { tag: "回", who: "a", where: "b", text: "ok", href: "javascript:alert(1)" },
          { tag: "回", who: "c", where: "d", text: "ok", href: "not a url" },
        ],
      },
    };
    const { promise } = harness({
      script: (child) => {
        child.stdout.emit("data", JSON.stringify(payload));
        child.emit("close", 0);
      },
    });

    const result = await promise;

    assert.strictEqual(result.status, "ready");
    assert.deepStrictEqual(result.rows.map((r) => r.href), ["", ""]);
  });

  it("carries the message time, truncated to whole minutes, for the day buckets", async () => {
    const payload = {
      total: 2,
      card: {
        title: "t",
        items: [
          { tag: "回", text: "ok", createTime: "2026-11-19 21:18:07.000000" },
          { tag: "回", text: "no time at all" },
        ],
      },
    };
    const { promise } = harness({
      script: (child) => {
        child.stdout.emit("data", JSON.stringify(payload));
        child.emit("close", 0);
      },
    });

    const result = await promise;

    assert.deepStrictEqual(result.rows.map((r) => r.createTime), ["2026-11-19 21:18:07", ""]);
  });

  it("drops rows with no text but keeps the rest", async () => {
    const payload = {
      total: 2,
      card: { title: "t", items: [{ tag: "回", text: "", href: "" }, { tag: "知", text: "有内容" }] },
    };
    const { promise } = harness({
      script: (child) => {
        child.stdout.emit("data", JSON.stringify(payload));
        child.emit("close", 0);
      },
    });

    const result = await promise;
    assert.strictEqual(result.rows.length, 1);
    assert.strictEqual(result.rows[0].text, "有内容");
  });

  it("maps exit 3 to empty, not a failure", async () => {
    const { promise } = harness({
      script: (child) => {
        child.stdout.emit("data", JSON.stringify({ total: 0, buckets: {} }));
        child.emit("close", 3);
      },
    });

    assert.strictEqual((await promise).status, "empty");
  });

  it("reports a positive total with no usable rows as incompatible", async () => {
    const { promise } = harness({
      script: (child) => {
        child.stdout.emit("data", JSON.stringify({ total: 2, buckets: {} }));
        child.emit("close", 0);
      },
    });

    const result = await promise;
    assert.strictEqual(result.status, "failed");
    assert.match(result.reason, /incompatible/);
  });

  it("surfaces the last stderr line when the skill fails", async () => {
    const { promise } = harness({
      script: (child) => {
        child.stderr.emit("data", "[error] token 过期\n[error] lark-cli auth login\n");
        child.emit("close", 1);
      },
    });

    const result = await promise;
    assert.strictEqual(result.status, "failed");
    assert.match(result.reason, /lark-cli auth login/);
  });

  it("never echoes stdout content into the failure reason", async () => {
    const leak = 'Traceback\nKeyError: 保密内容';
    const { promise } = harness({
      script: (child) => {
        child.stdout.emit("data", leak);
        child.emit("close", 0);
      },
    });

    const result = await promise;
    assert.strictEqual(result.status, "failed");
    assert.strictEqual(result.reason, "unparseable output");
    assert.ok(!JSON.stringify(result).includes("保密内容"));
  });

  it("reports a missing skill instead of running anything", async () => {
    const { promise, calls } = harness({ exists: false, script: () => {} });
    const result = await promise;

    assert.strictEqual(result.status, "missing");
    assert.strictEqual(result.scriptPath, "/fake/feishu-atme-digest.py");
    assert.strictEqual(calls.length, 0);
  });

  it("falls back to python3 when python does not exist", async () => {
    const { promise, calls } = harness({
      pythonBins: ["python", "python3"],
      script: (child, index) => {
        if (index === 0) {
          const err = new Error("spawn python ENOENT");
          err.code = "ENOENT";
          child.emit("error", err);
          return;
        }
        child.stdout.emit("data", JSON.stringify(PAYLOAD));
        child.emit("close", 0);
      },
    });

    const result = await promise;

    assert.strictEqual(result.status, "ready");
    assert.deepStrictEqual(calls.map((c) => c.bin), ["python", "python3"]);
  });

  it("does not retry another interpreter when the skill itself fails", async () => {
    const { promise, calls } = harness({
      pythonBins: ["python", "python3"],
      script: (child) => {
        child.stderr.emit("data", "[error] lark-cli auth login\n");
        child.emit("close", 1);
      },
    });

    assert.strictEqual((await promise).status, "failed");
    assert.strictEqual(calls.length, 1);
  });

  it("ignores a second call while one run is in flight", async () => {
    let release;
    let spawned = 0;
    const command = createFeishuAtmeCommand({
      scriptPath: "/fake/x.py",
      existsSync: () => true,
      spawnImpl: () => {
        spawned += 1;
        const child = fakeChild(1);
        release = () => child.emit("close", 3);
        return child;
      },
    });

    const first = command.run();
    assert.strictEqual((await command.run()).status, "busy");
    release();
    assert.strictEqual((await first).status, "empty");
    assert.strictEqual(spawned, 1);
  });

  it("clears the busy latch after a run so the next call works", async () => {
    const command = createFeishuAtmeCommand({
      scriptPath: "/fake/x.py",
      existsSync: () => true,
      spawnImpl: () => {
        const child = fakeChild(1);
        process.nextTick(() => child.emit("close", 3));
        return child;
      },
    });

    assert.strictEqual((await command.run()).status, "empty");
    assert.strictEqual((await command.run()).status, "empty");
  });

  it("times out a hung child and kills it", async () => {
    const { promise, kills } = harness({ timeoutMs: 20, script: () => {} });

    const result = await promise;

    assert.strictEqual(result.status, "failed");
    assert.strictEqual(result.reason, "timed out");
    assert.strictEqual(kills.length, 1, "the hung child is torn down");
  });

  it("treats oversized output as a failure without echoing it", async () => {
    const { promise } = harness({
      script: (child) => {
        child.stdout.emit("data", "x".repeat(5 * 1024 * 1024));
        child.emit("close", 0);
      },
    });

    const result = await promise;
    assert.strictEqual(result.status, "failed");
    assert.strictEqual(result.reason, "output too large");
  });
});
