#!/usr/bin/env bash
# Ritual 一键启动(Mac/Linux)
# 用 uv 自动管理 Python 环境,无需手动装依赖。

set -e

# 解析脚本所在目录
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# 检查 uv,没装就提示装
if ! command -v uv >/dev/null 2>&1; then
  echo "❌ 需要先装 uv(Python 环境管理工具):"
  echo "   curl -LsSf https://astral.sh/uv/install.sh | sh"
  echo "   或 brew install uv"
  exit 1
fi

# 用 uv 自动建/复用 .venv,装依赖
echo "📦 准备 Python 环境 + 依赖..."
uv sync --quiet

# 启动 server,浏览器自动打开
PORT="${PORT:-8000}"
echo "🚀 Ritual 启动中 → http://127.0.0.1:${PORT}"
echo "   浏览器会自动打开。如果没自动开,请手动访问上面的地址。"
echo "   第一次进入,先去「设置」填入你的 API key。"
echo ""

# 尝试打开浏览器(mac)
if command -v open >/dev/null 2>&1; then
  (sleep 1 && open "http://127.0.0.1:${PORT}") &
fi

# 启动 uvicorn
exec uv run python -m web.app