# FalconMM v0.4.0 · Release Notes

## 简体中文

**本次更新**

1. **11 种界面语言**：简体中文 / 繁體中文 / English / 日本語 / 한국어 / Français / Deutsch / Español / Português / Русский / العربية。安装后默认跟随系统语言，可在「设置 → 通用与更新」随时切换；阿拉伯语为从右到左布局。
2. **自动更新**：应用会检查本发布库的最新版本（可在设置关闭自动检查）。Windows 下载后静默升级（保留数据）；macOS 下载后打开 DMG 拖入「应用程序」完成更新。
3. **浏览器插件新增 5 个国际站点**：YouTube、TikTok、X (Twitter)、Instagram、Vimeo —— 插件解析地址，Falcon 桌面端带 Referer 下载入库；YouTube 优先合并轨直链、分离轨自动无损合并音视频。这些站点需要你的网络可以访问；解析失败会给出具体原因。
4. **插件源码开放**：本仓库 `extension-source/` 目录提供插件完整源码与开发者指南（DEVELOPER.md）。开发者只需在插件里注册新站点，握手时会自动上报桌面端放行下载，无需改动桌面端。
5. 常规修复与体验优化（预览 Range 支持、右键菜单、第三方素材库导入等，详见使用说明）。

**安装包**：`FalconMM-0.4.0-arm64.dmg`（Apple 芯片）/ `FalconMM-0.4.0-x64.dmg`（Intel）/ `FalconMM-Setup-0.4.0.exe`（Windows x64）/ `FalconMM-Extension-0.4.0.zip`（解压加载）。

macOS 包未公证：首次打开请右键 → 打开。

## English

**Highlights**

1. **11 interface languages**: 简体中文 / 繁體中文 / English / 日本語 / 한국어 / Français / Deutsch / Español / Português / Русский / العربية. Follows the system language by default; switch any time in Settings → General & Updates. Arabic ships with a right-to-left layout.
2. **Auto-update**: the app checks this release repository for new versions (auto-check can be disabled). Windows installs silently in place after download; macOS opens the downloaded DMG for a drag-to-Applications update.
3. **5 new international sites in the browser extension**: YouTube, TikTok, X (Twitter), Instagram, Vimeo — the extension resolves media URLs, Falcon downloads with proper Referer and imports into the library; YouTube progressive streams are preferred and separate video/audio tracks are losslessly remuxed. These sites require reachable network conditions; failures always come back with a specific reason.
4. **Extension source code published**: `extension-source/` in this repository contains the full extension source and a developer guide (DEVELOPER.md). Developers add sites in the extension only — new sites are auto-registered with the desktop app during handshake.
5. Usual fixes and polish (HTTP Range preview support, context menu, third-party library import, etc.).

**Artifacts**: `FalconMM-0.4.0-arm64.dmg` (Apple silicon) / `FalconMM-0.4.0-x64.dmg` (Intel) / `FalconMM-Setup-0.4.0.exe` (Windows x64) / `FalconMM-Extension-0.4.0.zip` (load unpacked).

The macOS build is not notarized: right-click → Open on first launch.
