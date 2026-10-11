---
title: 功能与支持范围
date: 2026-10-10
published: true
description: bobo 的通知岛、额度、设备、技能与智能体管理，以及各个 Agent 的支持范围。
---

## 通知岛

将多个 Agent 的会话合并到一处，显示运行中、等你回答、已结束与已终止。悬停展开，点击会话跳转；已结束并查看过的会话会收起。

支持的来源是 OpenCode、Codex、Claude Code、omp、DeepSeek Harness 与 Antigravity。状态来自各工具提供的本机事件或记录，识别能力有所不同：dsh 的审批与 `ask_user`、Antigravity 的审批等待目前没有可用信号，会继续显示运行中。

Codex 会话优先尝试对应的桌面线程入口；dsh 网页服务运行时优先回到已有浏览器标签页，其余按终端标题与目录匹配。能否成功跳转取决于工具、终端和窗口是否仍然存在。

## 支持的 Agent

| Agent | 会话通知 | 额度 | 自定义智能体 | 全局配置 |
| --- | --- | --- | --- | --- |
| OpenCode | 支持 | OpenCode Go | 支持 | 支持 |
| Codex | 支持 | 支持 | 支持 | 支持 |
| Claude Code | 支持 | 支持 | — | 支持 |
| omp（Oh My Pi） | 支持 | — | — | 支持 |
| DeepSeek Harness（dsh） | 支持 | — | — | 支持 |
| Antigravity（agy） | 支持 | 支持 | — | 支持 |

## 额度与设备

额度视图按来源展示用量窗口与重置时间；刘海上可以显示多家的额度圆环。

设备视图提供 CPU、内存、磁盘、Top 进程、网络延迟及下载 / 上传速率。服务线路展示 Codex、Claude Code、OpenCode Go、DeepSeek 与 Antigravity 的延迟、出口 IP 类型及风控值。

本机网速统计读取网卡计数器；服务线路检测会请求第三方 IP 信息服务，两者用途不同。

## 技能与智能体

技能直接使用 Agent Skills 生态的目录约定：技能真身位于 `~/.agents/skills`，其它 Agent 通过符号链接使用它。bobo 可以读取本机技能、编辑文件、从 Git 仓库安装 / 更新，并查看每个 Agent 的链接状态。

「我的 Skill」可以接入任意本地技能目录、启停单个技能，并使用本机 Git / GitHub 工具同步。移除目录配置会保留源文件；删除技能会删除技能文件，请留意操作提示。

Agents 视图管理 OpenCode 的 Markdown 智能体、Codex 的 TOML 智能体，以及已接入 harness 的白名单配置文件。编辑带版本校验，写入前的备份共用最近 3 份的保留额度。

## AI 阅读

使用你配置的 OpenAI 兼容接口，生成能力总结或按段落翻译技能、智能体与配置。使用这些操作时，相关内容会发送到所配置的接口。

## 项目与许可

bobo 是一个持续迭代的个人工具，兼容范围主要覆盖作者实际使用的工具。欢迎 fork、Issue 与 PR。

项目以 [MIT 许可](https://github.com/ohmyangboy/bobo/blob/main/LICENSE)开放。通知岛、额度、系统状态与技能管理分别参考了 [CodeIsland](https://github.com/wxtsky/CodeIsland)、[CodexBar](https://github.com/steipete/CodexBar)、[stats](https://github.com/exelban/stats) 和 [skills](https://github.com/vercel-labs/skills)。

[完整文档](https://github.com/ohmyangboy/bobo/blob/main/docs/features.md) · [贡献指南](https://github.com/ohmyangboy/bobo/blob/main/CONTRIBUTING.md) · [第三方资源与致谢](https://github.com/ohmyangboy/bobo/blob/main/THIRD_PARTY_NOTICES.md)
