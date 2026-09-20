# 贡献指南

bobo 是一个个人工具项目，欢迎试用与提交 Issue / PR。动手前建议先看 [README](README.md)；[AGENTS.md](AGENTS.md) 是给 AI 协作者与开发者的详细架构约定，改代码前值得读一遍相关章节。

## 开发环境

- macOS（应用壳与通知岛依赖 AppKit / WebKit；服务端本身跨平台）
- Node.js 22+（没有任何 npm 依赖，不需要 `npm install`）
- 构建 macOS 应用需要 Xcode Command Line Tools（`xcrun swiftc`）

```sh
git clone https://github.com/ohmyangboy/bobo.git
cd bobo
npm start        # 本地服务 → http://127.0.0.1:4318
npm test         # 全部测试
./update.sh      # 构建并覆盖安装 /Applications/bobo.app
```

## 约定

- 文案、错误消息、注释一律用中文；代码风格紧凑（单行函数不少见），跟随周围写法，不要整体重排。
- 服务端只用 Node.js 内置模块，不引入 npm 依赖；网页是原生 HTML / CSS / JS，保持无构建步骤。
- 服务端模块放 `src/`，测试放 `test/`；提交前 `npm test` 必须全绿。
- 测试一律使用临时目录与隔离 HOME（`BOBO_HOME`），不访问真实技能、真实凭据、真实网络。
- 新增图标用内联 SVG 精灵（`public/index.html` 顶部），不要外链，保证 `currentColor` 能跟随深浅色主题。
- 新增 `public/` 文件要同时注册到 `src/server.mjs` 的静态资源白名单；新增服务端模块后 `update.sh` 与 v2 的同步脚本会自动带上（构建脚本按目录复制）。
- 改动服务端后同步更新 `AGENTS.md` 中对应的架构说明；用户可见的变化写进 `CHANGELOG.md`。

## 提交 PR

1. 从 `main` 开分支，保持改动聚焦；
2. 跑 `npm test`；涉及 Swift 的改动再加 `node --test macos/island-layout.test.mjs`；
3. PR 说明改了什么、怎么验证的，UI 改动附上截图（浅色 / 深色各一张更好）。
