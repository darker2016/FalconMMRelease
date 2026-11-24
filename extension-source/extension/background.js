// FalconMM Inbox — MV3 service worker
// 只做采集：把当前页图片/视频经 Native Messaging + 本机 IPC 送进桌面端 Inbox。
// 插件侧不判重（没有读库能力）；判重只在桌面端落库链路做一次。
//
// 脚本下载桥：用户安装 Tampermonkey + B 站/抖音/小红书下载脚本后，脚本负责解析与下载；
// 本扩展只监听 Chrome 下载完成事件，把「已完成文件的绝对路径」交给桌面端导入 Inbox。
// 不读取文件内容、不把文件经浏览器上传。

import {
  MAX_DOWNLOAD_BYTES,
  SITES,
  isMediaDownload,
  siteOfDownload,
  siteOfUrl,
  shouldImportDownload
} from './lib/sites.mjs'

const HOST = 'com.falconmm.inbox'
const CHUNK = 512 * 1024


/** 分块转 base64：避免 String.fromCharCode(...bigArray) 的参数上限导致栈溢出。 */
function toBase64(view) {
  let binary = ''
  const STEP = 0x8000
  for (let i = 0; i < view.length; i += STEP) {
    binary += String.fromCharCode.apply(null, view.subarray(i, Math.min(view.length, i + STEP)))
  }
  return btoa(binary)
}

const MAX_ITEM = 200 * 1024 * 1024
const QUEUE_MAX_ITEMS = 50
const QUEUE_MAX_BYTES = 2 * 1024 * 1024 * 1024
const QUEUE_TTL = 7 * 24 * 3600 * 1000
const PATH_QUEUE_MAX_ITEMS = 50
const PATH_QUEUE_TTL = 7 * 24 * 3600 * 1000
const RECENT_IMPORTS_MAX = 20

const state = {
  queue: [],
  token: null,
  lastWriteAt: null,
  ledger: null,
  missing: null,
  autoImport: true,
  pathQueue: [],
  recentImports: [],
  importedDownloadIds: []
}

async function storageGet(keys) {
  return chrome.storage.local.get(keys)
}
async function storageSet(obj) {
  return chrome.storage.local.set(obj)
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('falconmm-queue', 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'transferId' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function dbPut(entry) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('items', 'readwrite')
    tx.objectStore('items').put(entry)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
async function dbAll() {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('items', 'readonly')
    const req = tx.objectStore('items').getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
async function dbDelete(ids) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('items', 'readwrite')
    for (const id of ids) tx.objectStore('items').delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function loadQueue() {
  const data = await storageGet([
    'queue',
    'token',
    'lastWriteAt',
    'ledger',
    'autoImport',
    'pathQueue',
    'recentImports',
    'importedDownloadIds'
  ])
  state.queue = data.queue || []
  state.token = data.token || null
  state.lastWriteAt = data.lastWriteAt || null
  state.ledger = data.ledger || null
  state.autoImport = data.autoImport !== false
  state.pathQueue = Array.isArray(data.pathQueue) ? data.pathQueue : []
  state.recentImports = Array.isArray(data.recentImports) ? data.recentImports : []
  state.importedDownloadIds = Array.isArray(data.importedDownloadIds) ? data.importedDownloadIds : []
  const actual = await dbAll()
  const actualIds = new Set(actual.map((a) => a.transferId))
  const missing = state.queue.filter((q) => !actualIds.has(q.transferId))
  state.missing = missing.length > 0 ? { before: state.queue.length, after: actual.length } : null
  if (missing.length > 0) {
    // 账实不符：不重试已消失项，只更新账本并如实告知
    state.queue = state.queue.filter((q) => actualIds.has(q.transferId))
    await saveQueue()
  }
  return state.queue
}

async function saveQueue() {
  const totalBytes = state.queue.reduce((sum, q) => sum + (q.size || 0), 0)
  state.lastWriteAt = new Date().toISOString()
  await storageSet({
    queue: state.queue,
    lastWriteAt: state.lastWriteAt,
    ledger: { count: state.queue.length, totalBytes, lastWriteAt: state.lastWriteAt }
  })
  updateBadge()
}

function updateBadge() {
  const n = state.queue.length + state.pathQueue.length
  chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' }).catch(() => undefined)
  chrome.action.setBadgeBackgroundColor({ color: '#C6A15B' }).catch(() => undefined)
}

async function saveDownloaderState() {
  const cutoff = Date.now() - PATH_QUEUE_TTL
  state.pathQueue = state.pathQueue
    .filter((entry) => Number(entry.queuedAt || 0) >= cutoff)
    .slice(-PATH_QUEUE_MAX_ITEMS)
  state.recentImports = state.recentImports.slice(0, RECENT_IMPORTS_MAX)
  state.importedDownloadIds = state.importedDownloadIds.slice(-200)
  await storageSet({
    autoImport: state.autoImport,
    pathQueue: state.pathQueue,
    recentImports: state.recentImports,
    importedDownloadIds: state.importedDownloadIds
  })
  updateBadge()
}

function baseName(path) {
  return String(path || '').split(/[\\/]/).pop() || 'download'
}

function recordRecent(entry) {
  state.recentImports.unshift({
    id: `${entry.downloadId ?? 'manual'}-${Date.now()}`,
    downloadId: entry.downloadId,
    fileName: entry.fileName || '',
    site: entry.site || null,
    status: entry.status || 'ok',
    reason: entry.reason || '',
    assetId: entry.assetId,
    at: new Date().toISOString()
  })
  state.recentImports = state.recentImports.slice(0, RECENT_IMPORTS_MAX)
}

async function sha256(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function ulid() {
  const t = Date.now().toString(32).toUpperCase().padStart(10, '0')
  const r = crypto.getRandomValues(new Uint8Array(16))
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  return t + [...r].map((b) => alphabet[b % 32]).join('')
}

function guessName(url, kind, mime) {
  try {
    const u = new URL(url)
    const base = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '')
    if (base && base.includes('.')) return base.slice(0, 120)
  } catch {}
  const ext = mime.includes('webm') ? 'webm' : mime.includes('mp4') ? 'mp4' : mime.includes('png') ? 'png' : 'jpg'
  return `${kind}-${ulid().slice(-8)}.${ext}`
}

function kindOfMime(mime) {
  return mime.startsWith('video/') ? 'video' : 'image'
}

async function fetchBytes(url) {
  const res = await fetch(url, { credentials: 'omit', cache: 'force-cache' })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  const blob = await res.blob()
  if (blob.size > MAX_ITEM) throw new Error(`单件超过 200 MB 上限（${Math.round(blob.size / 1024 / 1024)} MB）`)
  const mime = blob.type || res.headers.get('content-type') || 'application/octet-stream'
  const buffer = await blob.arrayBuffer()
  return { buffer, mime, size: buffer.byteLength }
}

/* ---------------- Native Messaging ---------------- */

function createNativeSession() {
  const port = chrome.runtime.connectNative(HOST)
  const waiters = []
  let dead = false
  let deadError = null

  port.onMessage.addListener((msg) => {
    for (let i = 0; i < waiters.length; i++) {
      const w = waiters[i]
      if (w.types.includes(msg.type)) {
        waiters.splice(i, 1)
        clearTimeout(w.timer)
        w.resolve(msg)
        return
      }
    }
  })
  port.onDisconnect.addListener(() => {
    dead = true
    deadError = chrome.runtime.lastError?.message || '本地应用未运行'
    while (waiters.length > 0) {
      const w = waiters.shift()
      clearTimeout(w.timer)
      w.reject(Object.assign(new Error(deadError), { code: 50304 }))
    }
  })

  return {
    port,
    send(frame) {
      port.postMessage(frame)
    },
    waitFor(types, timeoutMs = 180000) {
      if (dead) return Promise.reject(Object.assign(new Error(deadError), { code: 50304 }))
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error('本地应用响应超时'), { code: 50304 })), timeoutMs)
        waiters.push({ types, resolve, reject, timer })
      })
    },
    close() {
      try {
        port.disconnect()
      } catch {}
    }
  }
}

/** 握手成功后上报插件站点目录：桌面端把未知 key 合并为「自建站点」下载白名单（内置站点不可覆盖）。 */
function registerSites(session) {
  try {
    session.send({
      type: 'register_sites',
      protocolVersion: 1,
      data: {
        sites: Object.values(SITES).map((site) => ({
          key: site.key,
          label: site.label,
          origin: site.origin,
          hosts: site.hosts
        }))
      },
      code: 0,
      message: '',
      traceId: ulid()
    })
  } catch {
    // 上报失败不影响会话：桌面端保留上次合并结果
  }
}

async function handshake(session, pairCode, timeoutMs = 15000) {
  if (pairCode) {
    session.send({
      type: 'pair_request',
      protocolVersion: 1,
      data: { code: pairCode, browser: 'chrome', extensionVersion: chrome.runtime.getManifest().version },
      code: 0,
      message: '',
      traceId: ulid()
    })
    const res = await session.waitFor(['pair_ok', 'error'], timeoutMs)
    if (res.type === 'error') throw Object.assign(new Error(res.message), { code: res.code })
    registerSites(session)
    return res.data.token
  }
  if (!state.token) throw Object.assign(new Error('尚未配对'), { code: 40304 })
  session.send({
    type: 'hello',
    protocolVersion: 1,
    data: { token: state.token, browser: 'chrome', extensionVersion: chrome.runtime.getManifest().version },
    code: 0,
    message: '',
    traceId: ulid()
  })
  const res = await session.waitFor(['hello_ack', 'error'], timeoutMs)
  if (res.type === 'error') throw Object.assign(new Error(res.message), { code: res.code })
  registerSites(session)
}

async function sendOne(session, item, bytes, captureMethod) {
  const transferId = ulid()
  const mime = bytes.mime
  const kind = kindOfMime(mime)
  const hash = await sha256(bytes.buffer)
  const frameBase = {
    protocolVersion: 1,
    code: 0,
    message: '',
    traceId: ulid()
  }
  session.send({
    ...frameBase,
    type: 'capture_begin',
    data: {
      transferId,
      kind,
      sourceUrl: item.url,
      sourceOrigin: new URL(item.url).origin,
      pageTitle: item.pageTitle || '',
      captureMethod,
      capturedAt: new Date().toISOString(),
      mime,
      totalBytes: bytes.size,
      sha256: hash,
      suggestedName: item.name || guessName(item.url, kind, mime),
      durationMs: item.durationMs
    }
  })
  const total = Math.ceil(bytes.size / CHUNK)
  for (let seq = 0; seq < total; seq++) {
    const start = seq * CHUNK
    const len = Math.min(bytes.size, start + CHUNK) - start
    // 不要用 String.fromCharCode(...view)：512KB 展开成 50 万个参数会爆栈
    // （Maximum call stack size exceeded）。按 32KB 分批拼接。
    const b64 = toBase64(new Uint8Array(bytes.buffer, start, len))
    session.send({
      ...frameBase,
      type: 'capture_chunk',
      data: { transferId, seq, total, chunkBase64: b64 }
    })
  }
  session.send({
    ...frameBase,
    type: 'capture_end',
    data: { transferId, receivedBytes: bytes.size }
  })
  const result = await session.waitFor(['capture_result', 'error'], 180000)
  if (result.type === 'error') throw Object.assign(new Error(result.message), { code: result.code })
  return { ...result.data, sha256: hash, mime, kind }
}

/* ---------------- Queue ---------------- */

async function enqueue(item, bytes, hash, captureMethod) {
  const now = new Date().toISOString()
  state.queue = state.queue.filter((q) => Date.now() - new Date(q.queuedAt).getTime() < QUEUE_TTL)
  let dropped = 0
  while (
    state.queue.length >= QUEUE_MAX_ITEMS ||
    state.queue.reduce((s, q) => s + (q.size || 0), 0) + bytes.size > QUEUE_MAX_BYTES
  ) {
    if (state.queue.length === 0) break
    const oldest = state.queue.shift()
    await dbDelete([oldest.transferId]).catch(() => undefined)
    dropped += 1
  }
  const transferId = ulid()
  const meta = {
    transferId,
    url: item.url,
    name: item.name || guessName(item.url, 'image', bytes.mime),
    size: bytes.size,
    mime: bytes.mime,
    sha256: hash,
    kind: kindOfMime(bytes.mime),
    sourceOrigin: new URL(item.url).origin,
    pageTitle: item.pageTitle || '',
    captureMethod,
    capturedAt: now,
    queuedAt: now,
    durationMs: item.durationMs
  }
  await dbPut({ transferId, blob: new Blob([bytes.buffer], { type: bytes.mime }), meta })
  state.queue.push(meta)
  await saveQueue()
  void reportQueueStatus()
  return { queued: true, transferId, dropped }
}

async function reportQueueStatus() {
  if (!state.token) return
  const session = createNativeSession()
  try {
    await handshake(session)
    session.send({
      type: 'queue_status',
      protocolVersion: 1,
      code: 0,
      message: '',
      traceId: ulid(),
      data: {
        count: state.queue.length + state.pathQueue.length,
        totalBytes:
          state.queue.reduce((sum, q) => sum + (q.size || 0), 0) +
          state.pathQueue.reduce((sum, q) => sum + (q.fileSize || 0), 0),
        lastWriteAt: state.lastWriteAt
      }
    })
    await new Promise((r) => setTimeout(r, 120))
  } catch {
    // 应用未运行时不打扰用户；弹窗会按 L2/L3 状态如实显示
  } finally {
    session.close()
  }
}

async function syncQueue(sendProgress) {
  if (!state.token || state.queue.length === 0) return { ok: true, synced: 0, duplicates: 0, failed: 0 }
  const session = createNativeSession()
  try {
    await handshake(session)
    let synced = 0
    let duplicates = 0
    let failed = 0
    for (const meta of [...state.queue]) {
      try {
        const entry = (await dbAll()).find((e) => e.transferId === meta.transferId)
        if (!entry) {
          // 条目已被浏览器清理：不重试，直接从账本移除
          state.queue = state.queue.filter((q) => q.transferId !== meta.transferId)
          await saveQueue()
          continue
        }
        const buffer = await entry.blob.arrayBuffer()
        const result = await sendOne(
          session,
          { url: meta.url, name: meta.name, pageTitle: meta.pageTitle, durationMs: meta.durationMs },
          { buffer, mime: meta.mime, size: meta.size },
          meta.captureMethod
        )
        if (result.ok) {
          if (result.duplicate) duplicates += 1
          else synced += 1
          // 同步成功即出队：ok 或 duplicate 都视为同步完成
          await dbDelete([meta.transferId])
          state.queue = state.queue.filter((q) => q.transferId !== meta.transferId)
          await saveQueue()
          sendProgress?.({ step: 'item', transferId: meta.transferId, ok: true, duplicate: Boolean(result.duplicate) })
        } else {
          failed += 1
          sendProgress?.({ step: 'item', transferId: meta.transferId, ok: false, reason: result.reason })
        }
      } catch (e) {
        if (e.code === 50304) throw e
        failed += 1
        sendProgress?.({ step: 'item', transferId: meta.transferId, ok: false, reason: String(e.message || e) })
      }
    }
    return { ok: true, synced, duplicates, failed }
  } finally {
    session.close()
  }
}

/* ---------------- 脚本下载桥 ---------------- */

function entryFromDownload(item, site, sourceOverride) {
  const sourceUrl = String(sourceOverride || item.referrer || item.finalUrl || item.url || SITES[site].origin)
  let sourceOrigin = SITES[site].origin
  try {
    const url = new URL(sourceUrl)
    if (url.protocol === 'http:' || url.protocol === 'https:') sourceOrigin = url.origin
  } catch {
    // blob: 或异常来源回退到站点主域
  }
  return {
    downloadId: item.id,
    path: item.filename,
    fileName: baseName(item.filename),
    mime: item.mime || '',
    fileSize: item.fileSize || 0,
    site,
    sourceUrl,
    sourceOrigin,
    pageTitle: '',
    capturedAt: new Date().toISOString()
  }
}

async function sendImportPath(session, entry) {
  const requestId = `dl-${entry.downloadId ?? Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  session.send({
    type: 'import_path',
    protocolVersion: 1,
    code: 0,
    message: '',
    traceId: ulid(),
    data: { requestId, ...entry }
  })
  const res = await session.waitFor(['import_path_result', 'error'], 180000)
  if (res.type === 'error') {
    throw Object.assign(new Error(res.message || '下载文件导入失败'), { code: res.code || 50304 })
  }
  if (!res.data?.ok) {
    const code = Number(res.code || 0)
    throw Object.assign(new Error(res.data?.reason || res.message || '下载文件导入失败'), {
      code,
      retryable: code === 50304 || code === 40304
    })
  }
  return res.data
}

/**
 * 把页面解析出的媒体 URL 交给 Falcon 桌面端下载。
 * 扩展不再 fetch 媒体字节，避免页面 CORS/CSP 造成 Failed to fetch。
 */
async function sendDownloadUrl(payload) {
  const session = createNativeSession()
  try {
    await handshake(session)
    session.send({
      type: 'download_url',
      protocolVersion: 1,
      code: 0,
      message: '',
      traceId: ulid(),
      data: payload
    })
    // 4K 长视频要下载两条轨再合并，10 分钟不够；放宽到 30 分钟等桌面端完成
    const res = await session.waitFor(['download_url_result', 'error'], 30 * 60 * 1000)
    if (res.type === 'error') {
      throw Object.assign(new Error(res.message || 'Falcon 下载失败'), { code: res.code || 50304 })
    }
    if (!res.data?.ok) {
      throw Object.assign(new Error(res.data?.message || res.message || 'Falcon 下载失败'), {
        code: Number(res.code || 0)
      })
    }
    return res.data
  } finally {
    session.close()
  }
}

function originOfUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
  } catch {
    // 非法来源由应用侧再校验
  }
  return ''
}

function enqueuePath(entry) {
  const duplicate = state.pathQueue.some((e) => e.downloadId === entry.downloadId && e.path === entry.path)
  if (!duplicate) state.pathQueue.push({ ...entry, queuedAt: Date.now() })
}

async function importPathEntry(entry) {
  let session
  try {
    session = createNativeSession()
    await handshake(session)
    const res = await sendImportPath(session, entry)
    recordRecent({ ...entry, status: res.duplicate ? 'duplicate' : 'ok', assetId: res.assetId, reason: res.reason })
    await saveDownloaderState()
    void reportQueueStatus()
    return {
      ok: true,
      assetId: res.assetId,
      inboxItemId: res.inboxItemId,
      duplicate: Boolean(res.duplicate),
      reason: res.reason
    }
  } catch (e) {
    if (e.code === 50304 || e.code === 40304) {
      enqueuePath(entry)
      recordRecent({ ...entry, status: 'queued', reason: e.message })
      await saveDownloaderState()
      void reportQueueStatus()
      return { ok: false, queued: true, code: e.code, message: String(e.message || e) }
    }
    recordRecent({ ...entry, status: 'failed', reason: String(e.message || e) })
    await saveDownloaderState()
    return { ok: false, code: e.code, message: String(e.message || e) }
  } finally {
    try {
      session?.close()
    } catch {}
  }
}

async function handleCompletedDownload(downloadId) {
  if (!state.autoImport) return
  const key = String(downloadId)
  if (state.importedDownloadIds.includes(key)) return
  let item
  try {
    ;[item] = await chrome.downloads.search({ id: downloadId })
  } catch {
    return
  }
  if (!item) return
  const verdict = shouldImportDownload(item, { autoImport: state.autoImport, maxBytes: MAX_DOWNLOAD_BYTES })
  if (!verdict.ok) {
    const site = siteOfDownload(item)
    if (site && !['auto_import_off', 'not_complete', 'not_found', 'site_unrecognized'].includes(verdict.reason)) {
      recordRecent({
        downloadId,
        fileName: baseName(item.filename),
        site,
        status: 'skipped',
        reason: verdict.reason
      })
      await saveDownloaderState()
    }
    return
  }
  state.importedDownloadIds.push(key)
  await saveDownloaderState()
  await importPathEntry(entryFromDownload(item, verdict.site))
}

async function syncPathQueue(sendProgress) {
  if (!state.token || state.pathQueue.length === 0) return { ok: true, synced: 0, duplicates: 0, failed: 0 }
  const session = createNativeSession()
  let synced = 0
  let duplicates = 0
  let failed = 0
  try {
    await handshake(session)
    for (const entry of [...state.pathQueue]) {
      try {
        const res = await sendImportPath(session, entry)
        if (res.duplicate) duplicates += 1
        else synced += 1
        state.pathQueue = state.pathQueue.filter((e) => e !== entry)
        recordRecent({ ...entry, status: res.duplicate ? 'duplicate' : 'ok', assetId: res.assetId, reason: res.reason })
        await saveDownloaderState()
        sendProgress?.({ step: 'path_item', downloadId: entry.downloadId, ok: true, duplicate: Boolean(res.duplicate) })
      } catch (e) {
        if (e.code === 50304 || e.code === 40304) throw e
        failed += 1
        state.pathQueue = state.pathQueue.filter((e) => e !== entry)
        recordRecent({ ...entry, status: 'failed', reason: String(e.message || e) })
        await saveDownloaderState()
        sendProgress?.({ step: 'path_item', downloadId: entry.downloadId, ok: false, reason: String(e.message || e) })
      }
    }
    return { ok: true, synced, duplicates, failed }
  } finally {
    session.close()
  }
}

function downloadSkipReason(reason) {
  return (
    {
      auto_import_off: '自动入库已关闭',
      not_complete: '下载尚未完成',
      not_found: '找不到该下载',
      no_file: '下载文件路径为空',
      file_missing: '下载文件已被移动或删除',
      dangerous: '浏览器将该文件标记为不安全，已跳过',
      not_media: '只自动导入图片/视频；压缩包、分片清单与其它格式请手动处理',
      too_large: '文件超过 4 GB 上限',
      site_unrecognized: '无法识别来源站点',
      duplicate: '内容已在库中'
    }[reason] || '该下载不满足自动入库条件'
  )
}

async function listRecentDownloads() {
  let items = []
  try {
    items = await chrome.downloads.search({ limit: 50, orderBy: ['-startTime'] })
  } catch {
    return []
  }
  const since = Date.now() - PATH_QUEUE_TTL
  return items
    .filter((item) => {
      if (item.state !== 'complete' || item.exists === false || !item.filename) return false
      if (!isMediaDownload(item)) return false
      const started = item.startTime ? Date.parse(item.startTime) : Date.now()
      return !Number.isFinite(started) || started >= since
    })
    .slice(0, 20)
    .map((item) => {
      const record = state.recentImports.find((r) => r.downloadId === item.id)
      return {
        id: item.id,
        fileName: baseName(item.filename),
        site: siteOfDownload(item),
        size: item.fileSize || 0,
        startedAt: item.startTime || '',
        status: record?.status || 'new',
        imported: record?.status === 'ok' || record?.status === 'duplicate'
      }
    })
}

/* ---------------- Page media collection ---------------- */

function collectInPage() {
  const items = []
  const seen = new Set()
  const pageTitle = document.title
  const abs = (u) => {
    try {
      return new URL(u, location.href).href
    } catch {
      return ''
    }
  }
  const add = (url, kind, width, height, durationMs, extra) => {
    if (!url || seen.has(url)) return
    if (!/^https?:/i.test(url)) {
      if (url.startsWith('blob:')) {
        seen.add(url)
        items.push({ url, kind, width, height, durationMs, capturable: false, reason: 'mse_blob', pageTitle, ...extra })
      }
      return
    }
    if (/\.m3u8(\?|$)/i.test(url) || /\.mpd(\?|$)/i.test(url)) {
      seen.add(url)
      items.push({ url, kind, width, height, durationMs, capturable: false, reason: 'hls_manifest', pageTitle, ...extra })
      return
    }
    seen.add(url)
    items.push({ url, kind, width, height, durationMs, capturable: true, pageTitle, ...extra })
  }
  for (const img of document.images) {
    const src = img.currentSrc || img.src
    if (!src) continue
    if (img.naturalWidth > 0 && img.naturalWidth < 48 && img.naturalHeight < 48) continue
    add(abs(src), 'image', img.naturalWidth, img.naturalHeight)
  }
  for (const video of document.querySelectorAll('video')) {
    const src = video.currentSrc || video.src
    const videoMeta = {
      // poster 是普通图片 URL，弹窗可以直接加载；流媒体卡片用它当预览
      poster: video.poster ? abs(video.poster) : '',
      playing: !video.paused && video.currentTime > 0,
      index: items.filter((i) => i.kind === 'video').length
    }
    if (!src) continue
    if (src.startsWith('blob:')) {
      add(src, 'video', video.videoWidth, video.videoHeight, Math.round((video.duration || 0) * 1000), videoMeta)
      continue
    }
    if (video.mediaKeys || (window.MediaKeys && video.mediaKeys)) {
      seen.add(src)
      items.push({ url: src, kind: 'video', capturable: false, reason: 'drm_protected', pageTitle, ...videoMeta })
      continue
    }
    add(abs(src), 'video', video.videoWidth, video.videoHeight, Math.round((video.duration || 0) * 1000), videoMeta)
  }
  return { items, pageTitle, pageUrl: location.href }
}

async function listMedia(tabId) {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: collectInPage })
    const data = results[0]?.result || { items: [], pageTitle: '', pageUrl: '' }
    await enrichMediaWithPageMeta(tabId, data)
    return data
  } catch (e) {
    return { error: 'permission_denied', message: String(e?.message || e) }
  }
}

/**
 * 弹窗预览增强：站点视频的 CDN 直链在弹窗上下文会被拒绝（Referer/Cookie 校验），
 * blob/m3u8 本来也放不了。注入 MAIN world 读封面（普通图片可以直接加载），
 * 按 durationMs 匹配到对应视频卡片，让用户能认出“哪个是哪个”。
 */
async function enrichMediaWithPageMeta(tabId, data) {
  try {
    if (!siteOfUrl(data.pageUrl || '')) return
    const videos = data.items.filter((i) => i.kind === 'video')
    if (videos.length === 0) return
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['lib/native-page.bundle.js']
    })
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => window.__falconPageMeta?.()
    })
    const meta = results?.[0]?.result
    const cover = meta?.cover
    if (!cover?.url || !/^https:/i.test(cover.url)) return
    let target = null
    if (cover.durationMs > 0) {
      target = videos.find((v) => Math.abs((v.durationMs || 0) - cover.durationMs) <= 1500) || null
    }
    if (!target && videos.length === 1) target = videos[0]
    if (!target) target = videos.find((v) => v.playing) || videos[0]
    if (target) target.coverUrl = cover.url
  } catch {
    // 预览增强是尽力而为：注入或读取失败就只显示占位卡片
  }
}

/**
 * 只校验不请求：service worker 的调用链已脱离用户手势，permissions.request 会抛
 * "This function must be called during a user gesture"。授权由 popup / 右键菜单在点击时完成。
 */
async function ensureOrigins(origins) {
  const unique = [...new Set(origins.map((o) => `${new URL(o).origin}/*`))]
  for (const origin of unique) {
    const has = await chrome.permissions.contains({ origins: [origin] })
    if (!has) return { granted: false, origin, needGesture: true }
  }
  return { granted: true }
}

async function captureItems(items, captureMethod, sendProgress, context = {}) {
  const capturable = items.filter((i) => i.capturable !== false)
  const notCapturable = items.filter((i) => i.capturable === false)
  const results = notCapturable.map((i) => ({
    url: i.url,
    ok: false,
    code: 42205,
    reason: i.reason || 'media_not_capturable'
  }))
  // 站点视频的 CDN 直链从扩展 fetch 会被防盗链/CORS 拒绝，改由 Falcon 用 Node 带
  // Referer/UA 下载（download_url），与「直接下载当前视频」同一条链路。
  const isSiteVideo = (item) => item.kind === 'video' && Boolean(siteOfUrl(item.url))
  const routed = capturable.filter(isSiteVideo)
  const direct = capturable.filter((item) => !isSiteVideo(item))

  const perm = await ensureOrigins(direct.map((i) => i.url))
  if (!perm.granted) {
    return {
      ok: false,
      code: 40306,
      message: `未授予 ${perm.origin} 的访问权限，本次抓取未入库。请打开插件弹窗重新点击「抓取到 Falcon」完成授权后重试。`,
      results: []
    }
  }
  if (capturable.length === 0) {
    return { ok: true, results, added: 0, duplicates: 0, offline: false }
  }

  /** 站点视频走 Falcon 下载；返回逐项结果。 */
  async function captureSiteVideo(item) {
    const site = siteOfUrl(item.url)
    const pageUrl = String(context.pageUrl || '')
    const res = await sendDownloadUrl({
      requestId: ulid(),
      site,
      sourceUrl: siteOfUrl(pageUrl) === site ? pageUrl : SITES[site].origin,
      sourceOrigin: SITES[site].origin,
      pageTitle: context.pageTitle || '',
      title: context.pageTitle || '',
      capturedAt: new Date().toISOString(),
      media: [{ url: item.url, kind: item.kind, fileName: item.name || undefined }]
    })
    const file = res.files?.[0]
    return { url: item.url, ok: true, duplicate: Boolean(file?.duplicate), assetId: file?.assetId }
  }

  let session
  try {
    session = createNativeSession()
    await handshake(session)
  } catch (e) {
    // 应用未运行：普通媒体逐项暂存（字节进 IndexedDB）；站点视频没法离线下载，如实报错
    const routedReason = 'Falcon 未运行：站点视频由 Falcon 直接下载入库，请先启动桌面端再抓取'
    for (const item of routed) {
      results.push({ url: item.url, ok: false, reason: routedReason })
    }
    let queued = 0
    for (const item of direct) {
      try {
        const bytes = await fetchBytes(item.url)
        const hash = await sha256(bytes.buffer)
        const r = await enqueue(item, bytes, hash, captureMethod)
        queued += 1
        if (r.dropped > 0) sendProgress?.({ step: 'queue_full', dropped: r.dropped })
      } catch (err) {
        results.push({ url: item.url, ok: false, reason: String(err.message || err) })
      }
    }
    session?.close()
    if (e.code === 40304) {
      state.token = null
      await storageSet({ token: null })
      return { ok: false, code: 40304, message: '需要重新配对', results }
    }
    return {
      ok: true,
      offline: true,
      queued,
      added: 0,
      duplicates: 0,
      message: '本地素材库未运行',
      results
    }
  }

  let added = 0
  let duplicates = 0
  const worklist = [...routed, ...direct]
  try {
    for (let i = 0; i < worklist.length; i++) {
      const item = worklist[i]
      sendProgress?.({ step: 'capture', index: i + 1, total: worklist.length, url: item.url })
      try {
        if (isSiteVideo(item)) {
          const r = await captureSiteVideo(item)
          if (r.duplicate) duplicates += 1
          else added += 1
          results.push(r)
        } else {
          const bytes = await fetchBytes(item.url)
          const res = await sendOne(session, item, bytes, captureMethod)
          if (res.duplicate) duplicates += 1
          else added += 1
          results.push({ url: item.url, ok: true, duplicate: Boolean(res.duplicate), assetId: res.assetId })
        }
      } catch (err) {
        results.push({ url: item.url, ok: false, reason: String(err.message || err), code: err.code })
      }
    }
  } finally {
    session.close()
  }
  return { ok: true, added, duplicates, results, offline: false }
}

/* ---------------- Message routing ---------------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const run = async () => {
    if (message.type === 'status') {
      await loadQueue()
      void reportQueueStatus()
      return {
        tokenSet: Boolean(state.token),
        queue: {
          count: state.queue.length + state.pathQueue.length,
          totalBytes:
            state.queue.reduce((s, q) => s + (q.size || 0), 0) +
            state.pathQueue.reduce((s, q) => s + (q.fileSize || 0), 0),
          lastWriteAt: state.lastWriteAt
        },
        missing: state.missing,
        extensionVersion: chrome.runtime.getManifest().version
      }
    }
    if (message.type === 'verify') {
      await loadQueue()
      if (!state.token) return { ok: false, code: 40304, message: '尚未配对' }
      let session
      try {
        session = createNativeSession()
        // 校验用短超时：应用没开时 host 会立即 disconnect，卡住时 4s 内也能给出结论
        await handshake(session, undefined, 4000)
        return { ok: true }
      } catch (e) {
        return { ok: false, code: e.code || 50304, message: String(e.message || e) }
      } finally {
        try { session?.close() } catch {}
      }
    }
    if (message.type === 'unpair') {
      state.token = null
      await chrome.storage.local.remove('token')
      return { ok: true }
    }
    if (message.type === 'pair') {
      const session = createNativeSession()
      try {
        const token = await handshake(session, String(message.code || ''))
        state.token = token
        await storageSet({ token })
        return { ok: true, token }
      } catch (e) {
        return { ok: false, code: e.code || 40304, message: String(e.message || e) }
      } finally {
        session.close()
      }
    }
    if (message.type === 'list_media') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) return { items: [], error: 'no_active_tab' }
      const data = await listMedia(tab.id)
      return { ...data, tabId: tab.id }
    }
    if (message.type === 'capture_one' || message.type === 'capture_many') {
      const items = message.type === 'capture_one' ? [message.item] : message.items || []
      return captureItems(
        items,
        message.type === 'capture_one' ? 'toolbar' : 'batch',
        (p) => chrome.runtime.sendMessage({ type: 'progress', progress: p }).catch(() => undefined),
        { pageUrl: message.pageUrl, pageTitle: message.pageTitle }
      )
    }
    if (message.type === 'capture') {
      return captureItems(
        message.items || [],
        message.captureMethod || 'toolbar',
        (p) => chrome.runtime.sendMessage({ type: 'progress', progress: p }).catch(() => undefined),
        { pageUrl: message.pageUrl, pageTitle: message.pageTitle }
      )
    }
    if (message.type === 'downloads_status') {
      await loadQueue()
      return {
        autoImport: state.autoImport,
        queueCount: state.pathQueue.length,
        byteQueueCount: state.queue.length,
        recent: state.recentImports.slice(0, 10),
        sites: Object.fromEntries(Object.entries(SITES).map(([key, site]) => [key, { label: site.label, script: site.script, installUrl: site.installUrl }]))
      }
    }
    if (message.type === 'set_auto_import') {
      state.autoImport = Boolean(message.enabled)
      await saveDownloaderState()
      return { ok: true, autoImport: state.autoImport }
    }
    if (message.type === 'list_recent_downloads') {
      await loadQueue()
      return { ok: true, items: await listRecentDownloads() }
    }
    if (message.type === 'import_download') {
      await loadQueue()
      let item
      try {
        ;[item] = await chrome.downloads.search({ id: Number(message.downloadId) })
      } catch {
        item = null
      }
      if (!item || item.state !== 'complete' || !item.filename) {
        return { ok: false, message: '下载尚未完成或文件已不存在，请在浏览器下载列表中确认后重试' }
      }
      const hintSite = SITES[message.siteHint] ? message.siteHint : null
      const pageUrl = String(message.pageUrl || '')
      const pageSite = siteOfUrl(pageUrl)
      const detected = siteOfDownload(item)
      const site = hintSite && pageSite === hintSite ? hintSite : detected || hintSite
      if (!site) {
        return { ok: false, message: '无法识别来源站点：请先在受支持的站点页面打开插件，再点导入' }
      }
      const verdict = shouldImportDownload(item, { autoImport: true, maxBytes: MAX_DOWNLOAD_BYTES })
      if (!verdict.ok && verdict.reason !== 'site_unrecognized') {
        return { ok: false, message: downloadSkipReason(verdict.reason) }
      }
      const sourceOverride = pageSite === site ? pageUrl : undefined
      return importPathEntry(entryFromDownload(item, site, sourceOverride))
    }
    if (message.type === 'native_download') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) return { ok: false, message: '没有活动标签页' }
      const site = siteOfUrl(message.pageUrl || tab.url)
      if (!site) return { ok: false, message: '当前页面不是受支持的站点页面' }
      const attempt = async () => {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          files: ['lib/native-page.bundle.js']
        })
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: () => window.__falconResolveNative?.()
        })
        const resolved = results?.[0]?.result
        if (!resolved) return { ok: false, message: '页面脚本没有返回结果' }
        if (!resolved.ok) return resolved
        if (!Array.isArray(resolved.media) || resolved.media.length === 0) {
          return { ok: false, message: '页面没有解析出可下载的媒体地址' }
        }
        const downloaded = await sendDownloadUrl({
          requestId: ulid(),
          site: resolved.site,
          sourceUrl: resolved.sourceUrl,
          sourceOrigin: originOfUrl(resolved.sourceUrl),
          pageTitle: resolved.pageTitle || '',
          title: resolved.title || '',
          capturedAt: new Date().toISOString(),
          media: resolved.media
        })
        return { ok: true, ...downloaded }
      }
      try {
        const first = await attempt()
        if (first.ok || first.retryable === false) return first
        // 站点签名地址会过期（抖音 biz_sign / CDN l= 参数），失败后重新解析页面数据
        // 再试一次：播放器此时可能已经刷新出新的直链。权限类失败（retryable=false）不重试。
        await new Promise((r) => setTimeout(r, 600))
        const retried = await attempt()
        if (retried.ok || retried.retryable === false) return retried
        return { ok: false, message: `${retried.message}（已自动重试仍失败；请刷新页面后再点下载）` }
      } catch (e) {
        if (e.code === 50304 || e.code === 40304) {
          return {
            ok: false,
            code: e.code,
            message:
              e.code === 40304
                ? 'Falcon 尚未配对：请打开桌面端生成配对码，配对后再下载'
                : 'Falcon 未运行：请先启动桌面端，下载会由 Falcon 执行'
          }
        }
        return { ok: false, message: String(e?.message || e) }
      }
    }
    if (message.type === 'sync') {
      await loadQueue()
      try {
        const res = await syncQueue((p) =>
          chrome.runtime.sendMessage({ type: 'progress', progress: p }).catch(() => undefined)
        )
        const path = await syncPathQueue((p) =>
          chrome.runtime.sendMessage({ type: 'progress', progress: p }).catch(() => undefined)
        )
        return { ...res, pathSynced: path.synced, pathDuplicates: path.duplicates, pathFailed: path.failed }
      } catch (e) {
        return { ok: false, code: e.code || 50304, message: String(e.message || e) }
      }
    }
    if (message.type === 'clear_queue') {
      const ids = state.queue.map((q) => q.transferId)
      await dbDelete(ids)
      state.queue = []
      state.pathQueue = []
      await saveQueue()
      await saveDownloaderState()
      return { ok: true }
    }
    if (message.type === 'remove_queue') {
      const ids = message.ids || []
      await dbDelete(ids)
      state.queue = state.queue.filter((q) => !ids.includes(q.transferId))
      await saveQueue()
      return { ok: true }
    }
    return { ok: false, message: '未知消息' }
  }
  run().then(sendResponse).catch((e) => sendResponse({ ok: false, message: String(e?.message || e) }))
  return true
})

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'falcon-save',
    title: '保存到素材库 Inbox',
    contexts: ['image', 'video']
  })
  chrome.alarms.create('falcon-sync', { periodInMinutes: 1 })
  void chrome.storage.local.get(['autoImport']).then((data) => {
    if (data.autoImport === undefined) return chrome.storage.local.set({ autoImport: true })
    return undefined
  })
  void loadQueue().then(() => updateBadge())
})

chrome.runtime.onStartup.addListener(() => {
  void loadQueue()
})

// 用户脚本（Tampermonkey）触发的下载也走这里：Chrome 只在下载状态变为 complete 时回调。
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current !== 'complete') return
  void loadQueue()
    .then(() => handleCompletedDownload(delta.id))
    .catch(() => undefined)
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'falcon-sync') return
  void (async () => {
    await loadQueue()
    if (!state.token) return
    try {
      if (state.queue.length > 0) {
        await syncQueue((p) => chrome.runtime.sendMessage({ type: 'progress', progress: p }).catch(() => undefined))
      }
      if (state.pathQueue.length > 0) {
        await syncPathQueue((p) => chrome.runtime.sendMessage({ type: 'progress', progress: p }).catch(() => undefined))
      }
    } catch {
      // 应用未运行：保留队列，下一个 alarm 再试
    }
  })()
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'falcon-save') return
  const url = info.srcUrl
  if (!url) return
  // 右键点击也算用户手势，先把该资源 origin 的访问权限拿到，再进入异步抓取链
  try {
    const origin = `${new URL(url).origin}/*`
    const has = await chrome.permissions.contains({ origins: [origin] })
    if (!has) {
      const granted = await chrome.permissions.request({ origins: [origin] })
      if (!granted) return
    }
  } catch {
    // 非 http(s) 或权限不可请求时交给 captureItems 的 42205/40306 分支
  }
  const DRM = /\.m3u8|\.mpd/i.test(url) || url.startsWith('blob:')
  const item = {
    url,
    kind: info.mediaType === 'video' ? 'video' : 'image',
    capturable: !DRM,
    reason: DRM ? (/\.m3u8|\.mpd/i.test(url) ? 'hls_manifest' : 'mse_blob') : undefined,
    pageTitle: tab?.title || ''
  }
  void captureItems(
    [item],
    'context_menu',
    (p) => chrome.runtime.sendMessage({ type: 'progress', progress: p }).catch(() => undefined),
    { pageUrl: tab?.url || '', pageTitle: tab?.title || '' }
  ).catch(() => undefined)
})

void loadQueue().then(() => updateBadge())
