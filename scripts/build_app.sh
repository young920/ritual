#!/bin/bash
# 手搓 Ritual.app bundle — 不依赖 electron-builder(它下载 electron 到 ~/Library/Caches,无权限)
# 输入:node_modules/electron/dist/Electron.app(已有)
# 输出:dist/mac-arm64/Ritual.app(双击即用)

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON_APP="$PROJECT_ROOT/node_modules/electron/dist/Electron.app"
OUTPUT_DIR="$PROJECT_ROOT/dist/mac-arm64"
FINAL_APP="$OUTPUT_DIR/Ritual.app"

if [ ! -d "$ELECTRON_APP" ]; then
  echo "❌ 找不到 $ELECTRON_APP — 先 npm install 再跑"
  exit 1
fi

echo "→ 清空 $OUTPUT_DIR"
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

echo "→ 复制 Electron.app → Ritual.app"
cp -R "$ELECTRON_APP" "$FINAL_APP"

PLIST="$FINAL_APP/Contents/Info.plist"
echo "→ 改 Info.plist(CFBundleName / Identifier / Icon / DisplayName)"
/usr/libexec/PlistBuddy -c "Set :CFBundleName Ritual" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleName string Ritual" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Ritual" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Ritual" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.ritual.app" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string com.ritual.app" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion 0.2.0" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString 0.2.0" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :LSMinimumSystemVersion 10.13.0" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :LSMinimumSystemVersion string 10.13.0" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :NSHighResolutionCapable true" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :NSHighResolutionCapable true" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :LSApplicationCategoryType public.app-category.healthcare-fitness" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :LSApplicationCategoryType string public.app-category.healthcare-fitness" "$PLIST"

echo "→ 复制图标 scripts/logo.icns → Resources/"
cp "$PROJECT_ROOT/scripts/logo.icns" "$FINAL_APP/Contents/Resources/electron.icns"

echo "→ 拷项目代码 + venv + 数据到 ritual_runtime/"
RES_DIR="$FINAL_APP/Contents/Resources"
mkdir -p "$RES_DIR/ritual_runtime"
for entry in web cli data server .venv-ritual; do
  if [ -e "$PROJECT_ROOT/$entry" ]; then
    cp -R "$PROJECT_ROOT/$entry" "$RES_DIR/ritual_runtime/"
  fi
done
# 复制 node_modules(给 Electron / electron-builder 用)
if [ -d "$PROJECT_ROOT/node_modules" ]; then
  cp -R "$PROJECT_ROOT/node_modules" "$RES_DIR/ritual_runtime/"
fi
# 关键文件
cp "$PROJECT_ROOT/scripts/logo.icns" "$RES_DIR/ritual_runtime/" 2>/dev/null || true
cp "$PROJECT_ROOT/pyproject.toml" "$RES_DIR/ritual_runtime/" 2>/dev/null || true
cp "$PROJECT_ROOT/requirements.txt" "$RES_DIR/ritual_runtime/" 2>/dev/null || true
cp "$PROJECT_ROOT/package.json" "$RES_DIR/ritual_runtime/"
cp "$PROJECT_ROOT/package-lock.json" "$RES_DIR/ritual_runtime/" 2>/dev/null || true

echo "→ 安装 launcher 脚本(作为 CFBundleExecutable)"
cp "$PROJECT_ROOT/scripts/Ritual_launcher.sh" "$FINAL_APP/Contents/MacOS/Ritual"
chmod +x "$FINAL_APP/Contents/MacOS/Ritual"
# 不要碰 MacOS/Electron 二进制本身
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable Ritual" "$PLIST"

echo ""
echo "✓ 完成!"
echo "  位置: $FINAL_APP"
echo "  双击: open '$FINAL_APP'"
echo "  大小: $(du -sh "$FINAL_APP" | cut -f1)"