# Ritual 安装包发布(自动构建 + 上传 GitHub Release)

触发方式:
  - 打 tag `v0.1.0` → 自动构建 Mac/Win/Linux 三个平台二进制
  - 上传到 GitHub Release(自动生成 release notes)

## 用法

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions 自动:
1. 在 Mac 上构建 `Ritual.app` + 单文件 `ritual` binary
2. 在 Windows 上构建 `ritual.exe`
3. 在 Linux 上构建 `ritual` binary
4. 上传三个二进制到 GitHub Release

## 用户下载后

- **Mac**:下载 `.dmg` 或 `.app.zip`,解压双击 .app(可能要去「系统设置 → 隐私与安全性」允许)
- **Windows**:下载 `.exe`,双击运行(可能弹 SmartScreen,点「更多信息 → 仍要运行」)
- **Linux**:下载 `.AppImage` 或 `.tar.gz`,chmod +x 后双击运行

## 本地手动构建(开发调试)

```bash
# Mac / Linux
./scripts/build_app.sh mac

# Windows
.\scripts\build_app.bat win
```