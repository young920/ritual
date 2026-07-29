#!/bin/bash
# Ritual.app 启动 wrapper
# CFBundleExecutable 指向本脚本,脚本:
#   1. cd 到 Resources/ritual_runtime/(里面有 package.json + main.js + web/)
#   2. exec Electron 二进制 + .  → 让 Electron 加载我们的 main.js
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
RES="$DIR/../Resources/ritual_runtime"
cd "$RES"
exec "$DIR/Electron" .