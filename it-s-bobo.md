---
published: true
title: it's bobo!
date: 2026-09-20
---

> “it's bobo!”

bobo 是一个万事通式的本地 Agent 工作台：把散落的 Agent 会话、额度、技能与配置，收进一枚贴住刘海的胶囊和一个网页界面。

![[assets/screenshots/notch-collapsed.png|420|center]]

- **通知岛**：OpenCode、Codex、Claude Code、omp、dsh 的会话状态实时可见，需要回答或跑完时提醒，点击跳回对应终端。
- **额度与设备**：Codex 与 OpenCode Go 的剩余额度，加上 CPU、内存、磁盘与网络（延迟 / 上下行）的实时状态。
- **技能与智能体**：直接管理 `~/.agents/skills` 与五家的全局配置，不依赖 npx skills。

参考了 CodeIsland、CodexBar、stats 与 skills 四个开源项目；安装与完整功能见 [README](https://github.com/ohmyangboy/bobo)。
