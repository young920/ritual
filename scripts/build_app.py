"""用 PyInstaller 把 Ritual 打成单文件可执行程序。

用法:
    uv run python scripts/build_app.py [mac|win|linux]

输出:
    dist/ritual                (Linux/Mac 单文件二进制)
    dist/ritual.app            (Mac .app bundle,仅 mac 目标)
    dist/ritual.exe            (Windows 单文件,仅 win 目标)
"""
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
BUILD = ROOT / "build"
SPEC = ROOT / "ritual.spec"


def build():
    """PyInstaller 打包入口。跨平台通用,根据当前 OS 自动选目标。"""
    target = sys.argv[1] if len(sys.argv) > 1 else None
    system = platform.system().lower()
    # 简称 → 系统全称
    aliases = {"mac": "darwin", "darwin": "darwin", "win": "windows", "windows": "windows",
               "linux": "linux"}
    if target:
        target = aliases.get(target.lower(), target.lower())
        if target != system:
            print(f"⚠️  目标是 {target},但当前 OS 是 {system}。PyInstaller 必须交叉编译或在目标 OS 上跑。")
            sys.exit(1)

    # 清理
    if DIST.exists():
        shutil.rmtree(DIST)
    if BUILD.exists():
        shutil.rmtree(BUILD)

    cmd = []  # 命令稍后构造
    # 静态资源路径
    sep = ";" if system == "windows" else ":"
    static_resources = [
        ("web/static", "web/static"),
        ("web/templates", "web/templates"),
        ("web/data/demo.json", "web/data/demo.json"),
        ("data/exercises.json", "data/exercises.json"),
    ]

    # 静态资源(用 ; 分隔:Windows 是 ;, Mac/Linux 是 :)
    sep = ";" if system == "windows" else ":"
    static_resources = [
        ("web/static", "web/static"),
        ("web/templates", "web/templates"),
        ("web/data/demo.json", "web/data/demo.json"),
        ("data/exercises.json", "data/exercises.json"),
    ]
    add_data_args = []
    for src, dst in static_resources:
        src_path = ROOT / src
        if src_path.exists():
            add_data_args.extend(["--add-data", f"{src}{sep}{dst}"])

    # 关键:web/app.py 用了 `from cli import ...`,PyInstaller 默认不抓 cli 子模块
    hidden = ["--hidden-import", "cli", "--hidden-import", "cli.finder", "--hidden-import", "cli.coach"]

    # macOS 嵌入 .icns 图标
    icns = ROOT / "dist" / "ritual.icns"
    if icns.exists() and system == "darwin":
        print(f"→ 使用图标 {icns.name}")
    # Windows 嵌入 .ico 图标
    ico = ROOT / "dist" / "ritual.ico"

    # 优先用 pip-installed pyinstaller(避免 uv 缓存权限问题),失败再 fallback uv
    pyinstaller_bin = shutil.which("pyinstaller") or "pyinstaller"
    cmd = [
        pyinstaller_bin,
        "--onefile",
        "--name", "ritual",
        "--noconfirm",
        "--clean",
    ]
    if icns.exists() and system == "darwin":
        cmd.extend(["--icon", str(icns)])
    if ico.exists() and system == "windows":
        cmd.extend(["--icon", str(ico)])
    cmd.extend(add_data_args)
    cmd.extend(hidden)
    # 让 PyInstaller 找到 cli/ 目录(spec 路径)
    cmd.extend(["--paths", str(ROOT)])
    cmd.append("web/app.py")

    print("→ 运行:", " ".join(cmd))
    try:
        subprocess.run(cmd, check=True, cwd=ROOT)
    except FileNotFoundError:
        # 兜底:用 uv
        cmd[0:1] = ["uv", "run", "--with", "pyinstaller", "pyinstaller"]
        print("→ fallback:", " ".join(cmd))
        subprocess.run(cmd, check=True, cwd=ROOT)

    # Mac 额外打 .app bundle(单文件 + 创建快捷方式图标)
    if system == "darwin":
        make_macos_app()

    print("\n✓ 打包完成:")
    if (DIST / "ritual").exists():
        size_mb = (DIST / "ritual").stat().st_size / 1024 / 1024
        print(f"  {DIST / 'ritual'}  ({size_mb:.1f} MB)")
    if (DIST / "ritual.app").exists():
        print(f"  {DIST / 'ritual.app'}")
    if (DIST / "ritual.exe").exists():
        print(f"  {DIST / 'ritual.exe'}")


def make_macos_app():
    """把单文件 ritual 包成 .app bundle(macOS 才需要)。"""
    app_dir = DIST / "ritual.app" / "Contents"
    app_dir.mkdir(parents=True, exist_ok=True)
    (app_dir / "MacOS").mkdir(exist_ok=True)
    (app_dir / "Resources").mkdir(exist_ok=True)

    # 复制可执行文件
    shutil.copy(DIST / "ritual", app_dir / "MacOS" / "ritual")
    (app_dir / "MacOS" / "ritual").chmod(0o755)

    # Info.plist
    plist = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>Ritual</string>
    <key>CFBundleDisplayName</key>
    <string>Ritual</string>
    <key>CFBundleIdentifier</key>
    <string>com.ritual.app</string>
    <key>CFBundleVersion</key>
    <string>0.1.0</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSMinimumSystemVersion</key>
    <string>10.13</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSUIElement</key>
    <false/>
</dict>
</plist>"""
    (app_dir / "Info.plist").write_text(plist)


if __name__ == "__main__":
    build()