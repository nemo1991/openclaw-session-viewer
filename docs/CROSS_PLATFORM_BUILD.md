# 跨平台打包指南

本文档说明如何在三个平台上构建 OpenClaw Session Viewer。

## 通用前置条件

- **Node.js** >= 20
- **pnpm** >= 9
- **Rust** >= 1.77(`rustup default stable`)
- **Tauri CLI**: `pnpm add -D -w @tauri-apps/cli` 或 `cargo install tauri-cli --version "^2.0"`
- **注册表**:`pnpm config set registry https://registry.npmjs.org/`

---

## macOS

### 前置

- Xcode Command Line Tools: `xcode-select --install`
- 可选:Apple Developer ID(用于公证/签名)

### 构建

```bash
pnpm tauri build
```

产物:
- `src-tauri/target/release/bundle/macos/OpenClaw 会话查看器.app` (5-6 MB)
- `src-tauri/target/release/bundle/dmg/OpenClaw 会话查看器_<version>_aarch64.dmg`
- `src-tauri/target/release/bundle/macos/OpenClaw 会话查看er.app` (Intel, 在 Intel Mac 上)

### 运行

```bash
open "src-tauri/target/release/bundle/macos/OpenClaw 会话查看器.app"
```

⚠️ **不要** 直接运行 `target/release/openclaw-session-viewer` 裸二进制 — Tauri 2 在 macOS 上必须在 .app bundle 内运行才能正确初始化 webview。

### 代码签名 (可选)

未签名的 .dmg 在首次打开时会被 Gatekeeper 拦截,提示"无法验证开发者"。要给发布版本签名:

```bash
# 一次性:导入证书到 Keychain
security import apple-dev-id.p12 -k ~/Library/Keychains/login.keychain-db

# 签名
codesign --deep --force --options runtime \
  --sign "Developer ID Application: Your Name (TEAMID)" \
  "src-tauri/target/release/bundle/macos/OpenClaw 会话查看器.app"

# 公证
xcrun notarytool submit "src-tauri/target/release/bundle/dmg/*.dmg" \
  --apple-id your@email.com --team-id TEAMID --password app-specific-pwd \
  --wait
```

---

## Linux

### 前置 (Ubuntu 24.04 / Debian 12+)

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl wget file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev
```

> 注意:Tauri 2 需要 **webkit2gtk 4.1**。Ubuntu 22.04 / Debian 11 默认是 4.0,需要从 PPA 升级。

### Fedora 41+

```bash
sudo dnf install -y \
  webkit2gtk4.1-devel \
  openssl-devel \
  curl wget file \
  libappindicator-gtk3-devel \
  librsvg2-devel \
  gcc gcc-c++ make
```

### Arch / Manjaro

```bash
sudo pacman -S --needed \
  webkit2gtk-4.1 \
  base-devel \
  curl wget file \
  libappindicator-gtk3 \
  librsvg \
  openssl
```

### 构建

```bash
pnpm install
pnpm tauri build
```

产物:
- `src-tauri/target/release/bundle/appimage/OpenClaw 会话查看器_<version>_amd64.AppImage`
- `src-tauri/target/release/bundle/deb/OpenClaw 会话查看器_<version>_amd64.deb`

### 运行

```bash
# AppImage
chmod +x "OpenClaw 会话查看器_<version>_amd64.AppImage"
./"OpenClaw 会话查看器_<version>_amd64.AppImage"

# .deb
sudo dpkg -i "OpenClaw 会话查看器_<version>_amd64.deb"
ocsv # 启动命令(根据 Cargo 配置)
```

### headless 服务器注意

GUI 应用在没有 DISPLAY 的服务器上无法运行。Linux 打包必须在有图形界面的环境(CI runner 一般用 `ubuntu-22.04` + `xvfb`)。

---

## Windows

### 前置

- **Visual Studio Build Tools 2022** (含 C++ 桌面开发 workload)
- **WebView2 Runtime**(Win11 默认有,Win10 需手动安装,见 Tauri 文档)
- **Rust**: `rustup default stable-x86_64-pc-windows-msvc`

### 构建

```powershell
pnpm install
pnpm tauri build
```

产物:
- `src-tauri/target/release/bundle/msi/OpenClaw 会话查看器_<version>_x64_en-US.msi`
- `src-tauri/target/release/bundle/nsis/OpenClaw 会话查看器_<version>_x64-setup.exe`

### 安装

双击 .msi → 按向导安装 → 开始菜单找到 "OpenClaw 会话查看器"。

### 代码签名 (强烈推荐)

未签名的 .exe 会被 Windows Defender SmartScreen 拦截。

```powershell
# 用 EV 代码签名证书(SignTool)
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a `
  "src-tauri\target\release\OpenClaw Session Viewer.exe"

# 用 .pfx 文件
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 `
  /f path\to\cert.pfx /p "password" `
  "src-tauri\target\release\OpenClaw Session Viewer.exe"
```

---

## 跨平台问题排查

| 问题 | 解决方案 |
|---|---|
| macOS: 窗口空白 | 用 .app bundle 启动,不要裸二进制 |
| Linux: 缺 webkit2gtk-4.1 | 见上面前置安装步骤 |
| Windows: WebView2 缺失 | 安装 [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) |
| 路径中文乱码 | Tauri 2 默认 UTF-8,确认终端 LANG=en_US.UTF-8 |
| 跨平台构建结果大小差异 | macOS 自带 WebKit 系统库所以小(~5MB),Windows 内嵌 WebView2(~7MB),Linux 内嵌 WebKitGTK(~9MB) |

---

## GitHub Actions 自动构建

见 `.github/workflows/release.yml`。触发条件:`push tag v*` → 三平台并行构建 → 上传 artifacts → 创建 GitHub Release。