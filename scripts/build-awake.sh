#!/bin/bash
# 单独构建 CLI，不启动会话，也不安装或修改系统设置。
set -euo pipefail
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="${1:-$project_dir/dist/awake}"
mkdir -p "$(dirname "$output")"
xcrun swiftc -O "$project_dir/macos/Awake.swift" "$project_dir/macos/awake-main.swift" -o "$output" -framework IOKit
chmod 755 "$output"
echo "$output"
