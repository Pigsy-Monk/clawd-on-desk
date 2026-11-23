# HANDOFF — agent-pet（2026-10-18 晚）

> 给接手的 agent。先读「必读规矩」，再看「当前状态」。旧版内容已过时，git 历史里还有。

## 必读规矩（每条都踩过坑）

- **全程用简体中文回复用户**。汇报工具结果、子任务报告、提交/MR 结果时最容易漂回英文。
- 用户要做选择时：**先做成可点的 demo 再问**（见记忆 demo-before-choosing）。用户回话很短，通常一两个词。
- 先读 `AGENTS.md`（`CLAUDE.md` 只指向它）。settings 只经 `settings-controller.js` 写；7 种语言 i18n 键顺序必须一致。
- **桌宠窗口截不到图**（透明窗口，GDI 拍不到）。验证视觉只能让用户看，或用无头 Edge 渲染单页 + 假 bridge 截图。
- **改了 HTML/CSS/renderer 要重启桌宠才生效**：读 `~/.clawd/runtime.json` 的 `ownerPid`，`taskkill //T //F //PID <pid>`，再后台 `npm start`，用 `until curl -s --noproxy '*' http://127.0.0.1:23333/state` 等就绪。kill 和 start 不要并行发。
- **推中文通知别用 curl**（MSYS curl 把 argv 按 GBK 发 → 乱码）。用 `python ~/.agents/skills/pet-notice/bin/push-notice.py --level info --key <topic> "标题" "正文" < /dev/null`；**只给标题时必须关 stdin**。同一件事用同一个 `--key`，新卡片替换旧的。
- **有阶段性进展就推桌宠通知**（用户 2026-10-18 明确要求），不要只写在终端里。
- **会变化的卡片必须固定尺寸**：多阶段卡片（跟练、进度）全程窗口大小不变，文字各占固定单行槽位只替换不追加，数字用 `tabular-nums`。用户对卡片跳动非常敏感（见记忆 pet-cards-fixed-size）。
- `npm test` 在干净代码上也有 13–17 个环境性失败（PowerShell、EPERM、DSH、PR-history 审计、满载时 Electron 超时）。判断回归要跑对应文件或对照基线。
- 提交作者必须是 `zwsong@trip.com`（GitLab `member_check`）。提交/推送/开 MR 都要先问。
- glab 调用前 `env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY`。
- **给子任务布置任务时必须写「文件安全」条款**：临时文件只放在它自己新建的目录，只删自己建的文件、写明确路径，**禁止通配符删除**。2026-10-18 一个子任务在 `D:\tmp` 根目录用 `rm *.py *.json *.html …` 删掉了用户多个项目的旧脚本（`rm` 不进回收站，已无法恢复）。见记忆 subagent-no-wildcard-delete。
- 别让子任务用脚本往 JS 里插代码：一个子任务把 `split("\n")` 插成了真换行，桌宠主进程启动即崩。插完必须 `node --check`。
- 用无头浏览器量页面时注意：`file:///` 后面必须是绝对路径（相对路径会静默加载错误页，量出一堆 -1）。

## 仓库与远端

- 本地 `D:\JavaProjects\agent-pet`；`origin` = `git@git.dev.sh.ctripcorp.com:intlengine/clawd-on-desk.git`（project 165599），`upstream` = GitHub 上游。
- `origin/main` = `1bfb3ad`。三个 MR 一条线叠着，**必须按顺序 ff 合并**：
  - **!4** `feat/pet-pose`：豆豆人动作卡片、首张卡片不显示修复、减少动态开关。
  - **!5** `feat/bean-stretch`（`a4b6424`）：拉伸跟练。
  - **!6** `feat/theme-aim`（`896b4fc` 图层转动 + 点击台词池；`e5a546b` 主题自己的举牌 + Calico 猫耳气泡 + 贴边时跳出来举牌）。
- `HANDOFF.md` 一直不提交，留在工作区。
- `git stash@{0}`：被放弃的「桌宠自己从 series 画大图」改动，留作备查。

## 已完成

**A. 拉伸跟练（`feat/bean-stretch`，已提交，桌宠上可试）**
- 用户选定：**邀请制 + 只做 B 组腰背舒展 + 桌宠自己计时**（取代 Windows 计划任务 `Clawd\move`）。
- 新增 `src/stretch-session.js`（动作数据 + 计时引擎）、`stretch-scheduler.js`（间隔、时段、离开 10 分钟）、`stretch-runtime.js`（主进程总控：空闲→举牌→邀请卡→跟练→收尾）。A/C 组数据在但没启用。
- 邀请：左键点黑板出邀请卡（开始 / 10 分钟后 / 今天跳过），右键同样三项，30 秒不理算稍后。跟练中收牌、通知排队且 TTL 暂停；右键宠物菜单加暂停/跳过/结束。
- 试法：设置 → 通用 → 提醒与反馈 → 拉伸跟练提醒 →「现在试一下」，或 `curl -s --noproxy '*' -X POST http://127.0.0.1:23333/stretch/try`。
- **卡片高度实测**（无头 Edge 量真实卡片页）：跟练中全程恒定 398px（倒数、每个动作、换边、暂停、跳过都一样），邀请卡 348px，做完/提前结束 317px。**还差两处缩放没定**：开始 +50px、结束 −81px，用户还没说要不要统一。
- 新增 55 个测试全过。
- **待办**：用户确认没问题后，经 `pet-life` 停掉 `Clawd\move`（现在两边会重复提醒）。

**B. 大虎 / 小绿主题（仓库外，本机自用）**
- 版权：商业 IP，只在本机自用，**素材绝不进仓库或 GitLab**。参考图在 `D:\JavaProjects\agent-pet-theme-refs\armor-corps\`（82 张，来源见 `SOURCES.md`）。
- 已装到 `%APPDATA%\clawd-on-desk\themes\`：`dahu`（大虎，虎式）、`xiaolv`（小绿，T-34）。各四个状态 idle/thinking/working/sleeping，`sleepSequence: direct`，共用 viewBox `0 -30 240 180` 和同一套 layout。
- 当前主题仍是 clawd，用户自己在设置 → 主题里切。
- demo（`%TEMP%\clawd-dahu-idle-demo\`）：`index.html` 四版 idle 草图、`states.html` 四状态、`interact.html` 炮管跟随 A/B + 点击台词、`xiaolv.html`。生成器和验证脚本在 `tools/`，台词在 `quotes/`。
- **用户已定**：大虎画风用 A 版（原作 3/4 视角）；炮管跟随用**方案 A**（炮塔整体转），小绿同样用 A；台词**只在点击时说一句**、只用**气泡样式 ②**（SVG 白色对话气泡）、**只留 18 句原创**（两句标 original 的挪进 `quotes.json` 的 `dropped` 没删，其中 o1 是漫画真对白）。
- 小绿 16 句台词全是原创（一句原作都没找到）。
- 两个主题的 idle SVG 已经预留了转动层（`#aim-turret` / `#aim-pitch` / `#aim-yaw`，含 pivot），等引擎支持后在 `theme.json` 里启用。

**C. 主题自己的举牌 / 贴边举牌（!6，用户确认过）**
- `reactions["notice-screen"].sign` 让主题声明自己的牌子几何和颜色；Calico 的 `calico-notice-screen.svg` 是猫耳气泡（用户在多版 demo 里选的 A）。
- 贴边（mini）时来通知：先 `exitMiniMode()` 跳出来 → 普通举牌 → 牌子和卡片都下去后贴回原边（`src/mini-notice-popout.js`）。**对 Clawd 也生效**。
- 我先误做了一个「贴边抽屉」（从屏幕边缘滑出），用户要的不是这个，已删除。

## 进行中

无。

## 待用户决定 / 待做

1. 拉伸跟练：卡片开始 +50px、结束 −81px 这两处缩放要不要统一。
2. 拉伸跟练试完 → 停掉 `Clawd\move`。
3. 炮管跟随引擎做完后，让主题那个子任务启用 `trackingLayers` 并出 18 句台词的 SVG 气泡。
4. **删除确认 hook 已配好但没生效**：`~/.claude/hooks/confirm-delete.js` + `~/.claude/settings.json` 的 `PreToolUse`（全局，匹配 Bash/PowerShell/JetBrains 终端）。命中 rm/del/Remove-Item/find -delete/git clean/rsync --delete/robocopy /MIR/内联 python·node 删除时返回 `ask`，bypassPermissions 下也会问。**要重启 Claude Code 才加载**，尚未验证。拦不住：删除逻辑写在脚本里再执行、覆盖写入。
5. 大虎/小绿还缺 attention、error、notification、拖拽反应、mini 模式（现在退回 idle，不报错）。
6. 「看到便便就开炮」彩蛋没做。
7. 拉伸跟练的动作文字只有中英两种，繁中显示中文、其余显示英文；设置项和菜单是 7 种语言齐的。
8. 用户早先说「宠物不支持单击了」，没回答具体现象。
9. 二期想法（status/progress、说话人名牌、气泡内按钮回传）未动。

## 仓库外的东西（本机）

- 共享 skill `~/.agents/skills/`：`pet-notice/`（`bin/push-notice.py`、`bin/push-chart.py`）、`pet-pose/`（`bin/push-pose.py`，豆豆人动作卡片）、`pet-life/`（`bin/reminder.py`，数据在 `data/`）。`~/.claude/skills` 和 `~/.hermes/skills` 里是指向它们的 **junction**。
- Windows 计划任务：`Clawd\water`（工作日 9–19 每 45 分）、`Clawd\move`（每 60 分，**待停**）、`Clawd\word1/word2`（每天 10:00/15:00），护眼默认关。用 `pythonw`，允许电池运行，不补发；离开超 10 分钟跳过。
- `D:\Users\zwsong\AppData\Local\Temp\clawd-stretch-impl\`：拉伸实装的截图、CDP 脚本、日志，没删，可对照。我加的 `measure2.js` 能逐阶段量卡片高度。
- 各子任务的临时目录：`clawd-dahu-idle-demo\`（主题）、`clawd-bean-stretch-demo\`（跟练 demo）、`clawd-aim-impl\`（炮管跟随）。

## 记忆文件

`~/.claude/projects/D--JavaProjects-agent-pet/memory/`：中文回复、GDI 截不到宠物、GitLab 与 member_check、测试基线是红的、通知卡片字体栈别改、共享 pet skill 位置、先做 demo 再问、**子任务禁止通配符删除**、**会变化的卡片要固定尺寸**、**用桌宠推进度**。
