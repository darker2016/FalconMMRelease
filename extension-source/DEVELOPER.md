# FalconMM 浏览器插件 · 开发者指南 / Developer Guide

FalconMM 的浏览器插件（`FalconMM Inbox`）源码完全开放。你可以：

- 自行审阅插件如何解析页面、如何与桌面端通信；
- **新增视频/图片站点**（新增站点的下载域名会由插件自动上报给桌面端放行）；
- 修复解析失效的站点并自行构建、加载。

English summary at the bottom of this document.

---

## 目录结构 / Layout

```
manifest.json            MV3 清单：background service worker + popup，无 content_scripts（按需注入）
background.js            Service Worker：与 Falcon 桌面端通信（Native Messaging）、媒体收集、下载指令
popup.html / popup.css / popup.js    弹窗 UI（媒体卡片、下载器、配对状态）
content.js               遗留文件（当前未被 manifest 引用，保留供参考）
icons/                   扩展图标
src/native-page.js       注入页面 MAIN world 的解析入口（esbuild 打包为 lib/native-page.bundle.js）
lib/sites.mjs            站点注册表：页面/CDN 域名、展示名、Tampermonkey 兜底脚本信息
lib/native-adapters.mjs  站点解析的纯函数库（页面注入脚本与单元测试共用）
lib/native-adapters.d.mts 上述库的 TypeScript 声明
lib/native-page.bundle.js 构建产物（由 scripts/build-extension-native.mjs 生成，入库存档）
```

## 通信架构 / How it works

```
浏览器页面 ── MAIN world 注入 ──> __falconResolveNative()（站点解析，只取地址不下载字节）
        │
        ▼
background.js ── Native Messaging（unix socket / named pipe）──> FalconMM 桌面端
        │                                                       ├─ 校验来源站点与 CDN 域名
        │                                                       ├─ Node 直接下载（带 Referer）
        │                                                       └─ DASH 音视频轨 mediabunny 无损合并
        ▼                                                   └─ 入库到收件箱 Inbox
```

- 插件**只解析地址**；下载与入库全部由桌面端执行（不受页面 CORS 限制，可带 Referer）。
- 配对：`pair_request`（配对码换 token）/ `hello`（token 校验），握手成功后插件发送
  `register_sites` 上报站点目录（见下文「新增站点」第 5 步）。
- 上传：普通图片走 `capture_begin/chunk/end` 字节通道；站点视频走 `download_url`
  消息（桌面端下载后回 `download_url_result`）。

## 新增站点 / Adding a new site

以 `example` 为例，共 6 步：

1. **`lib/sites.mjs`：注册站点。**
   ```js
   example: {
     key: 'example',
     label: 'Example',
     script: '',            // 没有稳定的 Tampermonkey 兜底脚本就留空，popup 会跳过脚本行
     installUrl: '',
     tampermonkeyUrl: '',
     origin: 'https://www.example.com',
     hosts: [
       'example.com',            // 页面域名（必需）
       'cdn.example.net',        // CDN 域名（必需：媒体直链的归属判定靠它）
       'vod.example-static.com'  // 其他视频/图片域
     ]
   }
   ```
   `hosts` 必须覆盖**页面域名 + 全部媒体 CDN 域名**；桌面端按后缀匹配判定归属。

2. **`lib/native-adapters.mjs`：写纯解析函数**（不碰 `chrome.*`，输入是已取到的 JSON，输出
   `{ ok, reason?, title, kind: 'video'|'images', media: [{ url, kind, role? }] }`）。
   参考同文件里 `parseTikTokItemStruct` / `parseVimeoConfig` 的写法。`role: 'video'|'audio'`
   用于分离轨（桌面端会用 mediabunny 无损合并成 MP4）。

3. **`src/native-page.js`：写 resolver** 并挂进 `window.__falconResolveNative` 的 hostname 路由：
   ```js
   async function resolveExample() {
     // 读页面内嵌 JSON / 站点自己的 API（页面上下文 fetch 无 CORS 阻碍）
     const parsed = parseExampleState(window.__EXAMPLE_STATE__)
     if (!parsed.ok) throw new Error('具体原因 + 下一步动作')
     const title = parsed.title || 'example'
     return { ok: true, site: 'example', title, kind: parsed.kind,
              sourceUrl: location.href, pageTitle: document.title,
              media: mediaWithNames(title, parsed.media) }
   }
   ```
   若希望弹窗卡片显示封面，再往 `window.__falconPageMeta` 加一个 host 分支。

4. **测试**：`tests/domain/native-adapters.test.ts` 加 JSON fixture 用例；
   `tests/domain/extension-sites.test.ts` 加域名识别断言。仓库根目录运行 `npm run test:fast`。

5. **桌面端放行**：无需任何桌面端配置——插件握手成功后会自动发送 `register_sites`，
   把 `sites.mjs` 里桌面端不认识的 key 作为「自建站点」合并进下载白名单并持久化
   （内置站点 key 不允许覆盖；自建站点最多 16 个、每站最多 64 个域名，只接受 https origin）。

6. **构建与加载**：
   ```bash
   npm install            # 只需一次
   npm run build:extension  # 重新生成 lib/native-page.bundle.js（改了 src/native-page.js 必须重跑）
   ```
   然后在 `chrome://extensions` 打开「开发者模式」→「加载已解压的扩展程序」→ 选择本目录
   （或先 `zip -r FalconMM-Extension.zip extension -x '*.DS_Store'` 再解压加载）。
   改动后点扩展卡片上的「重新加载」，并重启一次 FalconMM 让桌面端重新握手。

## 开发约束 / Conventions

- `lib/*.mjs` 保持纯函数：不 import `chrome.*`、不写 DOM；MV3 service worker 与 popup 直接
  `import` 原生 ESM，不经打包。
- 站点错误消息写「具体原因 + 下一步动作」（例：「该视频需要登录观看…请在浏览器登录后重试」），
  权限类失败给 error 标记 `retryable = false`，避免上层反复重试。
- 不逆向站点签名/DRM：`signatureCipher`、Widevine、DRM 站点一律明确提示边界而不是绕过。
- `manifest.json` 的固定 `key` 决定扩展 ID（`jmemnojjfegagbnnimmjedldjjbjiddd`）；改动会丢失
  用户已授权的站点权限与配对，非必要不要动。

## 本地校验 / Verify

```bash
npm run test:fast         # 站点识别 + 解析器单测（vitest）
npm run build:extension   # 重新打包 MAIN world 脚本
```

---

## English summary

**FalconMM Inbox** is the browser extension of FalconMM, a local-first media library.
The extension only *resolves* media URLs on supported pages; the desktop app downloads them
(Node, with proper Referer), losslessly remuxes DASH video+audio via mediabunny, and imports
everything into the Inbox.

To add a site:

1. Register the site (page + all CDN hosts) in `lib/sites.mjs`.
2. Add a pure parser in `lib/native-adapters.mjs` (input: page JSON; output: `{ ok, title, kind, media }`).
3. Add a resolver in `src/native-page.js` and route its hostname in `__falconResolveNative`.
4. Add unit tests (`tests/domain/*`), then `npm run test:fast`.
5. Nothing to configure on the desktop side: after a successful handshake the extension sends
   `register_sites` and the desktop app merges unknown site keys into its download allowlist
   (built-in site keys cannot be overridden; max 16 custom sites / 64 hosts each; https origins only).
6. `npm run build:extension`, then load the folder as an unpacked extension
   (`chrome://extensions` → Developer mode → Load unpacked).

House rules: keep `lib/*.mjs` pure (no `chrome.*`, no DOM); error messages must state the cause
and the next action; no signature/DRM circumvention — fail with a clear message instead.
