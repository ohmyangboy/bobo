#!/bin/bash
# 构建 bobo.app 到指定目录：本机安装（update.sh）与发布打包（scripts/package-release.mjs）共用。
# 版本号唯一真源是 package.json；构建编号默认取 git 提交数，可被 BOBO_BUILD 覆盖（CI 用 run number）。
# 用法：scripts/build-app.sh [输出目录]   默认 dist/，最终产出 <输出目录>/bobo.app
set -euo pipefail
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="${1:-$project_dir/dist}"
version="$(node -p "require('$project_dir/package.json').version")"
build="${BOBO_BUILD:-$(git -C "$project_dir" rev-list --count HEAD 2>/dev/null || echo 1)}"
identity="${CODESIGN_IDENTITY:--}"

if [[ -z "$version" ]]; then
  echo "无法从 package.json 读取版本号" >&2
  exit 1
fi
node_path="$(command -v node || true)"
if [[ -z "$node_path" ]]; then
  echo "找不到 Node.js（需要 22 或更高版本）" >&2
  exit 1
fi

app_dir="$out_dir/bobo.app"
rm -rf "$app_dir"
mkdir -p "$app_dir/Contents/MacOS" "$app_dir/Contents/Resources"
icon_work="$(mktemp -d)"
trap 'rm -rf "$icon_work"' EXIT

# 1. 编译 Swift 壳（AppKit + WebKit）。
xcrun swiftc -parse-as-library -O "$project_dir/macos/Bobo.swift" -o "$app_dir/Contents/MacOS/Bobo" -framework AppKit -framework WebKit

# 2. 服务端与网页资源：src/ 与 public/ 原样保留结构，Bobo.swift 启动 Resources/src/server.mjs。
cp "$project_dir/package.json" "$app_dir/Contents/Resources/"
cp -R "$project_dir/src" "$app_dir/Contents/Resources/src"
cp -R "$project_dir/public" "$app_dir/Contents/Resources/public"
# 通知岛头像与额度 / 会话行的来源图标（来源图标与 index.html 的 SVG 精灵同源）。
cp "$project_dir"/macos/assets/bobo-island-avatar-*.png "$app_dir/Contents/Resources/"
cp "$project_dir"/macos/assets/bobo-provider-*.svg "$app_dir/Contents/Resources/"
echo "$node_path" > "$app_dir/Contents/Resources/node-path"

# 3. 应用图标。
xcrun swift "$project_dir/macos/make-icon.swift" "$icon_work/AppIcon.iconset" "$project_dir/macos/assets/bobo-mascot.png"
iconutil -c icns "$icon_work/AppIcon.iconset" -o "$app_dir/Contents/Resources/Bobo.icns"

# 4. Info.plist：版本与构建编号在这里注入。
cat > "$app_dir/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Bobo</string>
<key>CFBundleIdentifier</key><string>local.bobo.app</string>
<key>CFBundleIconFile</key><string>Bobo</string>
<key>CFBundleName</key><string>bobo</string>
<key>CFBundleDisplayName</key><string>bobo</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${build}</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST

codesign --force --sign "$identity" "$app_dir"
echo "$app_dir"
