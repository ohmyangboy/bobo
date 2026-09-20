---
published: true
---

# 更新日志

本文件记录 bobo 面向用户的版本变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。发布在 [GitHub Releases](https://github.com/ohmyangboy/bobo/releases)。

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
