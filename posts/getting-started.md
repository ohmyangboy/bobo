---
title: 安装与开始使用
date: 2026-10-10
published: true
description: 下载 bobo，安装 Node.js，并开始查看会话、额度和管理本机 Agent。
---

## 下载安装

1. 准备一台运行 **macOS 13.0 或更新版本**的 Mac，并安装 **Node.js 22.13+**。
2. 从 [最新 Release](https://github.com/ohmyangboy/bobo/releases/latest) 下载 `bobo.app.zip`。
3. 解压后，把 `bobo.app` 拖进「应用程序」，然后打开。

安装 Node.js 后，可以在终端运行 `node --version` 确认版本。bobo 的会话与用量读取需要 Node.js 22.13+ 的内置 SQLite 支持。

## 开始使用

- **通知岛**：打开你常用的 Agent，bobo 会读取支持的本机会话信号。悬停刘海胶囊查看会话，点击跳回工作窗口；显示位置、提醒和展开行为在「通知岛」里设置。
- **额度**：在对应来源中检查登录和用量状态。读取方式取决于服务，部分来源需要手动配置或由你授权读取登录信息。
- **Agents**：选中来源，切换「配置 / 智能体 / 技能」。技能视图也可以浏览全部技能和「我的 Skill」目录。
- **设备**：查看 CPU、内存、磁盘与网络。「检测线路」还会查询出口 IP 的类型和风控信息。
- **AI**：如需能力总结与翻译，在「设置 → AI」配置 OpenAI 兼容接口。

需要安装 / 更新仓库来源的技能时，本机还需有 `git`。将「我的 Skill」同步到 GitHub 时，会使用你本机的 Git 与 GitHub 登录。

## 应用内更新

安装版会检查 GitHub Release，并在后台下载更新。在「设置 → 关于」点「重启并更新」即可安装；也可以手动检查。

## 从源码运行

需要 Node.js 22.13+。只运行本地服务即可使用网页工作台：

```sh
git clone https://github.com/ohmyangboy/bobo.git
cd bobo
npm start
```

浏览器打开 `http://127.0.0.1:4318`。原生刘海面板需要 macOS 应用。

在安装了 Xcode Command Line Tools 的 Mac 上，运行下面的命令可构建并安装原生应用到 `/Applications/bobo.app`：

```sh
./update.sh
```

源码版本也使用 `./update.sh` 更新。更多操作见[功能说明](/posts/features/)和 [完整文档](https://github.com/ohmyangboy/bobo/blob/main/docs/features.md)。
