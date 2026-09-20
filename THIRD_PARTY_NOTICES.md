---
published: true
---

# 第三方资源与致谢

bobo 本体以 MIT 协议开源（见 `LICENSE`）。仓库里包含的第三方素材与参考实现如下，均为各自作者的成果：

## 图标与素材

| 资源 | 来源 | 许可 |
|---|---|---|
| `macos/assets/bobo-provider-codex.svg`、`bobo-provider-opencode-go.svg` | [CodexBar](https://github.com/steipete/CodexBar) 的模型来源图标 | MIT |
| `macos/assets/bobo-provider-omp.svg` | [oh-my-pi](https://github.com/can1357/oh-my-pi) 的品牌图标 | MIT |
| `macos/assets/bobo-provider-dsh.svg` | [Simple Icons](https://simpleicons.org) 的 DeepSeek 官方标记 | CC0 |
| `macos/assets/bobo-provider-claude.svg` | 自绘（八芒星，与 Claude Code 终端标题前缀同形） | MIT |
| `macos/assets/bobo-island-avatar-*.png`、`bobo-mascot.png` | 自绘（bobo 头像） | MIT |
| `public/index.html` 内联的 SF Symbols 图形 | Apple 的 SF Symbols 导出，按 Apple 的 [SF Symbols 许可](https://developer.apple.com/sf-symbols/)在 Apple 平台应用内使用 | Apple |
| `public/icon.png`、`Bobo.icns` | 自绘（bobo 应用图标） | MIT |

## 参考与致谢

bobo 是一个融合工具，以下项目给了它方向与具体实现上的参照：

- [**CodeIsland**](https://github.com/wxtsky/CodeIsland)：通知岛面板的形态与「用终端归属判断已读」的经验；bobo 的刘海几何、字幕式补间与折叠头像都对齐它的做法。
- [**CodexBar**](https://github.com/steipete/CodexBar)：额度（Codex / OpenCode Go）的读取口径、窗口归一化与来源图标。
- [**stats**](https://github.com/exelban/stats)：系统状态（CPU / 内存 / 磁盘）的展示方式。
- [**skills**](https://github.com/vercel-labs/skills)：技能生态的目录约定与 Agent 注册表（`src/skill-agents.mjs` 从其注册表抽取）。
- 技能与智能体提示词参考了 [Matt Pocock](https://github.com/mattpocock) 与 [Emil Kowalski](https://github.com/emilkowalski) 的公开技能。

## 运行时依赖

无。服务端只用 Node.js 内置模块，网页是原生 HTML / CSS / JavaScript，不引入 npm 包；剪贴板、文件夹选择等系统能力经 `osascript` 调用 macOS 自带工具。
