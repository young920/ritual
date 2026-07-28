@echo off
REM Ritual 一键启动(Windows)

setlocal

cd /d "%~dp0"

REM 检查 uv
where uv >nul 2>&1
if errorlevel 1 (
    echo ❌ 需要先装 uv:https://astral.sh/uv/install.ps1
    echo    或 winget install astral-sh.uv
    exit /b 1
)

echo 📦 准备 Python 环境 + 依赖...
uv sync --quiet

set PORT=8000
echo 🚀 Ritual 启动中 → http://127.0.0.1:%PORT%
echo    浏览器会自动打开。首次进入请先去「设置」填入你的 API key。

start "" "http://127.0.0.1:%PORT%"

uv run python -m web.app