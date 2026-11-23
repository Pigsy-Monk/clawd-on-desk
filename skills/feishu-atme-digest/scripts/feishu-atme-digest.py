#!/usr/bin/env python3
"""拉飞书 @我 的未读消息，分类，推一张卡片给 Clawd 桌宠。

只用标准库 + lark-cli + pet-notice/bin/push-notice.py。
没有未读就什么都不推（半小时一轮的轮询，安静是对的）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

PUSH_NOTICE = Path.home() / ".agents" / "skills" / "pet-notice" / "bin" / "push-notice.py"
DEFAULT_STATE = Path.home() / ".feishu-atme" / "state.json"
DEFAULT_CONFIG = Path.home() / ".feishu-atme" / "config.json"
DEFAULT_SUMMARY_CACHE = Path.home() / ".feishu-atme" / "summaries.json"
SUMMARY_CACHE_TTL_S = 7 * 86400
PUSH_KEY = "feishu-atme"
STATE_TTL_DAYS = 7

# 三个来源三个窗口：
#   私聊     —— 只要能拿到的未读（服务端按发送者类型滤过，几乎全是真人）
#   白名单群 —— 7 天
#   其他群   —— 24 小时
MENTION_WINDOW_MINUTES = 1440
ALLOW_WINDOW_MINUTES = 7 * 1440
DIRECT_WINDOW_MINUTES = 30 * 1440

# 命中任一词就进「急」档，不论是直接 @ 还是 @all
URGENT_WORDS = (
    "紧急", "急", "线上", "故障", "P0", "p0", "P1", "p1", "事故", "宕",
    "回滚", "阻塞", "blocker", "挂了", "报错", "失败", "超时", "告警",
    "asap", "ASAP", "马上", "尽快", "催",
)

BUCKETS = ("urgent", "reply", "notice", "bot")
BUCKET_CN = {"urgent": "急", "reply": "待回", "notice": "知会", "bot": "机器人"}
BUCKET_TAG = {"urgent": "急", "reply": "回", "notice": "知", "bot": "器"}


class LarkError(RuntimeError):
    pass


def lark_bin() -> str:
    found = shutil.which("lark-cli")
    if not found:
        raise LarkError("lark-cli 不在 PATH 上")
    return found


def run_lark(args: list[str], timeout: int = 90, json_flag: bool = True) -> dict:
    """跑一条 lark-cli 命令，返回解析好的 JSON。

    json_flag=False 给本来就只输出 JSON、且不认 --format 的命令（auth status）。
    """
    cmd = [lark_bin()] + args + (["--format", "json"] if json_flag else [])
    proc = subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8",
        errors="replace", timeout=timeout,
    )
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-400:]
        raise LarkError(f"{' '.join(args[:3])} 退出码 {proc.returncode}: {tail}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise LarkError(f"{' '.join(args[:3])} 返回的不是 JSON: {exc}") from exc


def my_open_id() -> str:
    """当前登录用户的 open_id —— 用来区分「直接 @ 我」和「@all」。"""
    data = run_lark(["auth", "status"], timeout=30, json_flag=False)
    oid = (((data.get("identities") or {}).get("user") or {}).get("openId") or "").strip()
    if not oid:
        raise LarkError("auth status 里没有 user.openId，先跑 lark-cli auth login")
    return oid


def iso_local(dt: datetime) -> str:
    # isoformat keeps a half- or quarter-hour offset intact (+05:30). The old
    # strftime("%z") + [:-2] + ":00" turned +0530 into +05:00, which shifts both
    # search bounds for anyone not on a whole-hour timezone.
    return dt.astimezone().isoformat(timespec="seconds")


def force_utf8_stdio() -> None:
    """Pin stdout/stderr to UTF-8 regardless of how we were launched.

    On Windows Python picks the locale encoding for a redirected pipe (GBK on a
    Chinese system), while callers — the Electron menu item, any JSON consumer —
    decode UTF-8. Depending on the caller's PYTHONIOENCODING to be set is exactly
    the trap: a desktop app launched from Explorer inherits no such thing, and
    the digest then arrives as mojibake or dies with UnicodeEncodeError on the
    first emoji.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass



def search_at_me(lookback_minutes: int, page_limit: int) -> tuple[list[dict], bool]:
    """搜 @我 的消息。--is-at-me 同时会带回 @all 广播，分类时再拆。

    返回 (messages, truncated)。truncated 表示搜索还有下一页没取完——这时
    「没有未读」只代表「已翻的这几页里没有」，不能当成整个收件箱的结论。
    """
    now = datetime.now().astimezone()
    # 一次搜到白名单的上限（7 天），再按来源分别裁剪：直接@ 的看 24 小时，
    # @all 的只在白名单群里保留。
    start = now - timedelta(minutes=max(lookback_minutes, ALLOW_WINDOW_MINUTES))
    data = run_lark([
        "im", "+messages-search",
        "--is-at-me",
        "--start", iso_local(start),
        "--end", iso_local(now),
        "--page-size", "50",
        "--page-limit", str(page_limit),
        "--no-reactions",
        "--as", "user",
    ])
    envelope = data.get("data") or {}
    return list(envelope.get("messages") or []), bool(envelope.get("has_more"))


def search_direct(lookback_minutes: int, page_limit: int, me: str,
                  include_bot: bool = False) -> tuple[list[dict], bool]:
    """最近窗口里的私聊消息。

    私聊不会 @ 人，所以 --is-at-me 一条都拿不到；这里不带关键词、只限定
    chat_type=p2p 和时间窗去搜，再把「我自己发的」剔掉。返回 (messages, truncated)。
    """
    now = datetime.now().astimezone()
    start = now - timedelta(minutes=max(lookback_minutes, DIRECT_WINDOW_MINUTES))
    data = run_lark([
        "im", "+messages-search",
        "--chat-type", "p2p",
        "--sender-type", "user",
        "--start", iso_local(start),
        "--end", iso_local(now),
        "--page-size", "50",
        "--page-limit", str(page_limit),
        "--no-reactions",
        "--as", "user",
    ])
    envelope = data.get("data") or {}
    raw = list(envelope.get("messages") or [])
    mine = []
    for msg in raw:
        sender = msg.get("sender") or {}
        if sender.get("id") == me:
            continue
        # 机器人私聊基本是告警/通知流水：一晚上能把面板灌成 100+ 条，把真人
        # 私聊挤没。默认不收，需要时用 includeBotDm 打开。
        if not include_bot and (sender.get("sender_type") or "").lower() in ("bot", "app"):
            continue
        mine.append(msg)
    return mine, bool(envelope.get("has_more"))


def unread_ids(message_ids: list[str]) -> tuple[set[str], set[str]]:
    """问服务端这些消息我读过没。一次最多 50 条，分批。

    返回 (unread, unresolved)。服务端对读不清的 id 只放进 invalid_message_ids、
    不给原因，所以「没出现在 items 里」既可能是已读也可能是查不出来。把查不出来
    的当已读会悄悄吞掉消息，所以这里单独交出来，由调用方按未读处理。
    """
    unread: set[str] = set()
    resolved: set[str] = set()
    for i in range(0, len(message_ids), 50):
        chunk = message_ids[i:i + 50]
        data = run_lark([
            "im", "+messages-read-status",
            "--message-ids", ",".join(chunk),
            "--as", "user",
        ])
        envelope = data.get("data") or {}
        for item in (envelope.get("items") or []):
            mid = item.get("message_id")
            if not mid:
                continue
            resolved.add(mid)
            if item.get("is_read") is False:
                unread.add(mid)
    unresolved = {mid for mid in message_ids if mid not in resolved}
    return unread, unresolved



def load_state(path: Path) -> dict:
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"pushed": {}}
    if not isinstance(state, dict) or not isinstance(state.get("pushed"), dict):
        return {"pushed": {}}
    cutoff = time.time() - STATE_TTL_DAYS * 86400
    state["pushed"] = {
        mid: ts for mid, ts in state["pushed"].items()
        if isinstance(ts, (int, float)) and ts > cutoff
    }
    return state


def save_state(path: Path, state: dict) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)
    except OSError as exc:
        print(f"[warn] 状态写不进去 {path}: {exc}", file=sys.stderr)


def load_config(path: Path) -> dict:
    """读 ~/.feishu-atme/config.json。坏了就当空配置，不影响跑。"""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def config_list(config: dict, key: str) -> list[str]:
    value = config.get(key)
    if not isinstance(value, list):
        return []
    return [str(v).strip() for v in value if str(v).strip()]


def clean_patterns(patterns: list[str]) -> list[str]:
    """空串要丢掉：`"" in 群名` 恒真，会把白名单变成「全部」，把屏蔽表变成「屏蔽一切」。"""
    out = []
    for p in patterns:
        text = str(p or "").strip()
        if text:
            out.append(text)
    return out


# ── @all 过滤 ────────────────────────────────────────────────────────────────
# --is-at-me 只返回「@我」或「@all」两种消息，所以凡是不直接@我的，就都是 @all
# 广播。它们默认全部丢掉；只有群名命中白名单的群，才把它的 @all 放回来。


def is_broadcast(msg: dict, me: str) -> bool:
    """不直接@我、也不是私聊——即 @all 捎上的。"""
    if (msg.get("chat_type") or "") == "p2p":
        return False
    return not is_direct_at(msg, me)


def keep_broadcast(msg: dict, allow_all_in: list[str]) -> bool:
    if not allow_all_in:
        return False
    chat = msg.get("chat_name") or ""
    return any(pat in chat for pat in allow_all_in)



AT_TAG = re.compile(r"<at[^>]*>.*?</at>|@_user_\d+|@_all\b", re.I | re.S)
IMG_TAG = re.compile(r"!\[Image\]\([^)]*\)|\[图片\]")
WS = re.compile(r"\s+")


def plain_text(msg: dict) -> str:
    """把消息正文压成一行可读文本。"""
    raw = msg.get("content")
    if isinstance(raw, dict):
        # 空 dict 要落到下面的 [msg_type] 兜底，不能变成字面的 "{}"
        raw = raw.get("text") or raw.get("title") or (json.dumps(raw, ensure_ascii=False) if raw else "")
    text = str(raw or "")
    text = AT_TAG.sub(" ", text)
    # 服务端有时把 @ 渲染成显示名（`@Jason Song (宋志伟)`），按 mentions 里的真名删掉
    for m in (msg.get("mentions") or []):
        name = (m or {}).get("name") if isinstance(m, dict) else None
        if name:
            text = text.replace(f"@{name}", " ").replace(name, " ")
    text = IMG_TAG.sub("[图]", text)
    text = WS.sub(" ", text).strip()
    if not text:
        text = f"[{msg.get('msg_type') or 'message'}]"
    return text


def age_minutes(msg: dict) -> float:
    """消息距今多少分钟。create_time 形如 "2026-11-19 21:18"。"""
    raw = msg.get("create_time") or ""
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            when = datetime.strptime(raw, fmt)
        except ValueError:
            continue
        return (datetime.now() - when).total_seconds() / 60.0
    return float("inf")


def is_direct_at(msg: dict, me: str) -> bool:
    """mentions 里有我的 open_id = 点名叫我；没有 = @all 捎上的。"""
    for m in (msg.get("mentions") or []):
        if isinstance(m, dict) and m.get("id") == me:
            return True
    return False


def classify(msg: dict, me: str) -> str:
    text = plain_text(msg)
    sender = msg.get("sender") or {}
    is_bot = (sender.get("sender_type") or "").lower() == "bot"
    direct = is_direct_at(msg, me)
    p2p = (msg.get("chat_type") or "") == "p2p"
    urgent_word = any(w in text for w in URGENT_WORDS)

    # 急：点名叫我（或私聊）又带紧急词；机器人告警带紧急词也算
    if urgent_word and (direct or p2p or is_bot):
        return "urgent"
    if is_bot:
        return "bot"
    # 待回：私聊，或群里点名叫我
    if p2p or direct:
        return "reply"
    # 知会：@all 广播捎上的
    return "notice"


def sender_name(msg: dict) -> str:
    sender = msg.get("sender") or {}
    return str(sender.get("name") or sender.get("id") or "?")


CJK_IN_PARENS = re.compile(r"[(（]\s*([^)）]*[一-鿿][^)）]*)\s*[)）]")


def short_name(name: str) -> str:
    """「yifan li (李一帆)」→「李一帆」。中文名比拼音短也好认。"""
    hit = CJK_IN_PARENS.search(name)
    return (hit.group(1) if hit else name).strip()


def disp_width(text: str) -> int:
    return sum(2 if ord(ch) > 0x2E80 else 1 for ch in text)


def clip(text: str, width: int) -> str:
    """按显示宽度截断（CJK 算 2 格）。"""
    out, used = [], 0
    for ch in text:
        w = 2 if ord(ch) > 0x2E80 else 1
        if used + w > width:
            return "".join(out).rstrip() + "…"
        out.append(ch)
        used += w
    return "".join(out)


def link_for(msg: dict) -> str:
    """给出一条能被飞书客户端正确路由的链接。

    飞书对线程消息给的是 thread/open，位置是 thread_position=-1（等于没有），
    客户端从不按它定位。但 API 另外知道这条消息在**会话**里的位置
    message_position —— 用会话链接带 position，至少能滚到那条消息所在处。
    """
    href = msg.get("message_app_link") or ""
    pos = msg.get("message_position")
    if href and "/client/thread/open" in href and msg.get("chat_id") and pos not in (None, ""):
        return (f"https://applink.feishu.cn/client/chat/open"
                f"?openChatId={msg['chat_id']}&position={pos}")
    if href and pos not in (None, "") and "position=" not in href:
        href += ("&" if "?" in href else "?") + "position=" + str(pos)
    return href


TAG_PRIORITY = {"决": 0, "回": 1, "知": 2}


def group_by_chat(entries: list[tuple[str, dict, str]], text_limit: int) -> list[dict]:
    """同一个会话只占一行。

    一个人连发五条，面板上就该是一行「张鹏 …(共5条)」，而不是五行把他自己
    刷屏。代表行取这个会话里最重要的一条（决 > 回 > 知），同样重要则取更早的。
    """
    groups: dict[str, dict] = {}
    order: list[str] = []
    for tag, msg, summary in entries:
        chat_id = msg.get("chat_id") or msg.get("message_id") or ""
        when = msg.get("create_time") or ""
        if chat_id not in groups:
            groups[chat_id] = {"tag": tag, "msg": msg, "summary": summary, "ids": [],
                               "latest": when}
            order.append(chat_id)
        group = groups[chat_id]
        # 会话的时间用**最后一条**：面板按时间排的是「这个会话最近有动静」，
        # 不是代表行这条刚好什么时候发的。
        if when > group["latest"]:
            group["latest"] = when
        group["ids"].append(msg.get("message_id") or "")
        if TAG_PRIORITY.get(tag, 9) < TAG_PRIORITY.get(group["tag"], 9):
            group["tag"], group["msg"], group["summary"] = tag, msg, summary

    out = []
    for chat_id in order:
        group = groups[chat_id]
        item = make_item(group["tag"], group["msg"], text_limit, group["summary"])
        item["count"] = len(group["ids"])
        item["messageIds"] = group["ids"]
        item["createTime"] = group["latest"]
        out.append(item)
    return out


def make_item(tag: str, msg: dict, text_limit: int, summary: str = "") -> dict:
    """一条列表行。桌宠按 tag / who / where / text / href 渲染，脚本不再拼接。

    text 优先用模型给的一句话总结；没有模型时退回原文截断。
    href 是飞书 API 自己给的 message_app_link，点这一行就能跳过去。
    """
    return {
        "tag": tag,
        "who": short_name(sender_name(msg)),
        "where": "" if msg.get("chat_type") == "p2p" else (msg.get("chat_name") or "群"),
        "text": summary or clip(plain_text(msg), text_limit),
        "href": link_for(msg),
        # 面板要按时间段（今天 / 昨天 / 更早）排，用它分桶；缺省时面板退化成
        # 「更早」而不报错。
        "createTime": msg.get("create_time") or "",
        # 面板上「让 agent 跟进」要用它去拉这条会话的上下文
        "chatId": msg.get("chat_id") or "",
        "messageId": msg.get("message_id") or "",
        # 只在 --include-read 时有意义：True=已读，False=未读，缺省=未知
        "read": msg.get("_read"),
    }


def build_card(groups: dict[str, list[dict]], max_lines: int, text_limit: int,
               newest_first: bool = False):
    """返回 (title, note, level, items)。行数据交给桌宠画。

    newest_first 给浏览视图用：那是「谁最近找过我」的清单，新的在上；推给桌宠
    的提醒卡片保持早的在上，因为它是一条先到先处理的队列。
    """
    total = sum(len(v) for v in groups.values())
    counts = [f"{BUCKET_CN[b]} {len(groups[b])}" for b in BUCKETS if groups[b]]
    title = f"飞书 @你：{total} 条未读（{' · '.join(counts)}）"

    # create_time 是 "YYYY-MM-DD HH:MM"，字典序就是时间序。
    flat = [(BUCKET_TAG[b], m) for b in BUCKETS for m in groups[b]]
    flat.sort(key=lambda pair: pair[1].get("create_time") or "", reverse=newest_first)
    entries = [(tag, msg, "") for tag, msg in flat]
    grouped = group_by_chat(entries, text_limit)
    items = grouped[:max_lines]
    note = f"…另有 {len(grouped) - len(items)} 个会话" if len(grouped) > len(items) else ""

    level = "error" if groups["urgent"] else ("warn" if groups["reply"] else "info")
    return title, note, level, items, len(grouped)

def push(title: str, body: str, level: str, ttl: int, items: list[dict] | None = None) -> int:
    if not PUSH_NOTICE.exists():
        print(f"[warn] 找不到 push-notice.py: {PUSH_NOTICE}", file=sys.stderr)
        return 1
    cmd = [
        sys.executable, str(PUSH_NOTICE), title, body,
        "--level", level,
        "--key", PUSH_KEY,
        "--presentation", "card",
        # 这是一份待办清单，不是一条一闪而过的告警：点一下不该把内容弄丢。
        "--sticky",
        "--ttl-seconds", str(ttl),
    ]
    if items:
        cmd.extend(["--items-json", json.dumps(items, ensure_ascii=False)])
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=30, stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"[warn] 推送没跑起来: {exc}", file=sys.stderr)
        return 1
    if proc.returncode != 0:
        # 桌宠没开是常态，不是错误
        print(f"[info] 桌宠没收下（退出码 {proc.returncode}）：{(proc.stderr or '').strip()[:200]}",
              file=sys.stderr)
    return proc.returncode


def ttl_for(groups: dict[str, list[dict]], override: int | None) -> int:
    if override is not None:
        return override
    if groups["urgent"]:
        return 1800
    if groups["reply"]:
        return 900
    return 300


# ── 语义归类（可选，需要网关 token）──────────────────────────────────────────
# 规则分档只看「谁 @ 了谁」，分不出轻重。这里让模型把每条判成
# 需决定 / 需回复 / 知会 / 噪音。它只在有未读时才调用，失败就退回规则档位，
# 绝不让归类拖垮整轮。

AGENT_KINDS = ("decide", "reply", "fyi", "noise")
KIND_ORDER = ("decide", "reply", "fyi")
KIND_TAG = {"decide": "决", "reply": "回", "fyi": "知", "noise": "噪"}
KIND_CN = {"decide": "需决定", "reply": "需回复", "fyi": "知会", "noise": "噪音"}
DEFAULT_AGENT_MODEL = "claude-auto[1M]"
AGENT_TIMEOUT = 60
AGENT_MAX_MESSAGES = 20
AGENT_TEXT_LIMIT = 180

AGENT_SYSTEM = (
    "你是飞书助理，给「@我但未读」的消息分类。只输出 JSON，不要解释、不要代码块。\n"
    "分类：reply=需要我回话或处理；decide=需要我做决定/确认/审批；"
    "fyi=只是通知，知道即可；noise=群发/转发/与我无关。\n"
    '格式：{"items":[{"i":1,"kind":"reply","why":"12字内理由",'
    '"sum":"20字内，这条消息讲了什么"}]}\n'
    "每条消息都必须出现在输出里，i 用它给的编号。sum 是给人扫一眼的内容总结，"
    "不要复述原文，也不要评价。"
)


def agent_credentials() -> tuple[str, str]:
    base = (os.environ.get("ANTHROPIC_BASE_URL") or "").rstrip("/")
    token = (os.environ.get("ANTHROPIC_AUTH_TOKEN")
             or os.environ.get("ANTHROPIC_API_KEY") or "")
    return base, token


def parse_agent_reply(text: str, count: int) -> dict[int, dict] | None:
    """把模型输出解析成 {i: {kind, why}}。认不出来返回 None（调用方退回规则）。"""
    if not text:
        return None
    body = text.strip()
    if body.startswith("```"):
        body = body.split("\n", 1)[-1]
        body = body.rsplit("```", 1)[0]
    start, end = body.find("{"), body.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(body[start:end + 1])
    except json.JSONDecodeError:
        return None
    items = data.get("items") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return None
    out: dict[int, dict] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            idx = int(item.get("i"))
        except (TypeError, ValueError):
            continue
        if not 1 <= idx <= count:
            continue
        kind = str(item.get("kind") or "").strip().lower()
        if kind not in AGENT_KINDS:
            continue
        out[idx] = {
            "kind": kind,
            "why": str(item.get("why") or "").strip()[:40],
            "sum": str(item.get("sum") or "").strip()[:60],
        }
    return out or None


def load_summary_cache(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    cutoff = time.time() - SUMMARY_CACHE_TTL_S
    return {k: v for k, v in data.items()
            if isinstance(v, dict) and isinstance(v.get("at"), (int, float)) and v["at"] > cutoff}


def save_summary_cache(path: Path, cache: dict) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)
    except OSError:
        pass


def classify_with_agent(messages: list[dict], model: str, timeout: int,
                       cache_path: Path | None = None) -> dict[int, dict] | None:
    """给每条消息定级 + 一句话总结。

    结果按 message_id 存一份缓存：同一条消息再出现时直接用，不再问模型 ——
    这是让重复点击变快的主要来源。
    """
    cache = load_summary_cache(cache_path) if cache_path else {}
    known = {}
    for idx, msg in enumerate(messages, start=1):
        hit = cache.get(msg.get("message_id") or "")
        if hit:
            known[idx] = {"kind": hit.get("kind", "fyi"), "why": hit.get("why", ""),
                          "sum": hit.get("sum", "")}

    todo = [m for i, m in enumerate(messages, start=1) if i not in known]
    if not todo:
        print(f"[info] 语义归类全部命中缓存（{len(known)} 条）", file=sys.stderr)
        return known

    """调网关给每条消息定级。任何失败都返回 None，由调用方退回规则档位。"""
    base, token = agent_credentials()
    if not base or not token:
        print("[info] 没有 ANTHROPIC_BASE_URL/AUTH_TOKEN，跳过语义归类", file=sys.stderr)
        return None

    # 只问缓存里没有的；下标用它在整张列表里的位置，回填时才对得上。
    todo_pairs = [(i, m) for i, m in enumerate(messages, start=1) if i not in known]
    todo_pairs = todo_pairs[:AGENT_MAX_MESSAGES]
    payload = [{
        "i": i,
        "chat": m.get("chat_name") or ("私聊" if m.get("chat_type") == "p2p" else "群"),
        "from": short_name(sender_name(m)),
        "time": m.get("create_time"),
        "text": plain_text(m)[:AGENT_TEXT_LIMIT],
    } for i, (_global, m) in enumerate(todo_pairs, start=1)]

    body = json.dumps({
        "model": model,
        "max_tokens": 2000,
        "system": AGENT_SYSTEM,
        "messages": [{"role": "user", "content": json.dumps(payload, ensure_ascii=False)}],
    }).encode("utf-8")

    req = urllib.request.Request(
        base + "/v1/messages", data=body, method="POST",
        headers={
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            "authorization": f"Bearer {token}",
            "x-api-key": token,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
        print(f"[warn] 语义归类失败，退回规则档位: {exc}", file=sys.stderr)
        return None

    text = "".join(
        part.get("text", "") for part in (data.get("content") or [])
        if isinstance(part, dict) and part.get("type") == "text"
    )
    parsed = parse_agent_reply(text, len(todo_pairs))
    if parsed is None:
        print(f"[warn] 语义归类输出解析不了，退回规则档位；原始输出: {text[:200]!r}",
              file=sys.stderr)
        return None

    # 把批次内的下标翻译回整张列表的下标，并写进缓存。
    merged = dict(known)
    for local_idx, verdict in parsed.items():
        global_idx, msg = todo_pairs[local_idx - 1]
        merged[global_idx] = verdict
        mid = msg.get("message_id")
        if mid and cache_path:
            cache[mid] = {**verdict, "at": time.time()}
    if cache_path:
        save_summary_cache(cache_path, cache)

    usage = data.get("usage") or {}
    print(f"[info] 语义归类 {len(parsed)}/{len(todo_pairs)} 条新问、"
          f"{len(known)} 条命中缓存（{model}，"
          f"in {usage.get('input_tokens', '?')} / out {usage.get('output_tokens', '?')}）",
          file=sys.stderr)
    return merged


def build_agent_card(messages, verdicts, max_lines, text_limit):
    """按语义档位排。噪音不进列表。返回 (title, note, level, ttl, items)。"""
    ranked = []
    for idx, msg in enumerate(messages, start=1):
        verdict = verdicts.get(idx)
        kind = verdict["kind"] if verdict else "fyi"
        if kind == "noise":
            continue
        ranked.append((kind, msg, verdict or {}))

    # 按重要性排，不按时间：模型判定的「需决定 / 需回复」比先来后到更值得
    # 占住面板的前几行。
    order = {k: i for i, k in enumerate(KIND_ORDER)}
    ranked.sort(key=lambda row: order.get(row[0], len(KIND_ORDER)))
    entries = [(KIND_TAG[kind], msg, (verdict or {}).get("sum", ""))
               for kind, msg, verdict in ranked]
    grouped = group_by_chat(entries, text_limit)
    items = grouped[:max_lines]
    note = f"…另有 {len(grouped) - len(items)} 个会话" if len(grouped) > len(items) else ""

    noise_count = sum(1 for v in verdicts.values() if v["kind"] == "noise")
    counts = [f"{KIND_CN[k]} {sum(1 for x, _, _ in ranked if x == k)}"
              for k in KIND_ORDER if any(x == k for x, _, _ in ranked)]

    if not ranked:
        return (f"飞书 @你：{noise_count} 条，都不需要你处理",
                "全是通知或群发。", "info", 200, [])

    title = f"飞书 @你：{len(ranked)} 条（{' · '.join(counts)}）"

    level = "warn" if any(k in ("decide", "reply") for k, _, _ in ranked) else "info"
    ttl = 1800 if any(k == "decide" for k, _, _ in ranked) else (
        900 if any(k == "reply" for k, _, _ in ranked) else 300)
    return title, note, level, ttl, items, len(grouped)

def render_context(chat_id: str, limit: int) -> str:
    """把某个会话最近若干条渲染成 markdown，给 follow-up 的 agent 读。"""
    data = run_lark([
        "im", "+chat-messages-list",
        "--chat-id", chat_id,
        "--page-size", str(limit),
        "--order", "desc",
        "--as", "user",
    ])
    envelope = data.get("data") or {}
    msgs = list(envelope.get("items") or envelope.get("messages") or [])
    msgs.reverse()  # 旧的在前，读起来才顺
    lines = []
    for m in msgs:
        who = short_name(sender_name(m))
        text = plain_text(m)[:300]
        lines.append(f"- {m.get('create_time') or ''} {who}: {text}")
    return chr(10).join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="拉飞书 @我 的未读消息，分类后推给桌宠。",
        epilog="退出码：0 有未读并已处理 / 3 没有新的未读 / 1 拉取失败 / 2 参数错",
    )
    ap.add_argument("--lookback-minutes", type=int, default=120,
                    help="往前搜多久（默认 120，比半小时的轮询间隔宽，容忍漏跑）")
    ap.add_argument("--page-limit", type=int, default=3, help="搜索最多翻几页（默认 3）")
    ap.add_argument("--max-items", type=int, default=60,
                    help="最多返回几行（默认 60）。面板只画前 8 行，其余用于"
                         "「忽略/处理一条后立刻补位」，不必等下一轮")
    ap.add_argument("--text-limit", type=int, default=60,
                    help="每行消息正文最多几个显示宽度（默认 60）")
    ap.add_argument("--max-lines", type=int, default=None, help=argparse.SUPPRESS)
    ap.add_argument("--line-width", type=int, default=None, help=argparse.SUPPRESS)
    ap.add_argument("--ttl-seconds", type=int, default=None, help="覆盖按档位自动选的 TTL")
    ap.add_argument("--exclude-chat", action="append", default=[], metavar="NAME",
                    help="跳过群名包含该子串的消息，可重复")
    ap.add_argument("--allow-all-in", action="append", default=[], metavar="NAME",
                    help="这些群里的 @all 广播也保留（群名包含该子串即可），可重复")
    ap.add_argument("--keep-all-mentions", action="store_true",
                    help="保留所有 @all 广播（默认全部丢弃）")
    ap.add_argument("--agent", dest="agent", action="store_true", default=None,
                    help="用模型做语义归类（需 ANTHROPIC_BASE_URL/AUTH_TOKEN）")
    ap.add_argument("--no-agent", dest="agent", action="store_false",
                    help="强制只用规则档位")
    ap.add_argument("--agent-model", default=None,
                    help=f"归类用的模型（默认 {DEFAULT_AGENT_MODEL}）")
    ap.add_argument("--agent-timeout", type=int, default=AGENT_TIMEOUT,
                    help=f"归类请求超时秒数（默认 {AGENT_TIMEOUT}）")
    ap.add_argument("--config", type=Path,
                    default=Path(os.environ.get("FEISHU_ATME_CONFIG") or DEFAULT_CONFIG),
                    help=f"配置文件（默认 {DEFAULT_CONFIG}）")
    ap.add_argument("--only", choices=BUCKETS, action="append", default=[],
                    help="只保留这些档位，可重复")
    ap.add_argument("--state", type=Path, default=Path(os.environ.get("FEISHU_ATME_STATE") or DEFAULT_STATE),
                    help=f"去重状态文件（默认 {DEFAULT_STATE}）")
    ap.add_argument("--include-read", action="store_true",
                    help="连已读的也算（调试用；正常轮询别开）")
    ap.add_argument("--no-dedupe", action="store_true", help="不查状态文件，推过的也再推")
    ap.add_argument("--no-push", action="store_true", help="只打印，不推桌宠，也不写状态")
    ap.add_argument("--json", action="store_true", help="把分好类的结果按 JSON 打到 stdout")
    ap.add_argument("--board", action="store_true",
                    help="完整视图：7 天内所有 @我/@all，已读未读都返回（不受白名单和"
                         "24 小时提醒规则限制）")
    ap.add_argument("--context", metavar="CHAT_ID",
                    help="只输出该会话最近的消息（markdown），供「让 agent 跟进」使用")
    ap.add_argument("--context-limit", type=int, default=40, help="上下文最多几条（默认 40）")
    args = ap.parse_args()

    force_utf8_stdio()

    if args.context:
        # 「让 agent 跟进」用：只吐出这个会话的最近记录，不做分类、不推任何东西。
        try:
            print(render_context(args.context, args.context_limit))
        except (LarkError, subprocess.TimeoutExpired) as exc:
            print(f"[error] 拉取会话上下文失败: {exc}", file=sys.stderr)
            return 1
        return 0

    # 配置要在搜索之前就位：私聊是否含机器人等开关会影响这一轮拉什么。
    config = load_config(args.config)

    # 拉取规则的窗口和条数都走配置，改完下一轮就生效，不用重启宠物。
    try:
        mention_window = int(config.get("mentionWindowMinutes") or MENTION_WINDOW_MINUTES)
        allow_window = int(config.get("allowWindowMinutes") or ALLOW_WINDOW_MINUTES)
        direct_window = int(config.get("directWindowMinutes") or DIRECT_WINDOW_MINUTES)
        max_items = int(config.get("maxItems") or args.max_items)
    except (TypeError, ValueError):
        mention_window, allow_window, direct_window = (
            MENTION_WINDOW_MINUTES, ALLOW_WINDOW_MINUTES, DIRECT_WINDOW_MINUTES)
        max_items = args.max_items

    try:
        me = my_open_id()
        # 两个搜索互不依赖，并行跑：串行时私聊那一路要翻好几页，白白多等一倍。
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=2) as pool:
            at_future = pool.submit(search_at_me, max(mention_window, allow_window), args.page_limit)
            dm_future = pool.submit(
                # 私聊多翻一页要 2 秒，而绝大多数是即将被丢弃的机器人消息，
                # 翻两页就够覆盖真人的活跃私聊。
                search_direct, direct_window, min(2, args.page_limit), me,
                bool(config.get("includeBotDm")),
            )
            messages, truncated = at_future.result()
            direct, dm_truncated = dm_future.result()
        truncated = truncated or dm_truncated
        seen = set()
        merged = []
        for msg in messages + direct:
            mid = msg.get("message_id")
            if mid and mid in seen:
                continue
            if mid:
                seen.add(mid)
            merged.append(msg)
        messages = merged
    except LarkError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1
    except subprocess.TimeoutExpired:
        print("[error] lark-cli 超时", file=sys.stderr)
        return 1

    # 撤回的不算
    messages = [m for m in messages if not m.get("deleted") and m.get("message_id")]

    config = load_config(args.config)
    exclude_chat = clean_patterns(args.exclude_chat or config_list(config, "excludeChat"))
    allow_all_in = clean_patterns(args.allow_all_in or config_list(config, "allowAllIn"))

    for pat in exclude_chat:
        messages = [m for m in messages if pat not in (m.get("chat_name") or "")]

    # 三个来源三个窗口，外加 @all 的取舍。这一步放在读状态查询之前，省掉一大半
    # 没必要的接口调用。
    def keep_message(msg: dict) -> tuple[bool, str]:
        age = age_minutes(msg)
        if args.board:
            # 浏览视图：提醒用的白名单/24 小时规则在这里不适用
            return age <= allow_window, "超窗"
        if (msg.get("chat_type") or "") == "p2p":
            # 私聊：只要能拿到的未读，不设时间上限
            return age <= direct_window, "私聊超窗"
        if is_direct_at(msg, me):
            # 直接@我：24 小时
            return age <= mention_window, "直接@超窗"
        # @all 广播：只在白名单群保留，且最多 7 天
        if args.keep_all_mentions:
            return age <= mention_window, "@all超窗"
        if not keep_broadcast(msg, allow_all_in):
            return False, "@all非白名单"
        return age <= allow_window, "白名单超窗"

    filtered = []
    reasons: dict[str, int] = {}
    for msg in messages:
        keep, why = keep_message(msg)
        if keep:
            filtered.append(msg)
        else:
            reasons[why] = reasons.get(why, 0) + 1
    kept_broadcast = sum(1 for m in filtered if is_broadcast(m, me))
    messages = filtered
    if reasons:
        detail = "、".join(f"{k} {v}" for k, v in reasons.items())
        print(f"[info] 丢弃 {sum(reasons.values())} 条（{detail}）；"
              f"保留 @all {kept_broadcast} 条", file=sys.stderr)

    # --include-read 时也要查一次读状态：完整视图要把已读和未读分开显示，
    # 而不是把两者都当成一条普通的行。
    if args.board:
        args.include_read = True

    if messages and args.include_read:
        try:
            unread_set, _unres = unread_ids([m["message_id"] for m in messages])
            for msg in messages:
                msg["_read"] = msg["message_id"] not in unread_set
        except (LarkError, subprocess.TimeoutExpired):
            pass  # 查不出来就不标记，当作未知

    if messages and not args.include_read:
        try:
            keep, unresolved = unread_ids([m["message_id"] for m in messages])
        except (LarkError, subprocess.TimeoutExpired) as exc:
            print(f"[error] 查已读状态失败: {exc}", file=sys.stderr)
            return 1
        # 查不出状态的按未读处理：多显示一条好过悄悄吞掉一条。
        keep |= unresolved
        if unresolved:
            print(f"[warn] {len(unresolved)} 条读状态查不出，按未读处理", file=sys.stderr)
        messages = [m for m in messages if m["message_id"] in keep]

    state = {"pushed": {}} if args.no_dedupe else load_state(args.state)
    if not args.no_dedupe:
        messages = [m for m in messages if m["message_id"] not in state["pushed"]]

    groups: dict[str, list[dict]] = {b: [] for b in BUCKETS}
    for msg in messages:
        groups[classify(msg, me)].append(msg)

    if args.only:
        for bucket in BUCKETS:
            if bucket not in args.only:
                groups[bucket] = []

    total = sum(len(v) for v in groups.values())
    flat = [m for b in BUCKETS for m in groups[b]]


    use_agent = args.agent if args.agent is not None else bool(config.get("agent"))
    agent_model = args.agent_model or config.get("agentModel") or DEFAULT_AGENT_MODEL

    title, body, level = ("", "", "info")
    ttl = None
    verdicts = None
    items = []
    conversations = 0
    if total:
        # 语义归类只在真有未读时才发请求；失败就静静退回规则档位。
        if use_agent:
            verdicts = classify_with_agent(
                flat, agent_model, args.agent_timeout, DEFAULT_SUMMARY_CACHE)
        if verdicts:
            title, body, level, agent_ttl, items, conversations = build_agent_card(
                flat, verdicts, max_items, args.text_limit)
            ttl = args.ttl_seconds if args.ttl_seconds is not None else agent_ttl
        else:
            title, body, level, items, conversations = build_card(
                groups, max_items, args.text_limit, newest_first=bool(args.board))
        if truncated:
            # 「没有更多」不能当成「没有」：还有没翻完的页，卡片得说清楚。
            body = (body + chr(10) if body else "") + "…搜索还有未翻完的页"
    if ttl is None:
        ttl = ttl_for(groups, args.ttl_seconds)

    by_id = {}
    if verdicts:
        for idx, msg in enumerate(flat, start=1):
            if idx in verdicts:
                by_id[msg["message_id"]] = verdicts[idx]

    if args.json:
        # --json 是给机器读的：stdout 只能有这一份 JSON。渲染好的卡片也放进来，
        # 调用方（比如桌宠菜单）不用再复刻一遍排版。
        payload = {
            "total": total,
            "truncated": truncated,
            "buckets": {
                b: [{
                    "message_id": m["message_id"],
                    "chat_name": m.get("chat_name"),
                    "chat_type": m.get("chat_type"),
                    "sender": sender_name(m),
                    "create_time": m.get("create_time"),
                    "text": plain_text(m),
                    "link": m.get("message_app_link"),
                    **({"kind": by_id[m["message_id"]]["kind"],
                        "why": by_id[m["message_id"]]["why"]}
                       if m["message_id"] in by_id else {}),
                } for m in groups[b]]
                for b in BUCKETS
            },
        }
        if total:
            payload["card"] = {
                "title": title,
                "body": body,
                "level": level,
                "ttl": ttl,
                "sticky": True,
                "items": items,
                "conversations": conversations,
            }
        print(json.dumps(payload, ensure_ascii=False, indent=2))

    if total == 0:
        if not args.json:
            print("没有新的未读 @，不推。")
        return 3

    if args.no_push:
        if not args.json:
            print(f"[dry-run] level={level} ttl={ttl}")
            print(title)
            for it in items:
                where = f"{it['who']}@{it['where']}" if it["where"] else it["who"]
                print(f"  [{it['tag']}] {where}: {it['text']}")
            if body:
                print(body)
        return 0

    push_rejected = push(title, body, level, ttl, items) != 0

    if push_rejected:
        # 桌宠没开是常态，不是错误，所以我们照样安静退出——但绝不能把这些消息
        # 记成「推过了」。否则它们会被静音到离开搜索窗口为止，而用户从没看见。
        if not args.json:
            print("桌宠没收下，本轮不记去重（下次还会再推）", file=sys.stderr)
        return 0

    if not args.no_dedupe:
        now = time.time()
        for bucket in BUCKETS:
            for msg in groups[bucket]:
                state["pushed"][msg["message_id"]] = now
        save_state(args.state, state)

    if not args.json:
        if verdicts:
            # 卡片按语义档位排的，汇总行也得按语义报，不然和卡面对不上
            kinds = [v["kind"] for v in verdicts.values()]
            counts = " ".join(f"{KIND_CN[k]}={kinds.count(k)}" for k in AGENT_KINDS if kinds.count(k))
        else:
            counts = " ".join(f"{BUCKET_CN[b]}={len(groups[b])}" for b in BUCKETS if groups[b])
        print(f"推了 {total} 条：{counts}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
