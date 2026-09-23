<div align="center">

  <img src="../assets/app-icon.png" alt="bobo 头像" width="120" height="120" />

  # bobo

  ***万事通式的本地 Agent 工作台。***

  [Releases](https://github.com/ohmyangboy/bobo/releases) · [问题反馈](https://github.com/ohmyangboy/bobo/issues)

</div>

---

## 预览

<div align="center">

  <img src="../assets/screenshots/notch-collapsed.png" alt="通知岛折叠态" width="560" />
  <br />
  <sub>通知岛 · 折叠</sub>

  <br /><br />

  <img src="../assets/screenshots/notch-expanded.png" alt="通知岛展开态" width="1040" />
  <br />
  <sub>通知岛 · 展开</sub>

  <br /><br />

  <img src="../assets/screenshots/web-island.png" alt="bobo 网页界面：通知岛设置" width="1140" />
  <br />
  <sub>网页界面 · 通知岛设置</sub>

</div>

## 功能

- **通知岛** —— 贴住刘海的常驻胶囊：六个 harness 的会话状态变成看得见、听得到的提醒，悬停展开会话卡片，点击跳回对应终端。
- **额度** —— Codex、OpenCode Go 与 Antigravity 的剩余额度（5 小时 / 本周 / 账单月），只读取本机登录与用量，不改写任何凭据。
- **系统状态** —— CPU（整机与每核、负载）、内存（压力与页统计）、磁盘占用与 Top 进程；网络延迟与下载 / 上传速率（刘海上是三枚垂直排列的灯珠）。
- **技能** —— 阅读、编辑、安装、更新、删除 `~/.agents/skills` 里的全局技能；「我的 Skill」管理任意本地目录并一键同步到 GitHub。
- **智能体** —— 管理 OpenCode 与 Codex CLI 的自定义智能体定义，阅读并调节全局配置。
- **AI** —— 按段落翻译全文、生成能力总结（OpenAI 兼容接口）。

## 支持的 harness

| Harness | 通知岛 | 额度 | 技能 | 智能体 / 全局配置 |
| --- | --- | --- | --- | --- |
| OpenCode | ✅ 事件流实时 | — | 全局技能（读写） | ✅ 智能体定义 + 全局配置 |
| Codex CLI | ✅ 轮询 rollout | ✅ ChatGPT 订阅额度 | 全局技能（链接） | ✅ TOML 智能体 + 全局配置 |
| Claude Code | ✅ 活跃注册表 + 会话日志 | — | 全局技能（链接） | ✅ 全局配置 |
| omp（Oh My Pi） | ✅ 轮询会话文件 | — | 全局技能（链接） | ✅ 全局配置 |
| DeepSeek Harness（dsh） | ✅ 投影缓存 | — | 全局技能（链接） | ✅ 全局配置 |
| Google Antigravity（agy） | ✅ SQLite 会话库 | ✅ 各模型组配额 | 全局技能（链接） | ✅ 全局配置 |

## 参考的开源项目

- [CodeIsland](https://github.com/wxtsky/CodeIsland)：通知岛面板的形态与「用终端归属判断已读」的经验。
- [CodexBar](https://github.com/steipete/CodexBar)：额度读取口径、窗口归一化与来源图标。
- [stats](https://github.com/exelban/stats)：系统状态的展示方式。
- [skills](https://github.com/vercel-labs/skills)：技能生态的目录约定与 Agent 注册表。

MIT © ohmyangboy。第三方资源与致谢见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
