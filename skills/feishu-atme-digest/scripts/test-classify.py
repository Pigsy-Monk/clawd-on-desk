import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".agents" / "skills" / "feishu-atme-digest" / "bin"))
import importlib.util

spec = importlib.util.spec_from_file_location(
    "digest", Path.home() / ".agents" / "skills" / "feishu-atme-digest" / "bin" / "feishu-atme-digest.py"
)
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)

ME = "ou_me"
OTHER = "ou_other"

cases = [
    ("直接@我+紧急词", {
        "chat_type": "group", "chat_name": "发布群", "content": {"text": "线上回滚了，看一下"},
        "sender": {"name": "张三", "sender_type": "user"},
        "mentions": [{"id": ME, "name": "我"}]}, "urgent"),
    ("私聊+紧急词", {
        "chat_type": "p2p", "content": {"text": "P0 故障，急"},
        "sender": {"name": "李四", "sender_type": "user"}, "mentions": []}, "urgent"),
    ("机器人告警+紧急词", {
        "chat_type": "group", "chat_name": "告警群", "content": {"text": "服务超时告警"},
        "sender": {"name": "Bigeyes", "sender_type": "bot"}, "mentions": []}, "urgent"),
    ("直接@我，无紧急词", {
        "chat_type": "group", "chat_name": "需求群", "content": {"text": "这个方案你看下"},
        "sender": {"name": "王五", "sender_type": "user"},
        "mentions": [{"id": ME, "name": "我"}]}, "reply"),
    ("私聊，无紧急词", {
        "chat_type": "p2p", "content": {"text": "中午吃饭吗"},
        "sender": {"name": "赵六", "sender_type": "user"}, "mentions": []}, "reply"),
    ("@all 广播", {
        "chat_type": "group", "chat_name": "大群", "content": {"text": "大家记得填表"},
        "sender": {"name": "HR", "sender_type": "user"}, "mentions": []}, "notice"),
    ("@别人不是我", {
        "chat_type": "group", "chat_name": "大群", "content": {"text": "你处理下"},
        "sender": {"name": "甲", "sender_type": "user"},
        "mentions": [{"id": OTHER, "name": "他"}]}, "notice"),
    ("机器人日常通知", {
        "chat_type": "group", "chat_name": "构建群", "content": {"text": "构建完成"},
        "sender": {"name": "CI", "sender_type": "bot"}, "mentions": []}, "bot"),
]

fails = 0
for label, msg, want in cases:
    got = d.classify(msg, ME)
    ok = "OK " if got == want else "FAIL"
    if got != want:
        fails += 1
    print(f"{ok} {label}: want={want} got={got}")

print("\n--- plain_text / short_name / clip ---")
print(repr(d.plain_text({"content": {"text": '<at user_id="ou_x">Jason</at> 看下这个'},
                         "mentions": [{"id": "ou_x", "name": "Jason"}]})))
print(repr(d.plain_text({"content": {"text": "@_all 大家好"}, "mentions": None})))
print(repr(d.plain_text({"content": {"text": "![Image](img_v3_abc) 图来了"}, "mentions": None})))
print(repr(d.plain_text({"content": {}, "msg_type": "file", "mentions": None})))
print(repr(d.short_name("yifan li (李一帆)")), repr(d.short_name("Bigeyes")))
print(repr(d.clip("一二三四五六", 6)), d.disp_width("abc中文"))

print("\n--- @all 广播判定 ---")
broadcast_cases = [
    ("@all 广播", {"chat_type": "group", "chat_name": "大群", "mentions": None}, True),
    ("直接@我", {"chat_type": "group", "chat_name": "大群", "mentions": [{"id": ME, "name": "我"}]}, False),
    ("@别人", {"chat_type": "group", "chat_name": "大群", "mentions": [{"id": OTHER, "name": "他"}]}, True),
    ("私聊", {"chat_type": "p2p", "mentions": None}, False),
]
for label, msg, want in broadcast_cases:
    got = d.is_broadcast(msg, ME)
    ok = got == want
    if not ok:
        fails += 1
    print(f"{'OK ' if ok else 'FAIL'} {label}: want={want} got={got}")

print("\n--- 白名单 ---")
allow_cases = [
    ("空白名单", {"chat_name": "NOC群"}, [], False),
    ("命中子串", {"chat_name": "NOC（反馈重大故障）"}, ["NOC"], True),
    ("不命中", {"chat_name": "Shopping长耗时优化"}, ["NOC"], False),
    ("多条命中", {"chat_name": "RCA群"}, ["NOC", "RCA"], True),
    ("空串不命中一切", {"chat_name": "任意群"}, d.clean_patterns([""]), False),
]
for label, msg, pats, want in allow_cases:
    got = d.keep_broadcast(msg, pats)
    ok = got == want
    if not ok:
        fails += 1
    print(f"{'OK ' if ok else 'FAIL'} {label}: want={want} got={got}")

print("\n--- 语义归类输出解析 ---")
parse_cases = [
    ("正常", '{"items":[{"i":1,"kind":"reply","why":"要我回"},{"i":2,"kind":"noise","why":"群发"}]}',
     {1: "reply", 2: "noise"}),
    ("带代码块", '```json\n{"items":[{"i":1,"kind":"decide","why":"确认"}]}\n```', {1: "decide"}),
    ("前置废话", '好的，结果如下：{"items":[{"i":1,"kind":"fyi","why":"通知"}]}', {1: "fyi"}),
    ("越界下标被丢", '{"items":[{"i":9,"kind":"reply","why":"x"},{"i":1,"kind":"fyi","why":"y"}]}',
     {1: "fyi"}),
    ("未知 kind 被丢", '{"items":[{"i":1,"kind":"urgent","why":"x"}]}', None),
    ("坏 JSON", 'not json at all', None),
    ("空", '', None),
]
for label, text, want in parse_cases:
    got = d.parse_agent_reply(text, 2)
    if got is not None:
        got = {k: v["kind"] for k, v in got.items()}
    ok = got == want
    if not ok:
        fails += 1
    print(f"{'OK ' if ok else 'FAIL'} {label}: want={want} got={got}")

print(f"\n{len(cases) + len(broadcast_cases) + len(allow_cases) + len(parse_cases) - fails}"
      f"/{len(cases) + len(broadcast_cases) + len(allow_cases) + len(parse_cases)} passed")
sys.exit(1 if fails else 0)


