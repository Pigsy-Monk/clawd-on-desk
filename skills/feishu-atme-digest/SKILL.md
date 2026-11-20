---
name: feishu-atme-digest
description: 拉飞书 @我 的未读消息，按「急 / 待回 / 知会 / 机器人」分类，推一张卡片给 Clawd 桌宠。当用户说「看看飞书有没有 @ 我 / 有没有人找我 / 飞书未读 / @我的消息分下类 / 盯着飞书」时使用，也适合挂成定时任务每半小时跑一轮。查完一轮想顺手处理（回消息、看原文）时接 lark-im。
metadata:
  requires:
    bins: ["lark-cli", "python"]
---

# 飞书 @我 未读摘要

> 位置：随仓库分发（`skills/feishu-atme-digest/`）。桌宠优先用这份；找不到时退回
> `~/.agents/skills/feishu-atme-digest/` 那份个人副本。下面的命令路径按仓库内写法。

一条命令把「谁在飞书上找我、哪条要紧」收敛成桌宠上的一张卡片。

```bash
python skills/feishu-atme-digest/scripts/feishu-atme-digest.py
```

默认搜最近 120 分钟、只留**服务端认定未读**的、去掉**推过的**，分完类推一张卡。**没有新的未读就什么都不推**（退出码 3）——半小时一轮的轮询，安静是对的。

## 它做了什么

```
lark-cli im +messages-search --is-at-me   →  @我 + @all 的消息
lark-cli im +messages-read-status         →  扔掉我已经读过的
@all 过滤 + state.json 去重                →  只留真正找我的、且这一轮新的
语义归类（可选，agent:true）               →  需决定 / 需回复 / 知会 / 噪音
push-notice.py --key feishu-atme          →  一张卡，原地替换不叠
```

## 拉取规则走配置（改完不用重启）

`~/.feishu-atme/config.json` **每次运行都会重读**，改完下一轮轮询就生效，不需要重启桌宠：

```json
{
  "allowAllIn": ["CSE"],
  "excludeChat": [],
  "agent": true,
  "agentModel": "claude-auto[1M]",
  "followUpWorktree": "D:/JavaProjects/flt-engine-skills",

  "mentionWindowMinutes": 1440,
  "allowWindowMinutes": 10080,
  "directWindowMinutes": 43200,
  "includeBotDm": false,
  "maxItems": 60
}
```

| 键 | 含义 | 默认 |
|---|---|---|
| `mentionWindowMinutes` | 直接@我 / 其他群的时间窗（分钟） | 1440（24h） |
| `allowWindowMinutes` | 白名单群的 @all 时间窗 | 10080（7 天） |
| `directWindowMinutes` | 私聊时间窗 | 43200（30 天） |
| `includeBotDm` | 是否收应用/机器人私聊 | false |
| `maxItems` | 一次最多返回几行（面板只画 8 行，其余用于补位） | 60 |

命令行同名参数会覆盖配置；不带参数时以配置为准。

## 三个来源，三个时间窗

| 来源 | 时间窗 | 说明 |
|---|---|---|
| **私聊** | 全部未读（搜 30 天） | 服务端用 `--sender-type user` 只取真人，机器人/应用私聊不再占页数 |
| **白名单群**（`allowAllIn`）的 @all | **7 天** | 你点名的群放宽到一周 |
| **其他群** | **24 小时** | 直接@ 你、以及非白名单的 @all，只看最近一天 |

窗口在搜索阶段取最大值（@我搜 7 天、私聊搜 30 天），再按来源逐条裁剪，裁剪发生在查已读之前，省掉不必要的接口调用。丢弃数量会打一行日志，例如：

```
[info] 丢弃 23 条（@all非白名单 18、直接@超窗 5）；保留 @all 0 条
```

## 私聊也算

`--is-at-me` 只返回**带 @ 的消息**，而私聊根本不会 @ 你 —— 所以私聊要单独搜一遍：
不带关键词、只限定 `chat_type=p2p` 加时间窗，再把「我自己发的」剔掉。两条来源
按 `message_id` 合并去重。

**应用/机器人私聊默认不收。** 实测 24 小时内 147 条私聊里 140+ 是告警中心、Gitlab、
Captain 这类应用发的流水，真人私聊会被直接淹掉。要收的话：

```json
{ "includeBotDm": true }
```

## @all 默认不要

`--is-at-me` 搜索只会返回两种消息：**@我** 和 **@all**。所以凡是不直接@我的，就都是 `@all` 广播——对一个每天被全体通知轰炸的人来说，这几乎全是噪音。

**默认全部丢弃。** 只有群名命中白名单的群，才把它的 `@all` 放回来：

```bash
... --allow-all-in "NOC" --allow-all-in "RCA"
```

不想维护命令行的，写进配置文件（`~/.feishu-atme/config.json`，`FEISHU_ATME_CONFIG` 可改路径）：

```json
{
  "allowAllIn": ["NOC", "RCA"],
  "excludeChat": ["某刷屏群"]
}
```

群名只需**包含**该子串即算命中；空串会被丢掉（`"" in 群名` 恒真，会把白名单变成「全部」）。要临时看全量：`--keep-all-mentions`。

## 四个档位怎么分

判据是 `mentions` 里**有没有我的 open_id**（点名叫我)、是不是私聊、发的人是不是机器人、正文**有没有紧急词**。

| 档 | 卡上标记 | 规则 |
|---|---|---|
| **急** | `[急]` | 点名叫我 / 私聊 / 机器人告警，**且**正文命中紧急词（线上、故障、P0、回滚、超时、告警、尽快……） |
| **待回** | `[回]` | 私聊，或群里**点名叫我**——等着我回话的 |
| **知会** | `[知]` | `@all` 广播捎上的（只有白名单群才可能出现） |
| **机器人** | `[器]` | 机器人发的、没直接@我的通知（同样只在白名单群出现） |

不配白名单时，卡片里基本只会出现「急」和「待回」——那才是真的有人找你。

卡片左侧色条跟着最高档位走：有急 → `error`，有待回 → `warn`，否则 `info`。TTL 同理：急 30 分钟、待回 15 分钟、其余 5 分钟。

## 语义归类（可选）

规则只能看出「谁 @ 了谁」，看不出轻重。打开 `agent` 后，模型会把每条判成四类之一：

| 档 | 标记 | 含义 |
|---|---|---|
| **需决定** | `[决]` | 要我做决定 / 确认 / 审批 |
| **需回复** | `[回]` | 要回话或处理 |
| **知会** | `[知]` | 通知，知道就行 |
| **噪音** | — | 群发、转发、与我无关，**不进卡片** |

```json
// ~/.feishu-atme/config.json
{ "agent": true, "agentModel": "claude-auto[1M]" }
```

几条硬约束，都是刻意的：

- **只在真有未读时才调**。没有未读就没有请求，也就不产生任何调用。
- **失败一律退回规则档位**，只打一行 warning。模型抽风、网关不通、输出解析不了，都不影响这一轮出卡。
- **模型只读，不写**。它拿到的只有「群名 / 谁 / 时间 / 前 180 字」，没有链接、没有附件、不写回飞书。
- **一次最多 40 条**，超出的按规则档位留在卡片尾部。

**成本**（实测，2026-11-19）：6–8 条消息约 **1.1k 输入 / 0.5k 输出 token,2.5 秒**。用的是网关的 `claude-auto[1M]`（标价 free）。按半小时一轮、一天 48 轮算，也就 5 万 token 量级——和跑一次 Claude Code 会话差的不是一个数量级（后者光系统提示就 2 万 token）。

它走的是 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`，和 Claude Code 用的是同一套网关凭据。没配这两个变量时自动跳过归类，不报错。

`--agent` / `--no-agent` 可以临时覆盖配置文件；`--agent-model NAME` 换模型。


## 常用参数

| 参数 | 说明 |
|---|---|
| `--lookback-minutes N` | 往前搜多久，默认 120。**故意比半小时宽**——漏跑一轮也不丢消息，重复的交给去重 |
| `--allow-all-in NAME` | 这些群的 `@all` 保留，群名包含该子串即可，可重复 |
| `--keep-all-mentions` | 保留所有 `@all`（默认全丢） |
| `--agent` / `--no-agent` | 临时开关语义归类（默认跟配置文件） |
| `--agent-model NAME` | 归类用的模型，默认 `claude-auto[1M]` |
| `--config PATH` | 配置文件，默认 `~/.feishu-atme/config.json` |
| `--only BUCKET` | 只要某几档，可重复（`urgent` / `reply` / `notice` / `bot`） |
| `--exclude-chat NAME` | 群名包含该子串就跳过，可重复。屏蔽刷屏群用 |
| `--max-lines N` | 卡片正文最多几行，默认 6；超出显示「…另有 N 条」 |
| `--line-width N` | 每行显示宽度，CJK 算 2 格，默认 46。54 左右更耐看 |
| `--ttl-seconds N` | 覆盖按档位自动选的 TTL |
| `--no-push` | 只打印不推，也不写状态。**调参数先用这个** |
| `--json` | 把分好类的结果打到 stdout（带 `message_app_link`），给 agent 接着处理 |
| `--include-read` | 连已读的也算，只用来调试（正常轮询别开） |
| `--no-dedupe` | 推过的也再推一遍 |
| `--state PATH` | 换去重状态文件，默认 `~/.feishu-atme/state.json`，也认环境变量 `FEISHU_ATME_STATE` |

退出码：`0` 推了 / `3` 没有新的未读 / `1` 拉取失败 / `2` 参数错。**`3` 不是错误**，定时任务里别当失败报警。

## 桌宠菜单里的「飞书 @我」

Clawd 的托盘菜单和宠物右键菜单里各有一个**手动**入口，点一下跑一轮，结果直接出成卡片。**只读、只手动**——没有定时器，不挂在任何生命周期上；要定时仍得自己挂计划任务（见下）。

宠物被隐藏时这一项是灰的：卡片本来就跟宠物一起收起，点了也看不到，灰掉比装作没事更诚实。

菜单走的是 `--json --no-push --no-dedupe`：读的是**当前全部未读**，不碰你的去重状态，所以手点一次不会把定时任务该推的消息吞掉。`--json` 的 stdout 只有一份 JSON，渲染好的卡片在 `card` 字段里（`title` / `body` / `level` / `ttl` 秒）。

## 三个「不准」的边界

它宁可多显示，也不假装干净：

- **读状态查不出来 → 按未读算。** 服务端对查不了的 id 只丢进 `invalid_message_ids`、不给原因，当已读处理会**悄悄吞掉**消息。
- **搜索没翻完 → 卡片会说。** `has_more` 为真时卡片尾行加「…搜索还有未翻完的页」；`--json` 里是 `truncated`。「已翻的页里没有」不等于「收件箱里没有」。
- **推送没被收下 → 不记去重。** 桌宠没开时照样安静退出（不报错），但那批消息不算推过，下一轮还会再来。否则它们会被静音到离开搜索窗口为止，而你从没看见。

`--state` 的写入用带 PID 的临时文件再原子替换；同时跑手动和定时不会互相截断文件，但两边仍可能各自推一次（不是丢消息，是重复）。

## agent 怎么用

用户问「有没有人找我」——直接跑，默认那张卡就是答案。想在对话里**自己读一遍内容**再补一句判断（比如「朱志伟那条问的是渠道开关，你上周说过要开」），加 `--json`：

```bash
python skills/feishu-atme-digest/scripts/feishu-atme-digest.py --json --no-push
```

`--no-push` 让它别抢桌宠那张卡，你拿 JSON 自己说。每条带 `message_app_link`，可以直接给用户点开原文。

规则分类只看关键词，**语义上的轻重它分不出来**。真要判断「这条该不该现在回」，用 `--json` 自己读，别指望档位。

## 挂定时(用户自己决定装不装)

脚本是纯 CLI、0 token，适合交给系统定时器而不是挂在 agent 会话里（挂会话里每次触发都要重发整段上下文）。每半小时一轮：

```powershell
schtasks /create /tn "FeishuAtMeDigest" /sc minute /mo 30 /f `
  /tr "python D:\Users\zwsong\.agents\skills\feishu-atme-digest\bin\feishu-atme-digest.py --line-width 54"
```

查 / 手动触发 / 删：

```powershell
schtasks /query /tn "FeishuAtMeDigest" /v /fo list
schtasks /run   /tn "FeishuAtMeDigest"
schtasks /delete /tn "FeishuAtMeDigest" /f
```

想盯着它有没有正常跑，把输出接到文件：`... > %TEMP%\feishu-atme.log 2>&1`。

## 要知道的几件事

- **只读。** 这个 skill 不发消息、不回消息、不标已读。要回话用 `lark-im`，而且**得用户明确说了要发才发**。
- **「未读」是服务端说的**，不是本地猜的——`+messages-read-status` 按当前登录用户算。所以你在手机上点开过，这边就不会再推。
- **token 会过期。** `lark-cli` 的 user token 7 天刷新窗口，过期后脚本退出码 1、stderr 说明原因。重新授权：`lark-cli auth login`。定时任务静默失败多半是这个。
- **桌宠没开不算错。** 推送失败只在 stderr 留一行，退出码照样是 0 —— 少一张卡而已。但**那批消息不会被记成已推**，下一轮还会再来。
- **输出永远是 UTF-8。** 脚本启动时自己把 stdout/stderr 钉成 UTF-8，不依赖调用方的 `PYTHONIOENCODING`。Windows 上从资源管理器启动的程序没有这些环境变量，Python 默认会用 GBK 写管道，中文会乱码、emoji 直接抛 `UnicodeEncodeError`——这个坑已经在脚本里堵掉了，你从哪调都行。
- **卡片是「粘」的（`sticky`）**：点正文**不会**关掉它——它是一份要读的清单，不是看一眼就清的告警。只有右上角 × 或到期才消失。
- **卡片用固定 key `feishu-atme`**，新一轮会**替换**上一张，不会在桌面上叠一摞。代价是正文行数变化时卡片高度会跟着变；条数多时靠 `--max-lines` 收口。
- 撤回的消息（`deleted`）直接扔掉。

## 自测

分类规则和文本清洗有一组用例，改完规则跑一下：

```bash
python skills/feishu-atme-digest/scripts/test-classify.py
```

不连网络，纯跑 `classify()` / `plain_text()` / `clip()`。
