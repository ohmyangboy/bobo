# 静态官网

官网使用 [Paper Blog](https://github.com/ohmyangboy/paper-blog)，参考 [Lives Mobile 官网](https://ohmyangboy.github.io/lives-mobile-website/)的单列 Markdown 排版。与本机应用的 `public/` 分开维护。

- `posts/index.md`：中文首页，位于 `/bobo/`。
- `posts/index.en.md`：英文首页，位于 `/bobo/en/`。页脚可切换语言，默认首页会匹配浏览器语言。
- `posts/getting-started.md`、`posts/features.md`：安装说明与功能速览。
- `posts/assets/`：官网图标与截图。图标来自仓库的 `assets/`，通知岛、设备、Agents 和额度使用提供的最新界面截图。
- `.paper-config.json`：站点名称、强调色、图标、文章目录与 GitHub Pages 地址。
- `out/`：Paper 生成的静态文件；修改源 Markdown 后重新构建，不直接编辑生成文件。

## 本地预览与构建

先安装 Paper Blog；在本仓库根目录运行：

```sh
npm run site:preview
npm run site:build
```

也可以直接运行 `paper -l serve` 和 `paper -l build`。配置中的目录使用相对路径，因此直接调用 Paper 时需要先切到本仓库根目录。

Paper 生产构建只收录 `published: true` 的文章；首页和带 `i18n` 的首页版本自动参与构建。只扫描 `posts/`，不会将仓库根目录的开发规则或其它 Markdown 自动发布成文章。

配置中的 `compress: true` 开启 Paper 的图片压缩：构建时优化 `out/assets/` 的图片，`posts/assets/` 保留原图。首页的三张主窗口截图使用 Paper 原生图片组排版，可点击放大。

## GitHub Pages

官网地址为 <https://ohmyangboy.github.io/bobo/>。现有 Pages 配置从 `gh-pages` 分支根目录发布，沿用 Paper 的分支部署方式。

审核内容与生成结果后，在本仓库根目录执行：

```sh
npm run site:build
paper -l deploy
```

`deploy` 会暂存并提交 `out/`，再推送到远程 `gh-pages`。执行前确认暂存区没有其它改动；官网 Markdown 和配置需要另外纳入源码提交。线上是否更新以 GitHub Pages 构建与网页读回为准。
