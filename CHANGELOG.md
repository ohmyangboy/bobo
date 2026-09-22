---
published: true
---

# 更新日志

本文件记录 bobo 面向用户的版本变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。发布在 [GitHub Releases](https://github.com/ohmyangboy/bobo/releases)。

## [1.3.0-beta.2] - 2026-09-22

### 新增

- 「通知岛 → 内容」新增**默认展示的额度**：折叠刘海收起时显示哪一家的额度可以自己选（默认「自动」= 第一个可用来源）。这个选择与「用量」页点来源是同一个，存在 `~/.bobo/usage.json`，重启后保留。

### 变更

- 「展开并排」下点圆环**只切换这一家的显示范围**（5 小时 / 本周 / 账单月…），不再顺手把折叠胶囊切到那家——胶囊显示哪一家由「默认展示的额度」决定，点圆环不会把它改掉。
- beta 轮次也走应用内更新：带 `-beta.N` 后缀的版本按普通 Release 发布（不再标预发布），安装了 1.2.5 及以后版本的应用会像正式版一样在顶栏提示更新。

## [1.3.0-beta.1] - 2026-09-22

这是额度功能的一轮预览版（beta）：应用内更新会照常提示它——点右上角的版本按钮检查一下，就能看到 `v1.3.0-beta.1` 并下载，下载好后再点一次即重启安装（按钮与确认框里显示的就是带 beta 的版本号；不想上预览版就先别点）。

### 新增

- **额度查看方式**（通知岛 → 内容）：默认「展开并排」——刘海面板展开时把所有订阅的额度圆环并排显示出来，画几枚按屏幕剩余空间自适应（不越过面板中轴线），也可以固定成最多 3 / 5 / 7 家；原来的一枚圆环切换来源保留为「点击切换」。
- **每枚额度圆环可以各自切换显示范围**：在「展开并排」下点某枚圆环，就在这一家的窗口之间循环（5 小时 → 本周 → 账单月 → …），圆环的圆弧与悬停明细卡跟着换；选择按来源记在本机（`~/.bobo/usage.json`），重启后保留。折叠态点圆环也是换这一家的显示范围，并顺带把它设为折叠胶囊显示的那家。
- 悬停明细卡里，折叠胶囊显示的那家带一枚「当前」徽标，圆环当前画的那一档窗口标题加粗提亮。

### 变更

- 额度圆环统一画「这一家记住的那一档窗口」，「点击切换」方式下也跟随（没设置过就还是 5 小时窗口）；明细卡提示按查看方式区分「点击圆环切换显示范围」/「点击圆环切换来源」。
- 「用量」页面里关掉的来源不参与刘海胶囊的并排显示与切换（说明文案同步）。

## [1.2.5] - 2026-09-21

### 新增

- **通知岛**新增 Google Antigravity（agy）来源，从五家扩到六家：只读 `~/.gemini/antigravity-cli` 的会话库（SQLite），运行中 / 等你回答 / 已结束 / 已终止照常提醒；点会话跳到终端里对应的 `AGY | …` 标签页。
- **额度**新增 Antigravity：Gemini 与 Claude / GPT 两组模型的 5 小时与周额度，优先读本地 Language Server 的 `RetrieveUserQuotaSummary`，读不到退回 `agy` CLI 的 `/usage` 报告。
- **智能体**的全局配置新增 Antigravity（`~/.gemini` 下的 GEMINI.md、settings.json、CLI 偏好、全局配置、Hooks 与 MCP 配置）。
- 通知岛点 Codex 桌面版（Codex app / ChatGPT.app）的会话时，优先用线程深链 `codex://threads/<id>` 带你回 app 里的那条线程。

### 变更

- 通知岛与「智能体 → 全局配置」的 harness 清单统一为六家（OpenCode、Codex、Claude Code、omp、dsh、agy）。
- 终端匹配收敛到一处：会话归属哪个终端、点击跳哪个标签页与「看过了」判断共用同一套标题 / 目录匹配，不再各写一份。
- 运行要求 Node.js 22.13+（agy 会话库用内置 `node:sqlite` 读取）。

### 修复

- Codex 同一会话的派生 rollout 文件（桌面包 rollover / fork 产生的 `<原 id>_<新 id>.jsonl`）不再让状态每轮轮询来回翻、提醒反复响：状态取最新写入的那份，开始时间取整条线程最早的一份。

## [1.2.4] - 2026-09-20

### 变更

- 顶栏版本号改为服务端注入，首屏就是正确版本（1.2.2 里它写死成 `v1.2.0`，看起来像没更新）。
- 自动检查频率从每 6 小时改为**每小时**一次（启动 15 秒后先查一次）。
- 新版本下载完成时弹一次提示：「vX.Y.Z 已下载好，点右上角版本号重启安装」，不用进设置页找入口。

## [1.2.3] - 2026-09-20

### 变更

- 更新入口移到顶栏右上角的**版本按钮**：默认显示版本号，检查中 / 下载中（带百分比）/ 已就绪直接显示在按钮上（就绪时呼吸提示），点一下即检查更新或重启安装；「设置 → 关于」不再放更新按钮，只保留 app 信息与开源社区。

### 修复

- 点「重启并更新」后应用长时间不退出（AppleScript 受「自动化」权限限制，原脚本要等 10 秒才强杀）：重启脚本改为按 PID 分级退出（AppleScript 1 秒 → SIGTERM 3 秒 → SIGKILL），等待上限压到 4 秒内。
- 暂存包被系统清理后点重启会一直卡在「正在重启」：安装前先确认暂存包存在（不存在就提示重新检查），并挂 40 秒看门狗，失败自动恢复成可重试状态。

## [1.2.2] - 2026-09-20

### 修复

- 主窗口已经打开但被其他应用遮挡、或处于最小化时，点 Dock 图标 / 菜单栏图标无法回到前台；现在总会激活并置前（最小化的窗口先还原）。⌘Tab 切回来同样受益。

## [1.2.1] - 2026-09-20

### 变更

- 发布包改用 Developer ID（Yonghao Yang · LGKLTGNTY2）签名并提交 Apple 公证，启用硬化运行时与安全时间戳：下载后 Gatekeeper 直接放行，不用再右键打开。
- 应用内更新校验更新包的代码签名，只接受同一开发者团队签名的包，签名无效或团队不符时拒绝安装。
- `scripts/build-app.sh` 自动检测本机钥匙串里的 Developer ID 证书（找不到时退回 ad-hoc 并告警）；`npm run package` 完成签名、公证、staple 与 Gatekeeper 校验后再打包，未签名时默认拒绝发布。
- Release 工作流支持 Developer ID 签名与公证（配置证书与 App Store Connect API Key 的 secrets 后自动生效；未配置时只跑测试并提示跳过发布）。
- README 顶部加入应用图标与徽章（对齐 PaperRss 的主页样式）。

## [1.2.0] - 2026-09-20

首个公开版本。

### 新增

- **通知岛**：贴住刘海的常驻面板，合并 OpenCode（事件流）、Codex CLI（轮询 rollout）、omp（轮询会话文件）、Claude Code（活跃注册表 + 会话日志）与 DeepSeek Harness（投影缓存）的会话状态；等你回答 / 结束 / 终止时系统通知与提示音提醒，悬停展开会话卡片，点击跳到对应终端或应用。
- **额度**：Codex（chatgpt.com 的订阅额度窗口）与 OpenCode Go（官方用量接口，失败退回本机估算）；刘海胶囊环形显示，悬停看明细，额度重置时可提醒。
- **设备**：CPU（整机与每核占用、负载均值）、内存（页统计与压力等级）、磁盘（APFS 容器）与 Top 进程，只读本机、不联网。
- **技能**：直接管理 `~/.agents/skills` 与各 Agent 全局技能目录；仓库安装 / 本地新建 / 更新 / 删除、阅读与编辑全部文件；「我的 Skill」管理任意本地目录、按需启停并一键同步到 GitHub。
- **智能体**：「智能体」视图管理 OpenCode（`~/.config/opencode/agents`）与 Codex CLI（`~/.codex/agents`）的定义文件，并阅读、调节五家 harness 的全局配置。
- **AI**：按段落翻译全文与生成能力总结（OpenAI 兼容接口），摘要与译文缓存到 `~/.bobo/ai-cache`。
- **应用内更新**：安装版静默检查 GitHub Release、后台下载并校验，一键「重启并更新」完成替换与重启。
- **macOS 应用**：AppKit + WebKit 壳，刘海面板 / 菜单栏图标（可选）/ Dock 动态显隐，本地 Node 服务随应用启动与退出。

### 变更

- 服务端模块统一收进 `src/`、测试收进 `test/`（原来是根目录平铺）。
- 「设置」改为顶栏常驻 tab（原来从侧栏左下角打开）；顶栏右侧新增 GitHub 入口与版本号，技能相关操作移入列表视图。
- 版本号以 `package.json` 为唯一真源，构建时写入 Info.plist；新增 `scripts/build-app.sh` 与 `scripts/package-release.mjs`。

[1.2.0]: https://github.com/ohmyangboy/bobo/releases/tag/v1.2.0
[1.2.1]: https://github.com/ohmyangboy/bobo/releases/tag/v1.2.1
[1.2.2]: https://github.com/ohmyangboy/bobo/releases/tag/v1.2.2
[1.2.3]: https://github.com/ohmyangboy/bobo/releases/tag/v1.2.3
[1.2.4]: https://github.com/ohmyangboy/bobo/releases/tag/v1.2.4
[1.2.5]: https://github.com/ohmyangboy/bobo/releases/tag/v1.2.5
[1.3.0-beta.1]: https://github.com/ohmyangboy/bobo/releases/tag/v1.3.0-beta.1
[1.3.0-beta.2]: https://github.com/ohmyangboy/bobo/releases/tag/v1.3.0-beta.2
