#!/bin/bash
# 从源码构建并覆盖安装 bobo.app（本机开发用；应用内更新走 GitHub Release，不用这个脚本）。
# 用法：./update.sh [安装路径]   默认 /Applications/bobo.app
set -euo pipefail
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install_dir="${1:-/Applications/bobo.app}"
legacy_dir="/Applications/Skills Manager.app"
if [[ -e "$install_dir" && ! -f "$install_dir/Contents/Info.plist" ]]; then
  echo "目标已存在且不是应用包：$install_dir"
  exit 1
fi
# 先构建到临时目录，成功后再替换，避免中途失败破坏已安装版本。
build_root="$(mktemp -d)"
trap 'rm -rf "$build_root"' EXIT
"$project_dir/scripts/build-app.sh" "$build_root" >/dev/null
app_dir="$build_root/bobo.app"
# 改名后安装到 bobo.app：先退出仍在运行的旧版与新版应用，确认 4318 释放后再替换。
if [[ -d "$legacy_dir" ]]; then
  echo "正在退出旧版 Skills Manager…"
  osascript -e 'tell application id "local.skills-manager.app" to quit' >/dev/null 2>&1 || true
  for _ in {1..30}; do pgrep -x SkillsManager >/dev/null 2>&1 || break; sleep 0.2; done
fi
if pgrep -x Bobo >/dev/null 2>&1; then
  echo "正在退出旧应用…"
  osascript -e 'tell application id "local.bobo.app" to quit' >/dev/null 2>&1 || true
  for _ in {1..30}; do pgrep -x Bobo >/dev/null 2>&1 || break; sleep 0.2; done
fi
for _ in {1..15}; do lsof -nP -iTCP:4318 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.2; done
rm -rf "$install_dir"
mkdir -p "$(dirname "$install_dir")"
mv "$app_dir" "$install_dir"
open "$install_dir"
# 旧包在新版本安装成功后移除；只在默认安装位置时处理，避免误删自定义安装。
if [[ "$install_dir" == "/Applications/bobo.app" && -d "$legacy_dir" ]]; then
  rm -rf "$legacy_dir"
  echo "已移除旧版：$legacy_dir"
fi
echo "已更新并打开：$install_dir"
if lsof -nP -iTCP:4318 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "注意：4318 仍被占用，新应用可能复用旧服务（若为终端启动的服务请先停止）。"
fi
