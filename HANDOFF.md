# HANDOFF — agent-pet

> **快照时间**：2026-10-14（Windows 11，本机）
> **用途**：给在 `D:\JavaProjects\agent-pet` 接手的 agent。无本次对话记忆也能直接开工。
> **读法**：先读「环境」和「已查清的事实」——能省掉一整轮挖源码。

---

## 一句话

fork 了 `clawd-on-desk`（Electron 桌面宠物），要给它加一条能力：
**让 agent 能把内容推给桌宠显示**。clawd 现在只能收「状态」（`POST /state`），
没有任何显示自定义内容的接口——这是本次要补的洞。

---

## 环境（别重新搭）

- 仓库已在 `D:\JavaProjects\agent-pet`（`clawd-on-desk` 的 clone，`--depth 1`，1655 文件 / 104MB）
- 已用 `orca repo add --path` 注册进 Orca（repo id `7f1deafd-cf87-4601-a578-81bbc6c2f885`）
- Node **v24.11.1** / npm **11.6.2**
- **还没跑过 `npm install`**，第一次要拉 Electron（~120MB，国内可能慢）
- 入口文档是 **`AGENTS.md`**（`CLAUDE.md` 只有一行指向它）。**先读它**——
  里面有几十条 Constraints 和 High-Risk Gotchas，绕开惯例会踩雷

---

## 已查清的事实（别重复挖）

- 路由分发在 **`src/server.js:965`** 的 `routeHttpRequest()`，现在四个分支：
  `GET /state` / `POST /state` / `POST /question` / `POST /permission`，其余 404。
  **加一条就是加一个 `else if`**
- 每个 POST 分支都先过 `rejectUnsafeLocalHookRequest(req, res, "<route>")`，新路由沿用
- **模板是 `src/update-bubble.js`（778 行）**：它就是「跟随桌宠的浮动卡片窗」，
  测高、避让 HUD / 权限气泡堆栈、平台相关置顶层级都做好了
  （`WIN_TOPMOST_LEVEL = "pop-up-menu"`，`WIDTH=340` / `EDGE_MARGIN=8` / `GAP=6`）。
  核心是 `initUpdateBubble(ctx)` 和 `computeUpdateBubbleBounds({...})`。新窗口照抄它
- 端口固定 `127.0.0.1:23333-23337`，运行时端口写在 `~/.clawd/runtime.json`；
  sender 必须读它，**不能把 23333 写死**
- custom HTTP agent（`docs/guides/custom-agent-http.md`）v1 **只有 `/state`、
  永远不给 `/permission` 决定**。我们要加的是**一条新路由**，不是复用 custom agent 那套
- clawd 本体的**飞书通道是 approval-only**（只发权限审批卡，明确不做聊天/内容管道）——
  所以「借它发飞书卡片」这条路不通，只能自己加

---

## 要做的（方案已定）

**新增**

| 文件 | 内容 |
|---|---|
| `src/notice-store.js` | 内存存储 + 条数上限 + TTL + 变更事件 |
| `src/server-route-notice.js` | `POST /notice`，收 `{title, body, level, ttl}` |
| `src/notice-bubble.js` | 浮动卡片窗，抄 `update-bubble.js` 的定位/避让 |
| `src/notice-bubble.html` + renderer | 卡片 UI（级别色条 + 标题 + 正文） |

**触点（很小）**

- `src/server.js` — 加一条 `else if (POST /notice)`
- `src/main.js` — 实例化 notice bubble，照 update-bubble 的接法

**agent 侧**：一个 `push.py`，读 `~/.clawd/runtime.json` 拿端口，POST 一条消息

---

## 一个待定（接手先问用户）

卡片**跟不跟随桌宠**：

- **跟随** = 贴着宠物弹、宠物挪它跟着挪、避让 HUD 和权限气泡堆栈
  —— 抄 update-bubble 现成逻辑，更像「宠物在说话」
- **固定角落** = 右下角堆叠，跟宠物解耦，实现更简单

**倾向跟随**（用户要的是「宠物」，不是「告示板」），但先确认。

---

## 坑

- 这仓库规矩极重，别自作主张绕开 `AGENTS.md` 的惯例
  （settings 只能经 `settings-controller.js` 写、hook 注册必须 marker-scoped merge 等）
- `npm test` 有路由 / manifest 契约测试，加了路由可能要补测试
- 透明窗口、置顶、拖拽这些 **Electron 行为只能手动验**（AGENTS.md 明说），别指望单测
- 当前是 Windows-first 开发环境
- 顺带一提：`orca repo add --path <路径>` 是官方支持的加项目方式，不用点 UI

---

## 为什么做这个（背景）

用户想要一只**常驻桌面的宠物**，agent 能把内容推给它显示。

评估过的其他路线，都排除了：

- **clawd 不改，只驱动 `/state`** —— 能让宠物变姿势，但显示不了内容
- **Python + tkinter 自写悬浮板** —— 能做，但只是个「告示板」，没有形象和动画
- **fork clawd**（即本方案）—— 拿到宠物渲染 + 主题 + hooks + 托盘 + 打包，只补内容这一块 ✅

---

## 参考

- 仓库：https://github.com/rullerzhou-afk/clawd-on-desk （AGPL-3.0；个人自用不受影响，分发才触发）
- 本机 Orca CLI：`~/AppData/Local/Programs/orca/resources/bin/orca`
