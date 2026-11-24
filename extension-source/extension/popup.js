// P8 插件弹窗：主态 / 批量 / 暂存与同步结果 / 不可抓 / 未授权 / 配对 / 视频下载器
import { SITES, drmSiteLabel, drmSiteOfUrl, hostOfUrl, siteLabel, siteOfUrl } from './lib/sites.mjs'

const els = {
  content: document.getElementById('content'),
  actions: document.getElementById('actions'),
  connDot: document.getElementById('connDot'),
  connText: document.getElementById('connText'),
  origin: document.getElementById('origin'),
  counts: document.getElementById('counts'),
  queueWarn: document.getElementById('queueWarn'),
  downloader: document.getElementById('downloader'),
  gear: document.getElementById('gear'),
  close: document.getElementById('close')
}

const state = {
  status: null,
  media: [],
  pageInfo: {},
  selected: new Set(),
  mode: 'loading',
  progress: null,
  result: null,
  error: null,
  pairingError: null,
  info: false,
  hostDown: false,
  downloader: { autoImport: true, queueCount: 0, byteQueueCount: 0, recent: [] },
  recentDownloads: [],
  native: { busy: false, result: null }
}

const send = (message) => chrome.runtime.sendMessage(message)

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v
    else if (k === 'text') el.textContent = v
    else if (k === 'html') el.innerHTML = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    // 布尔属性必须走 setAttribute/removeAttribute：setAttribute('disabled', false)
    // 会生成 disabled="false"，浏览器仍视为禁用（曾导致「一次加入 Inbox」永远灰）
    else if (v === true) el.setAttribute(k, '')
    else if (v === false || v === undefined || v === null) el.removeAttribute(k)
    else el.setAttribute(k, v)
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue
    el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return el
}

function setMode(mode) {
  state.mode = mode
  render()
}

function render() {
  const s = state.status
  const paired = Boolean(s?.tokenSet)
  els.connDot.className = `dot ${paired ? 'ok' : 'bad'}`
  els.connText.textContent = paired ? '已配对' : '未配对'
  els.origin.textContent = state.pageInfo.pageUrl ? new URL(state.pageInfo.pageUrl).host : '当前页面'
  const images = state.media.filter((m) => m.kind === 'image').length
  const videos = state.media.filter((m) => m.kind === 'video').length
  const currentSite = siteOfUrl(state.pageInfo.pageUrl || '')
  const drmSite = drmSiteOfUrl(state.pageInfo.pageUrl || '')
  els.counts.textContent =
    state.mode === 'downloader'
      ? currentSite
        ? `当前页面：${SITES[currentSite].label}`
        : `支持 ${Object.keys(SITES).length} 个站点直接下载`
      : state.media.length
        ? `本页 ${images} 张图片 · ${videos} 个视频${drmSite ? ` · ${drmSiteLabel(drmSite)}（DRM）` : ''}`
        : state.mode === 'loading'
          ? '正在读取当前页…'
          : '本页没有可抓取的图片或视频。换个标签页试试。'

  const q = s?.queue
  if (q && q.count > 0) {
    els.queueWarn.hidden = false
    els.queueWarn.textContent = `已暂存待同步 ${q.count} 项（${Math.round((q.totalBytes || 0) / 1024 / 1024 * 10) / 10} MB，上限 50 项 / 2 GB / 7 天）。暂存项存于浏览器本地，清理浏览器数据会丢失，建议尽快启动本地应用完成同步。`
  } else {
    els.queueWarn.hidden = true
  }

  els.content.replaceChildren()
  els.actions.replaceChildren()

  if (state.mode === 'loading') {
    els.content.appendChild(h('div', { class: 'center' }, '正在读取当前页…'))
    return
  }
  if (state.mode === 'pairing') {
    renderPairing()
    return
  }
  if (state.mode === 'info') {
    els.content.appendChild(
      h(
        'div',
        { class: 'list' },
        h('div', { class: 'rowitem' }, '在桌面应用打开：设置 → 浏览器插件'),
        h('div', { class: 'rowitem' }, '可以生成配对码、查看暂存队列、撤销站点授权、断开所有插件。'),
        h('div', { class: 'rowitem' }, '插件只做采集；整理、打标签、归档都在桌面端完成。'),
        h(
          'p',
          { class: 'hintline' },
          '本扩展申请 8 项权限：unlimitedStorage 仅解除暂存容量限制；downloads 仅在「自动收进 Inbox」开启时读取已完成下载的文件名/来源，用于导入，不读取文件内容。'
        )
      )
    )
    els.actions.appendChild(
      h('button', {
        class: 'btn secondary',
        text: '重新配对（清除本机配对信息）',
        onclick: async () => {
          try {
            await send({ type: 'unpair' })
          } catch {}
          state.status = { ...(state.status || {}), tokenSet: false }
          state.pairingError = '已清除本机配对信息，请输入新的配对码'
          setMode('pairing')
        }
      })
    )
    els.actions.appendChild(h('button', { class: 'btn secondary', text: '返回', onclick: () => setMode('main') }))
    return
  }
  if (state.mode === 'downloader') {
    renderDownloader()
    return
  }
  if (state.mode === 'progress') {
    const p = state.progress || {}
    els.content.appendChild(
      h(
        'div',
        { class: 'center' },
        h('div', { class: 'mono', text: p.step === 'capture' ? `写入中 ${p.index} / ${p.total}` : '传输中…' }),
        h('div', { text: '正在送入本地 Inbox，可以等它完成' })
      )
    )
    return
  }
  if (state.mode === 'result') {
    renderResult()
    return
  }
  if (state.mode === 'offline') {
    renderOffline()
    return
  }
  if (state.mode === 'permission') {
    els.content.appendChild(
      h(
        'div',
        { class: 'list' },
        h('div', { class: 'rowitem bad' }, '当前标签页未授权，读不到本页素材'),
        h('div', { class: 'rowitem' }, '恢复路径：扩展设置 → 站点访问 → 允许本页，然后重新尝试。'),
        h('div', { class: 'rowitem' }, state.error || '本次未入库，也没有保存链接。')
      )
    )
    els.actions.appendChild(
      h('button', { class: 'btn primary', text: '重新尝试抓取', onclick: () => doCapture('toolbar') })
    )
    els.actions.appendChild(
      h('button', {
        class: 'btn secondary',
        text: '打开扩展管理页',
        onclick: () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })
      })
    )
    return
  }
  if (state.mode === 'notCapturable') {
    const n = state.native || {}
    const drmSite = drmSiteOfUrl(state.pageInfo.pageUrl || '')
    const canNative = Boolean(currentSite)
    if (drmSite) {
      // 商业流媒体是 DRM 加密流：明确告知不绕过，并给出可执行的替代动作（录屏）
      els.content.appendChild(
        h(
          'div',
          { class: 'center' },
          h('div', { class: 'bad', text: `${drmSiteLabel(drmSite)} 的视频受 DRM 保护，插件不抓取也不解密` }),
          h('div', { text: '这些站点把音视频加密后交给播放器解密，任何「下载」都需要破解 DRM，插件不会做这件事——脚本同样不行。' }),
          h('div', { text: '需要留档请在桌面端录屏：⌘/Ctrl+Shift+K 框选画面（可录系统声音），录完直接进 Inbox。' }),
          h('div', { text: '本页图片（封面、剧照、海报）不受影响，仍可正常勾选抓取。' })
        )
      )
      els.actions.appendChild(
        h('button', {
          class: 'btn primary',
          text: '返回（可抓本页图片）',
          onclick: () => setMode('main')
        })
      )
      els.actions.appendChild(
        h('button', {
          class: 'btn secondary',
          text: '打开视频下载器（多站点直接下载）',
          onclick: () => openDownloader()
        })
      )
      return
    }
    els.content.appendChild(
      h(
        'div',
        { class: 'center' },
        h(
          'div',
          { class: canNative ? '' : 'bad', text: canNative ? '这个视频是流媒体播放，但可以直接下载' : '该视频是流媒体分片或受 DRM 保护，插件无法直接抓取' }
        ),
        canNative
          ? h(
              'div',
              { text: `插件已接入 ${SITES[currentSite].label} 原生下载：读取当前页面的播放数据，交给 Falcon 直接下载并加入 Inbox。` }
            )
          : h('div', { text: '页面播放器只暴露 m3u8 清单或 blob 流，没有可下载的完整文件。' }),
        canNative
          ? h('div', { text: '如果原生下载失败（页面数据缺失 / 站点限制），再装对应脚本兜底；录屏是最后的兜底。' })
          : h('div', { text: '可以安装 Tampermonkey 与对应脚本，或使用桌面端录屏。' }),
        n.busy ? h('div', { class: 'mono', text: '正在读取页面数据并下载…' }) : null,
        n.result?.ok
          ? h('div', { class: 'ok', text: nativeResultText(n.result) })
          : null,
        n.result && !n.result.ok ? h('div', { class: 'bad', text: n.result.message }) : null
      )
    )
    els.actions.appendChild(
      h('button', {
        class: 'btn primary',
        text: n.busy ? '下载中…' : canNative ? '直接下载当前视频' : '打开视频下载器',
        disabled: Boolean(n.busy),
        onclick: () => (canNative ? void nativeDownload() : openDownloader())
      })
    )
    els.actions.appendChild(
      h('button', {
        class: 'btn secondary',
        text: canNative ? '安装脚本兜底' : '返回',
        onclick: () => (canNative ? openDownloader() : setMode('main'))
      })
    )
    return
  }
  if (state.mode === 'l3') {
    els.content.appendChild(
      h(
        'div',
        { class: 'list' },
        h('div', { class: 'rowitem bad' }, '本地组件未安装 / 通道不可用，本次抓取未入库'),
        h('div', { class: 'rowitem' }, '不建素材记录，也不保存链接。安装本地组件后即可恢复 L1 原生抓取。'),
        h('div', { class: 'rowitem' }, state.error || '')
      )
    )
    els.actions.appendChild(
      h('button', {
        class: 'btn secondary',
        text: '复制页面链接（仅剪贴板）',
        onclick: async () => {
          await navigator.clipboard.writeText(state.pageInfo.pageUrl || '')
        }
      })
    )
    return
  }

  renderMain()
}

function openDownloader() {
  state.mode = 'downloader'
  state.error = null
  render()
  void refreshDownloader().then(() => {
    if (state.mode === 'downloader') render()
  })
}

async function nativeDownload() {
  state.native = { busy: true, result: null }
  render()
  const res = await send({ type: 'native_download', pageUrl: state.pageInfo.pageUrl || '' }).catch((e) => ({
    ok: false,
    message: String(e?.message || e)
  }))
  state.native = { busy: false, result: res || { ok: false, message: '下载器没有返回结果' } }
  await refreshDownloader()
  render()
}

async function refreshDownloader() {
  try {
    const status = await send({ type: 'downloads_status' })
    if (status) state.downloader = status
  } catch {}
  try {
    const list = await send({ type: 'list_recent_downloads' })
    state.recentDownloads = list?.items || []
  } catch {
    state.recentDownloads = []
  }
}

function importStatusLabel(status) {
  return { ok: '已入库', duplicate: '已在库中', queued: '待同步', skipped: '已跳过', failed: '失败' }[status] || status
}

function nativeResultText(result) {
  const files = result?.files || []
  const failed = result?.failed || []
  const duplicates = files.filter((file) => file.duplicate).length
  const added = Math.max(0, files.length - duplicates)
  const duplicateText = duplicates > 0 ? `（${duplicates} 项已在库中）` : ''
  const failedText = failed.length > 0 ? `；${failed.length} 项失败` : ''
  return `Falcon 已加入 ${added} 项${duplicateText}${failedText}`
}

function renderDownloader() {
  const current = siteOfUrl(state.pageInfo.pageUrl || '')
  const d = state.downloader || {}
  const rows = []

  if (state.error) rows.push(h('div', { class: 'rowitem bad' }, state.error))
  rows.push(
    h(
      'div',
      { class: 'rowitem' },
      current ? `当前页面：${SITES[current].label}` : '当前页面不是受支持的站点；仍可先安装脚本'
    )
  )
  rows.push(
    h(
      'div',
      { class: 'rowitem' },
      '优先用原生下载：插件解析地址，Falcon 直接下载并加入 Inbox。高画质/批量再装脚本兜底。'
    )
  )

  if (current) {
    const n = state.native || {}
    rows.push(
      h(
        'div',
        { class: 'dlrow on' },
        h('span', { class: 'dlname' }, '当前页面直接下载'),
        h(
          'span',
          { class: 'dlmeta' },
          n.busy ? '正在读取并下载…' : n.result?.ok ? nativeResultText(n.result) : '由 Falcon 下载'
        ),
        h('button', {
          class: 'btn primary',
          text: n.busy ? '下载中…' : current === 'xiaohongshu' ? '下载当前笔记' : current === 'douyin' ? '下载当前作品' : '下载当前视频',
          disabled: Boolean(n.busy),
          onclick: () => void nativeDownload()
        })
      )
    )
    if (n.result && !n.result.ok) {
      rows.push(h('div', { class: 'rowitem bad' }, `${n.result.message}（可改用下方脚本方案）`))
    } else if (n.result?.ok) {
      rows.push(
        h(
          'div',
          { class: 'rowitem' },
          nativeResultText(n.result)
        )
      )
    }
  }

  rows.push(
    h(
      'div',
      { class: 'rowitem' },
      '脚本兜底（高画质 DASH / 批量 / 合集）：脚本负责解析和下载，FalconMM 只读取 Chrome 已完成的下载路径并收进 Inbox。'
    )
  )

  rows.push(
    h(
      'div',
      { class: 'dlrow' },
      h('span', { class: 'dlname' }, 'Tampermonkey'),
      h('span', { class: 'dlmeta' }, '脚本管理器'),
      h('button', {
        class: 'btn secondary',
        text: '打开',
        onclick: () => chrome.tabs.create({ url: SITES.bilibili.tampermonkeyUrl })
      })
    )
  )

  for (const key of Object.keys(SITES)) {
    const site = SITES[key]
    if (!site.script) continue
    rows.push(
      h(
        'div',
        { class: `dlrow ${key === current ? 'on' : ''}` },
        h('span', { class: 'dlname' }, `${site.label} · ${site.script}`),
        h('span', { class: 'dlmeta' }, key === current ? '当前站点' : ''),
        h('button', {
          class: 'btn secondary',
          text: '安装页',
          onclick: () => chrome.tabs.create({ url: site.installUrl })
        })
      )
    )
  }

  rows.push(
    h(
      'div',
      { class: 'rowitem' },
      'YouTube / TikTok / X (Twitter) / Instagram / Vimeo：用上方「当前页面直接下载」；想扩展站点见发布库的插件源码与开发者文档。'
    )
  )

  rows.push(
    h(
      'label',
      { class: 'switchrow' },
      h('input', {
        type: 'checkbox',
        checked: d.autoImport !== false,
        onchange: async (e) => {
          await send({ type: 'set_auto_import', enabled: e.target.checked }).catch(() => undefined)
          await refreshDownloader()
          render()
        }
      }),
      h('span', { text: '下载完成后自动收进 Inbox' })
    )
  )

  if ((d.queueCount || 0) > 0 || (d.byteQueueCount || 0) > 0) {
    rows.push(
      h(
        'div',
        { class: 'dlrow' },
        h('span', { class: 'dlname' }, `待同步：${d.queueCount || 0} 个下载`),
        h('span', { class: 'dlmeta' }, d.byteQueueCount ? `另有 ${d.byteQueueCount} 个抓取` : '应用启动后自动重试'),
        h('button', {
          class: 'btn secondary',
          text: '同步',
          onclick: () => void doSync()
        })
      )
    )
  }

  const recent = d.recent || []
  if (recent.length > 0) {
    rows.push(h('div', { class: 'rowitem' }, '最近自动入库'))
    for (const item of recent.slice(0, 4)) {
      rows.push(
        h(
          'div',
          { class: 'dlrow' },
          h('span', { class: 'dlname' }, item.fileName || '下载文件'),
          h(
            'span',
            { class: `dlmeta ${item.status === 'failed' ? 'bad' : ''}` },
            `${siteLabel(item.site) || '来源未识别'} · ${importStatusLabel(item.status)}`
          )
        )
      )
    }
  } else {
    rows.push(h('p', { class: 'hintline' }, '还没有自动入库记录。安装脚本后下载一个视频试试。'))
  }

  const candidates = state.recentDownloads || []
  if (candidates.length > 0) {
    rows.push(h('div', { class: 'rowitem' }, '浏览器最近下载（可手动导入）'))
    for (const item of candidates.slice(0, 4)) {
      const targetSite = item.site || current
      const handled = item.imported || item.status === 'ok' || item.status === 'duplicate'
      const queued = item.status === 'queued'
      const canImport = Boolean(targetSite) && !handled && !queued
      rows.push(
        h(
          'div',
          { class: 'dlrow' },
          h('span', { class: 'dlname' }, item.fileName || '下载文件'),
          h(
            'span',
            { class: 'dlmeta' },
            handled
              ? '已入库'
              : queued
                ? '待同步'
                : item.status === 'failed'
                  ? '上次失败，可重试'
                  : siteLabel(item.site) || (current ? `按 ${SITES[current].label} 导入` : '来源未识别')
          ),
          h('button', {
            class: 'btn secondary',
            text: handled ? '已入库' : queued ? '待同步' : item.status === 'failed' ? '重试' : '导入',
            disabled: !canImport,
            onclick: async (e) => {
              e.target.disabled = true
              const res = await send({
                type: 'import_download',
                downloadId: item.id,
                siteHint: targetSite,
                pageUrl: state.pageInfo.pageUrl || ''
              })
              if (!res?.ok && !res?.queued) state.error = res?.message || '导入失败'
              await refreshDownloader()
              render()
            }
          })
        )
      )
    }
  }

  els.content.appendChild(h('div', { class: 'list' }, ...rows))
  els.actions.appendChild(
    h('button', {
      class: 'btn primary',
      text: current ? `打开 ${SITES[current].script} 安装页` : '打开 Tampermonkey',
      onclick: () =>
        chrome.tabs.create({ url: current ? SITES[current].installUrl : SITES.bilibili.tampermonkeyUrl })
    })
  )
  els.actions.appendChild(h('button', { class: 'btn secondary', text: '返回抓取', onclick: () => setMode('main') }))
}

function orderMedia(items) {
  // 视频排最前：这类内容（尤其 B 站/抖音/小红书）经常不可直抓，先让用户看到并确认
  return [...items].sort((a, b) => Number(b.kind === 'video') - Number(a.kind === 'video'))
}

function renderMain() {
  const items = orderMedia(state.media)
  const currentSite = siteOfUrl(state.pageInfo.pageUrl || '')
  const drmSite = drmSiteOfUrl(state.pageInfo.pageUrl || '')
  if (items.length === 0) {
    els.content.appendChild(
      h(
        'div',
        { class: 'center' },
        h('div', { text: '本页没有可抓取的图片或视频。换个标签页试试。' }),
        h('div', { text: '受保护视频（HLS / DRM / blob:）不会发起抓取。' })
      )
    )
    return
  }
  if (state.hostDown) {
    els.content.appendChild(
      h(
        'div',
        { class: 'list', style: 'margin-bottom:8px' },
        h('div', { class: 'rowitem bad' }, '本地素材库未运行：先打开 FalconMM 桌面端'),
        h('div', { class: 'rowitem' }, '现在抓取会先存进浏览器本地暂存队列，打开应用后自动同步进 Inbox。')
      )
    )
  }
  const blockedVideos = items.filter((i) => i.kind === 'video' && i.capturable === false)
  if (drmSite) {
    // 商业流媒体的 DRM 提示放在最前：先说清「不绕过」，再说图片仍可抓
    els.content.appendChild(
      h(
        'div',
        { class: 'list', style: 'margin-bottom:8px' },
        h('div', { class: 'rowitem' }, `${drmSiteLabel(drmSite)} 的视频受 DRM 加密保护，插件不抓取也不解密`),
        h('div', { class: 'rowitem' }, '本页图片（封面 / 剧照 / 海报）仍可正常勾选抓取。'),
        h('div', { class: 'rowitem' }, '需要留档视频请用桌面端录屏：⌘/Ctrl+Shift+K 框选画面，录完直接进 Inbox。')
      )
    )
  }
  if (blockedVideos.length > 0) {
    const n = state.native || {}
    els.content.appendChild(
      h(
        'div',
        { class: 'list', style: 'margin-bottom:8px' },
        h(
          'div',
          { class: currentSite ? 'rowitem' : 'rowitem bad' },
          drmSite
            ? `本页 ${blockedVideos.length} 个视频是 DRM 加密流，插件不绕过`
            : currentSite
              ? `本页 ${blockedVideos.length} 个视频是流媒体播放，可直接下载完整文件`
              : `本页 ${blockedVideos.length} 个视频是流媒体或受保护内容，插件抓不了`
        ),
        h(
          'div',
          { class: 'rowitem' },
          drmSite
            ? `${drmSiteLabel(drmSite)} 把音视频加密后交给播放器解密，「下载」必须破解 DRM；脚本同样做不到。请用录屏留档。`
            : currentSite
              ? `点「直接下载当前视频」读取 ${SITES[currentSite].label} 页面数据，交给 Falcon 下载并加入 Inbox；失败再装脚本兜底。`
              : '受支持站点的视频可点「直接下载」；其他站点请用桌面端录屏：⌘/Ctrl+Shift+K 框选画面。'
        ),
        currentSite
          ? h('button', {
              class: 'btn primary',
              text: n.busy ? '下载中…' : '直接下载当前视频',
              disabled: Boolean(n.busy),
              onclick: () => void nativeDownload()
            })
          : null,
        n.result?.ok
          ? h('div', { class: 'rowitem ok' }, nativeResultText(n.result))
          : null,
        n.result && !n.result.ok ? h('div', { class: 'rowitem bad' }, n.result.message) : null
      )
    )
  }
  const grid = h('div', { class: 'grid' })
  for (const item of items) {
    const blocked = item.capturable === false
    const selected = state.selected.has(item.url)
    // blob: / m3u8 / mpd 只在原页面 origin 有效，popup 是 chrome-extension://，
    // 直接塞进 <video>/<img> 会报 "Not allowed to load local resource"。
    const previewable = /^https?:/i.test(item.url) && !/\.m3u8|\.mpd/i.test(item.url)
    // 视频直链在弹窗里常被站点防盗链拒绝（Referer/Cookie 校验），封面图没有这个限制，
    // 所以有封面（播放器提取或 poster 属性）时优先用封面展示。
    const coverUrl = [item.coverUrl, item.poster].find((u) => /^https:/i.test(u || ''))
    const isVideo = item.kind === 'video'
    const placeholderText = blocked
      ? item.reason === 'drm_protected'
        ? 'DRM'
        : '流媒体'
      : isVideo
        ? '视频'
        : '图片'
    const videoMeta = isVideo
      ? [formatDuration(item.durationMs), item.width && item.height ? `${item.width}×${item.height}` : '']
          .filter(Boolean)
          .join(' · ')
      : ''
    const card = h(
      'div',
      {
        class: `card ${selected ? 'selected' : ''} ${blocked ? 'blocked' : ''}`,
        title: blocked ? reasonText(item.reason, drmSite) : item.url,
        onclick: () => {
          if (blocked) {
            state.error = reasonText(item.reason, drmSite)
            setMode('notCapturable')
            return
          }
          if (state.selected.has(item.url)) state.selected.delete(item.url)
          else state.selected.add(item.url)
          render()
        }
      },
      isVideo && coverUrl
        ? h('img', { class: 'thumb', src: coverUrl, loading: 'lazy', referrerpolicy: 'no-referrer' })
        : isVideo && previewable
          ? h('video', {
              class: 'thumb',
              src: item.url,
              muted: true,
              playsinline: true,
              preload: 'metadata',
              title: item.url,
              onerror: (e) => {
                // 直链被站点拒绝时退回占位卡片，避免黑块
                e.target.replaceWith(
                  h(
                    'div',
                    { class: 'thumb placeholder' },
                    h('span', { text: videoMeta ? `${placeholderText} · ${videoMeta}` : placeholderText })
                  )
                )
              }
            })
          : isVideo || !previewable
            ? h(
                'div',
                { class: 'thumb placeholder' },
                h('span', { text: videoMeta ? `${placeholderText} · ${videoMeta}` : placeholderText })
              )
            : h('img', { class: 'thumb', src: item.url, loading: 'lazy', referrerpolicy: 'no-referrer' }),
      isVideo
        ? h(
            'div',
            { class: 'video-badge' },
            h('span', { class: 'play-tri' }),
            h('span', { text: formatDuration(item.durationMs) || '视频' })
          )
        : null,
      h('div', {
        class: 'name',
        text: blocked
          ? hostOfUrl(item.url) || placeholderText
          : item.url.split('/').pop() || item.kind
      }),
      h('div', { class: 'check' }),
      blocked
        ? h('div', {
            class: 'blocked-tag',
            text:
              item.reason === 'drm_protected'
                ? 'DRM'
                : item.reason === 'hls_manifest' || item.reason === 'mse_blob'
                  ? '流媒体'
                  : '不可抓'
          })
        : null,
      blocked
        ? h('button', {
            class: 'copy-link',
            text: '复制链接',
            title: '复制媒体地址（仅复制，不入库）',
            onclick: async (e) => {
              e.stopPropagation()
              try {
                await navigator.clipboard.writeText(item.url)
                e.target.textContent = '已复制'
              } catch {
                e.target.textContent = '复制失败'
              }
              setTimeout(() => {
                if (e.target.isConnected) e.target.textContent = '复制链接'
              }, 1200)
            }
          })
        : null
    )
    grid.appendChild(card)
  }
  els.content.appendChild(grid)
  els.content.appendChild(
    h('p', { class: 'hintline' }, '勾选要入库的项目。判重只在本地落库时做一次；已存在的项会显示「已在库中」且不改动原有标签。')
  )

  const selectedItems = items.filter((i) => state.selected.has(i.url))
  const targets = selectedItems.length > 0 ? selectedItems : items.filter((i) => i.capturable !== false).slice(0, 1)
  const label = selectedItems.length > 1 ? `抓取 ${selectedItems.length} 项到 Falcon` : '抓取到 Falcon'
  els.actions.appendChild(
    h(
      'button',
      {
        class: 'btn primary',
        disabled: targets.length === 0,
        onclick: () => doCapture(selectedItems.length > 1 ? 'batch' : 'toolbar')
      },
      h('img', { class: 'btn-logo', src: 'icons/toolbar-16.png', alt: '' }),
      h('span', { text: label })
    )
  )
  els.actions.appendChild(
    h('button', {
      class: 'btn secondary',
      text: selectedItems.length > 0 ? `清空选择（已选 ${selectedItems.length}）` : '全选可抓项',
      onclick: () => {
        if (state.selected.size > 0) state.selected.clear()
        else for (const i of items) if (i.capturable !== false) state.selected.add(i.url)
        render()
      }
    })
  )
  if (state.status?.queue?.count > 0) {
    els.actions.appendChild(
      h('button', { class: 'btn ghost', text: `同步暂存队列（${state.status.queue.count} 项）`, onclick: () => void doSync() })
    )
  }
}

function formatDuration(ms) {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return ''
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const sec = total % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

function reasonText(reason, drmSite) {
  if (drmSite) {
    return `${drmSiteLabel(drmSite)} 的视频是 DRM 加密流：插件不做解密/绕过；请用桌面端 ⌘/Ctrl+Shift+K 录屏留档`
  }
  return (
    {
      mse_blob: '页面播放器不暴露完整文件；受支持站点可点「直接下载」，其他站点请用桌面端 ⌘/Ctrl+Shift+K 录屏',
      hls_manifest: 'HLS / DASH 分片流；受支持站点可点「直接下载」，其他站点请用桌面端 ⌘/Ctrl+Shift+K 录屏',
      drm_protected: '受 DRM 保护，无法抓取。需要的话请用桌面端 ⌘/Ctrl+Shift+K 录屏',
      cross_origin_iframe: '跨源 iframe 内的媒体不可抓',
      canvas_tainted: '跨域污染的画布不可导出'
    }[reason] || '该媒体不可抓'
  )
}

function renderResult() {
  const r = state.result || {}
  const added = r.added || 0
  const dup = r.duplicates || 0
  const results = r.results || []
  const failed = results.filter((item) => !item.ok)
  const failedCount = failed.length
  const allDup = added === 0 && dup > 0
  const allFailed = added === 0 && dup === 0 && failedCount > 0

  let title
  if (allFailed) title = `本次 ${failedCount} 项未入库`
  else if (allDup) title = `本次 ${dup} 项均已在库中`
  else if (added === 0 && dup === 0) title = '本次没有新增素材'
  else title = `已加入 ${added} 项 · 已在库中 ${dup} 项`

  const detail = allFailed
    ? '逐项原因见下方。文件本身没有上传到任何远端，请按提示处理后重试。'
    : allDup
      ? '未新增素材，原有标签与元数据未被改动。'
      : added > 0
        ? '已进入与桌面抓取相同的 Inbox，按待处理状态排队。'
        : ''

  els.content.appendChild(
    h(
      'div',
      { class: 'list' },
      h('div', { class: allFailed ? 'rowitem bad' : 'rowitem', text: title }),
      detail ? h('div', { class: 'rowitem' }, detail) : null,
      ...results.map((item) =>
        h(
          'div',
          { class: 'rowitem' },
          h('span', {
            class: item.ok ? 'ok' : 'bad',
            text: item.ok ? (item.duplicate ? '已在库中' : '已入库') : '失败'
          }),
          h('span', { text: (item.url || '').split('/').pop() || item.reason || '' }),
          h('span', { style: 'flex:1' }),
          !item.ok ? h('span', { class: 'bad', text: item.reason || '' }) : null
        )
      )
    )
  )
  els.actions.appendChild(h('button', { class: 'btn primary', text: '关闭', onclick: () => window.close() }))
}

function renderOffline() {
  const q = state.status?.queue || { count: 0, totalBytes: 0 }
  els.content.appendChild(
    h(
      'div',
      { class: 'list' },
      h('div', { class: 'rowitem bad' }, '本地素材库未运行'),
      h('div', { class: 'rowitem' }, `已暂存待同步 ${q.count} 项`),
      h('div', { class: 'rowitem' }, '上限 50 项 / 2 GB / 保留 7 天；超出按最早优先丢弃。'),
      h('p', { class: 'hintline' }, '启动「FalconMM 素材库」后会自动同步进同一个 Inbox；同步成功即出队。清理浏览器数据会丢失暂存项。')
    )
  )
  els.actions.appendChild(
    h('button', { class: 'btn primary', text: '启动本地应用后重试同步', onclick: () => void doSync() })
  )
  els.actions.appendChild(h('button', { class: 'btn secondary', text: '关闭', onclick: () => window.close() }))
}

function renderPairing() {
  els.content.appendChild(
    h(
      'div',
      { class: 'list' },
      h('div', { class: 'rowitem' }, '先打开 FalconMM 桌面端，再到 设置 → 浏览器插件 生成 6 位配对码'),
      h('div', { class: 'rowitem' }, '配对码 5 分钟有效、一次性；连错 3 次锁定 10 分钟。'),
      h('input', {
        class: 'code',
        id: 'paircode',
        inputmode: 'numeric',
        maxlength: '6',
        placeholder: '000000',
        oninput: (e) => {
          e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6)
          const btn = document.getElementById('pairbtn')
          if (btn) btn.disabled = e.target.value.length !== 6
        }
      }),
      state.pairingError ? h('div', { class: 'err', text: state.pairingError }) : null
    )
  )
  els.actions.appendChild(
    h('button', {
      class: 'btn primary',
      id: 'pairbtn',
      text: '配对',
      disabled: true,
      onclick: async (e) => {
        const code = document.getElementById('paircode')?.value || ''
        e.target.disabled = true
        e.target.textContent = '配对中…'
        const res = await send({ type: 'pair', code })
        if (res?.ok) {
          state.status = { ...(state.status || {}), tokenSet: true }
          state.pairingError = null
          await loadMedia()
        } else {
          state.pairingError = res?.message || '配对失败'
          render()
        }
      }
    })
  )
}

async function refreshStatus() {
  try {
    state.status = await send({ type: 'status' })
  } catch {
    state.status = { tokenSet: false, queue: { count: 0, totalBytes: 0 } }
  }
}

async function loadMedia() {
  state.mode = 'loading'
  render()
  const data = await send({ type: 'list_media' })
  if (data?.error === 'permission_denied') {
    state.mode = 'permission'
    state.error = data.message
    render()
    return
  }
  state.media = data?.items || []
  state.pageInfo = { pageTitle: data?.pageTitle, pageUrl: data?.pageUrl }
  state.selected = new Set(state.media.filter((i) => i.capturable !== false).slice(0, 0).map((i) => i.url))
  setMode('main')
}

/**
 * 站点访问权限必须在「用户点击」的手势内请求，不能等 service worker 异步处理时再请求
 * （Chrome 会抛 "This function must be called during a user gesture"）。已授权时立即返回且不弹窗。
 * 站点视频（B 站/抖音/小红书 CDN 直链）由 Falcon 下载，不需要浏览器授权，避免给用户弹
 * douyinvod.com 这类 CDN 域名的授权框。
 */
async function requestSiteAccess(items) {
  const origins = [
    ...new Set(
      items
        .filter((i) => !(i.kind === 'video' && siteOfUrl(i.url)))
        .map((i) => {
          try {
            return `${new URL(i.url).origin}/*`
          } catch {
            return null
          }
        })
        .filter(Boolean)
    )
  ]
  if (origins.length === 0) return { ok: true }
  try {
    const granted = await chrome.permissions.request({ origins })
    return { ok: granted, origins }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

async function doCapture(captureMethod) {
  const selected = state.media.filter((i) => state.selected.has(i.url))
  const items = selected.length > 0 ? selected : state.media.filter((i) => i.capturable !== false).slice(0, 1)
  if (items.length === 0) return
  // 第一个 await 必须是权限请求，保证手势有效
  const access = await requestSiteAccess(items)
  if (!access.ok) {
    state.mode = 'permission'
    state.error = access.error || `未获得 ${(access.origins || []).join('、') || '该站点'} 的访问权限，点击「重新尝试抓取」再授权一次`
    render()
    return
  }
  state.mode = 'progress'
  state.progress = { step: 'capture', index: 1, total: items.length }
  render()
  let res
  try {
    res = await send({
      type: 'capture',
      items,
      captureMethod,
      pageUrl: state.pageInfo.pageUrl || '',
      pageTitle: state.pageInfo.pageTitle || ''
    })
  } catch (e) {
    res = { ok: false, message: String(e?.message || e) }
  }
  await refreshStatus()
  if (res?.ok && res.offline) {
    state.mode = 'offline'
    render()
    return
  }
  if (res?.code === 40304) {
    state.status = { ...(state.status || {}), tokenSet: false }
    state.mode = 'pairing'
    render()
    return
  }
  if (res?.code === 40306) {
    state.mode = 'permission'
    state.error = res.message
    render()
    return
  }
  if (res?.code === 42205) {
    state.mode = 'notCapturable'
    state.error = res.message
    render()
    return
  }
  if (!res?.ok) {
    const msg = String(res?.message || '抓取失败')
    if (/native|host|not found|Specified native messaging host/i.test(msg) || res?.code === 50304) {
      state.mode = 'l3'
      state.error = msg
      render()
      return
    }
    state.mode = 'result'
    state.result = { added: 0, duplicates: 0, results: [{ ok: false, url: '', reason: msg }] }
    render()
    return
  }
  state.mode = 'result'
  state.result = res
  render()
}

async function doSync() {
  state.mode = 'progress'
  state.progress = { step: 'sync' }
  render()
  const res = await send({ type: 'sync' })
  await refreshStatus()
  if (res?.ok) {
    state.mode = 'result'
    const added = (res.synced || 0) + (res.pathSynced || 0)
    const duplicates = (res.duplicates || 0) + (res.pathDuplicates || 0)
    state.result = { added, duplicates, results: [] }
    if (added === 0 && duplicates === 0) {
      state.mode = 'offline'
    }
    render()
    return
  }
  state.mode = 'offline'
  render()
}

els.close.addEventListener('click', () => window.close())
els.downloader.addEventListener('click', openDownloader)
els.gear.addEventListener('click', () => {
  state.mode = 'info'
  render()
})

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'progress') return
  const p = message.progress || {}
  if (p.step === 'capture') {
    state.progress = p
    if (state.mode === 'progress') render()
  }
})

;(async () => {
  await refreshStatus()
  if (!state.status?.tokenSet) {
    setMode('pairing')
    return
  }
  // 本地有 token 不代表还有效：应用侧可能撤销过、或数据目录换过。先验证一次。
  try {
    const v = await send({ type: 'verify' })
    if (v && v.ok === false && v.code === 40304) {
      await send({ type: 'unpair' }).catch(() => undefined)
      state.status.tokenSet = false
      state.pairingError = '配对已失效（应用侧已撤销或数据已更换），请输入新的配对码'
      setMode('pairing')
      return
    }
    if (v && v.ok === false) {
      // 应用没运行 / 通道不可用：不阻断浏览本页，只提示
      state.hostDown = true
    }
  } catch {
    state.hostDown = true
  }
  await loadMedia()
})()
