# bobo v2

bobo 的跨平台桌面壳（Tauri 2 + Rust），面向 macOS 与 Windows。

**主项目（`../`）保持唯一真源**：服务端模块（`../src/`）与网页资源（`../public/`）由 `scripts/sync-runtime.mjs` 复制到本目录的 `runtime/`（构建产物，不进版本库），本目录只放壳与构建脚本，不改动 `../` 下的任何文件。

## 目录

```
v2/
├── package.json             脚本入口（唯一的 npm 依赖是 devDependency 里的 @tauri-apps/cli）
├── scripts/
│   ├── sync-runtime.mjs     从 ../ 同步 src/ + public/ 到 runtime/（保持 src/ 结构），并写入 node-path
│   └── dev.mjs              dev 模式下由 Tauri CLI 拉起本地服务（beforeDevCommand）
├── runtime/                 （生成，gitignore）
│   ├── src/                 服务端模块（镜像 ../src/）
│   ├── public/              网页与通知岛面板
│   ├── package.json         版本真源（应用内更新也会读它）
│   └── node-path            构建时记录的 node 绝对路径
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json      窗口、打包、资源清单
    ├── capabilities/        default.json（主窗口）、remote.json（127.0.0.1 页面的受限 IPC）
    └── src/
        ├── main.rs          单实例、窗口生命周期（关闭=隐藏）、服务就绪后显示窗口
        └── service.rs       Node 探测与拉起（复用已运行的服务，退出时清理自己启动的）
```

## 开发与构建

```sh
npm install          # 只装 @tauri-apps/cli
npm run dev          # 同步 runtime → 编译 → 起服务 → 打开窗口
npm run build        # 产出 .app/.dmg（macOS）或 .msi/.exe（Windows）
```

- `npm run runtime`：只做同步（改了主项目服务端后单独跑）。
- `npm run icons`：从 `../macos/assets/bobo-mascot.png` 重新生成各平台图标。
- 没有 `beforeBuildCommand` 里跑 sync 是为了让 `tauri build` 独立可用；`npm run build` 已先同步。

## 两条必须知道的规则

1. **服务端模块清单是自动收集的**：`sync-runtime.mjs` 从 `../src/server.mjs` 的 import 图出发，主项目新增模块不用手工维护（历史上漏过 `terminals.mjs`）。
2. **v2 与主项目的 macOS 应用不能同时开服务**：两者都监听 4318。壳会先探测——已经在跑就直接复用（不接管用户终端里的进程），所以要停服务请去启动它的那个地方停。

## 与主项目的差异（迁移期）

| 项 | 主项目（Swift 壳） | v2（Tauri 壳） |
|---|---|---|
| bundle id | `local.bobo.app` | `local.bobo.v2`（正式取代时改回，避免 TCC/通知记录混淆） |
| 安装位置 | `/Applications/bobo.app` | 构建产物在 `src-tauri/target/release/bundle/`，不自动安装 |
| 通知岛 | SwiftUI 面板（`Bobo.swift`） | 网页面板（`../public/panel.*`）+ Rust 的透明悬浮窗（`src/island.rs`） |
| Node 运行时 | 打包时记录 `node-path` | 同上，另加常见位置与 PATH 兜底 |
| 端口 | 固定 4318 | 默认 4318，`BOBO_PORT` 可换（多实例调试用） |

## 进度

- **M1 服务端跨平台化**：完成。主项目新增 `platform.mjs`（打开文件/URL、目录链接、提示音、通知、文件夹选择器），Windows 走 junction / explorer / PowerShell；`devices.mjs` 补了 Windows 的磁盘挂载点与进程列表（`parseWinProcesses`）。
- **M2 桌面壳**：完成。单实例、托盘菜单（打开 bobo / 退出 bobo）、关闭窗口=隐藏、macOS 上开窗切 regular / 关窗切 accessory（无 Dock 图标）、托盘图标 `icons/tray.png`（18×18）。
- **M3 通知岛**：骨架跑通 —— 透明无边框窗口、层级盖过菜单栏（`setLevel(mainMenuWindow+2)`）、`collectionBehavior`（全空间 + 全屏辅助 + 不参与 ⌘Tab）、贴屏幕顶边居中、内容尺寸由面板回报（`island_resize`）、面板自己订阅 `/api/opencode/stream` 渲染头像/额度/设备/会话数。**待补**：折叠态的圆环与图标细节、悬停展开与会话列表、点击跳终端、拖拽移动、全屏让位与多屏选择、设置（`settings.notch` / `rows` / `movable` / `display`）同步。
- **M4 Windows 打磨与打包**：未开始。

