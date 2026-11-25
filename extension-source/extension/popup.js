// P8 插件弹窗：主态 / 批量 / 暂存与同步结果 / 不可抓 / 未授权 / 配对 / 视频下载器
import { SITES, drmSiteLabel, drmSiteOfUrl, hostOfUrl, siteLabel, siteOfUrl } from './lib/sites.mjs'
import { t, setLanguage, resolveLanguage, isRtl } from './lib/i18n.mjs'

const lang = setLanguage(resolveLanguage(chrome.i18n.getUILanguage()))
document.documentElement.lang = lang
document.documentElement.dir = isRtl() ? 'rtl' : 'ltr'
document.title = t('popup.html.title')

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

// 弹窗静态 title / aria-label 由 t() 覆盖，最终文案不依赖 popup.html 里的初值
els.downloader.title = t('popup.html.downloader')
els.downloader.setAttribute('aria-label', t('popup.html.downloader'))
els.gear.title = t('popup.html.gearTitle')
els.gear.setAttribute('aria-label', t('popup.html.gearLabel'))
els.close.title = t('popup.html.close')
els.close.setAttribute('aria-label', t('popup.html.close'))

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
  els.connText.textContent = paired ? t('popup.conn.paired') : t('popup.conn.unpaired')
  els.origin.textContent = state.pageInfo.pageUrl
    ? new URL(state.pageInfo.pageUrl).host
    : t('popup.counts.currentPage')
  const images = state.media.filter((m) => m.kind === 'image').length
  const videos = state.media.filter((m) => m.kind === 'video').length
  const currentSite = siteOfUrl(state.pageInfo.pageUrl || '')
  const drmSite = drmSiteOfUrl(state.pageInfo.pageUrl || '')
  els.counts.textContent =
    state.mode === 'downloader'
      ? currentSite
        ? t('popup.counts.site', { site: siteLabel(currentSite) })
        : t('popup.counts.supportedSites', { count: Object.keys(SITES).length })
      : state.media.length
        ? t('popup.counts.page', { images, videos }) +
          (drmSite ? t('popup.counts.pageDrm', { site: drmSiteLabel(drmSite) }) : '')
        : state.mode === 'loading'
          ? t('popup.counts.loading')
          : t('popup.counts.empty')

  const q = s?.queue
  if (q && q.count > 0) {
    els.queueWarn.hidden = false
    els.queueWarn.textContent = t('popup.queueWarn.pending', {
      count: q.count,
      size: Math.round((q.totalBytes || 0) / 1024 / 1024 * 10) / 10
    })
  } else {
    els.queueWarn.hidden = true
  }

  els.content.replaceChildren()
  els.actions.replaceChildren()

  if (state.mode === 'loading') {
    els.content.appendChild(h('div', { class: 'center' }, t('popup.counts.loading')))
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
        h('div', { class: 'rowitem' }, t('popup.info.openDesktopSettings')),
        h('div', { class: 'rowitem' }, t('popup.info.capabilities')),
        h('div', { class: 'rowitem' }, t('popup.info.captureOnly')),
        h('p', { class: 'hintline' }, t('popup.info.permissions'))
      )
    )
    els.actions.appendChild(
      h('button', {
        class: 'btn secondary',
        text: t('popup.info.repair'),
        onclick: async () => {
          try {
            await send({ type: 'unpair' })
          } catch {}
          state.status = { ...(state.status || {}), tokenSet: false }
          state.pairingError = t('popup.pairing.cleared')
          setMode('pairing')
        }
      })
    )
    els.actions.appendChild(
      h('button', { class: 'btn secondary', text: t('popup.info.back'), onclick: () => setMode('main') })
    )
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
        h('div', {
          class: 'mono',
          text:
            p.step === 'capture'
              ? t('popup.progress.capture', { index: p.index, total: p.total })
              : t('popup.progress.transferring')
        }),
        h('div', { text: t('popup.progress.hint') })
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
        h('div', { class: 'rowitem bad' }, t('popup.permission.denied')),
        h('div', { class: 'rowitem' }, t('popup.permission.howToRestore')),
        h('div', { class: 'rowitem' }, state.error || t('popup.permission.notSaved'))
      )
    )
    els.actions.appendChild(
      h('button', { class: 'btn primary', text: t('popup.permission.retry'), onclick: () => doCapture('toolbar') })
    )
    els.actions.appendChild(
      h('button', {
        class: 'btn secondary',
        text: t('popup.permission.openExtensions'),
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
          h('div', { class: 'bad', text: t('popup.notCapturable.drmTitle', { site: drmSiteLabel(drmSite) }) }),
          h('div', { text: t('popup.notCapturable.drmBody1') }),
          h('div', { text: t('popup.notCapturable.drmBody2') }),
          h('div', { text: t('popup.notCapturable.drmBody3') })
        )
      )
      els.actions.appendChild(
        h('button', {
          class: 'btn primary',
          text: t('popup.notCapturable.backToImages'),
          onclick: () => setMode('main')
        })
      )
      els.actions.appendChild(
        h('button', {
          class: 'btn secondary',
          text: t('popup.notCapturable.openDownloaderMulti'),
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
          {
            class: canNative ? '' : 'bad',
            text: canNative
              ? t('popup.notCapturable.streamTitle')
              : t('popup.notCapturable.blockedTitle')
          }
        ),
        canNative
          ? h('div', { text: t('popup.notCapturable.nativeBody', { site: siteLabel(currentSite) }) })
          : h('div', { text: t('popup.notCapturable.blockedBody') }),
        canNative
          ? h('div', { text: t('popup.notCapturable.nativeHint') })
          : h('div', { text: t('popup.notCapturable.blockedHint') }),
        n.busy ? h('div', { class: 'mono', text: t('popup.notCapturable.nativeBusy') }) : null,
        n.result?.ok
          ? h('div', { class: 'ok', text: nativeResultText(n.result) })
          : null,
        n.result && !n.result.ok ? h('div', { class: 'bad', text: n.result.message }) : null
      )
    )
    els.actions.appendChild(
      h('button', {
        class: 'btn primary',
        text: n.busy
          ? t('popup.notCapturable.downloading')
          : canNative
            ? t('popup.notCapturable.downloadVideo')
            : t('popup.notCapturable.openDownloader'),
        disabled: Boolean(n.busy),
        onclick: () => (canNative ? void nativeDownload() : openDownloader())
      })
    )
    els.actions.appendChild(
      h('button', {
        class: 'btn secondary',
        text: canNative ? t('popup.notCapturable.installScript') : t('popup.info.back'),
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
        h('div', { class: 'rowitem bad' }, t('popup.l3.title')),
        h('div', { class: 'rowitem' }, t('popup.l3.body')),
        h('div', { class: 'rowitem' }, state.error || '')
      )
    )
    els.actions.appendChild(
      h('button', {
        class: 'btn secondary',
        text: t('popup.l3.copyLink'),
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
  state.native = { busy: false, result: res || { ok: false, message: t('popup.downloader.noResult') } }
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
  return (
    {
      ok: t('popup.importStatus.ok'),
      duplicate: t('popup.importStatus.duplicate'),
      queued: t('popup.importStatus.queued'),
      skipped: t('popup.importStatus.skipped'),
      failed: t('popup.importStatus.failed')
    }[status] || status
  )
}

function nativeResultText(result) {
  const files = result?.files || []
  const failed = result?.failed || []
  const duplicates = files.filter((file) => file.duplicate).length
  const added = Math.max(0, files.length - duplicates)
  const duplicateText = duplicates > 0 ? t('popup.nativeResult.duplicates', { count: duplicates }) : ''
  const failedText = failed.length > 0 ? t('popup.nativeResult.failed', { count: failed.length }) : ''
  return t('popup.nativeResult.summary', { count: added, duplicates: duplicateText, failed: failedText })
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
      current
        ? t('popup.counts.site', { site: siteLabel(current) })
        : t('popup.downloader.unsupportedPage')
    )
  )
  rows.push(h('div', { class: 'rowitem' }, t('popup.downloader.intro')))

  if (current) {
    const n = state.native || {}
    rows.push(
      h(
        'div',
        { class: 'dlrow on' },
        h('span', { class: 'dlname' }, t('popup.downloader.currentPageDirect')),
        h(
          'span',
          { class: 'dlmeta' },
          n.busy
            ? t('popup.downloader.fetching')
            : n.result?.ok
              ? nativeResultText(n.result)
              : t('popup.downloader.fetchedByFalcon')
        ),
        h('button', {
          class: 'btn primary',
          text: n.busy
            ? t('popup.notCapturable.downloading')
            : current === 'xiaohongshu'
              ? t('popup.downloader.downloadNote')
              : current === 'douyin'
                ? t('popup.downloader.downloadPost')
                : t('popup.downloader.downloadVideo'),
          disabled: Boolean(n.busy),
          onclick: () => void nativeDownload()
        })
      )
    )
    if (n.result && !n.result.ok) {
      rows.push(
        h(
          'div',
          { class: 'rowitem bad' },
          t('popup.downloader.errorWithScriptFallback', { message: n.result.message })
        )
      )
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

  rows.push(h('div', { class: 'rowitem' }, t('popup.downloader.scriptFallbackIntro')))

  rows.push(
    h(
      'div',
      { class: 'dlrow' },
      h('span', { class: 'dlname' }, 'Tampermonkey'),
      h('span', { class: 'dlmeta' }, t('popup.downloader.scriptManager')),
      h('button', {
        class: 'btn secondary',
        text: t('popup.downloader.open'),
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
        h(
          'span',
          { class: 'dlname' },
          t('popup.downloader.scriptRow', { site: siteLabel(key), script: site.script })
        ),
        h('span', { class: 'dlmeta' }, key === current ? t('popup.downloader.currentSite') : ''),
        h('button', {
          class: 'btn secondary',
          text: t('popup.downloader.installPage'),
          onclick: () => chrome.tabs.create({ url: site.installUrl })
        })
      )
    )
  }

  rows.push(h('div', { class: 'rowitem' }, t('popup.downloader.internationalSites')))

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
      h('span', { text: t('popup.downloader.autoImport') })
    )
  )

  if ((d.queueCount || 0) > 0 || (d.byteQueueCount || 0) > 0) {
    rows.push(
      h(
        'div',
        { class: 'dlrow' },
        h(
          'span',
          { class: 'dlname' },
          t('popup.downloader.pendingDownloads', { count: d.queueCount || 0 })
        ),
        h(
          'span',
          { class: 'dlmeta' },
          d.byteQueueCount
            ? t('popup.downloader.pendingCaptures', { count: d.byteQueueCount })
            : t('popup.downloader.autoRetry')
        ),
        h('button', {
          class: 'btn secondary',
          text: t('popup.downloader.sync'),
          onclick: () => void doSync()
        })
      )
    )
  }

  const recent = d.recent || []
  if (recent.length > 0) {
    rows.push(h('div', { class: 'rowitem' }, t('popup.downloader.recentImports')))
    for (const item of recent.slice(0, 4)) {
      rows.push(
        h(
          'div',
          { class: 'dlrow' },
          h('span', { class: 'dlname' }, item.fileName || t('popup.downloader.downloadFile')),
          h(
            'span',
            { class: `dlmeta ${item.status === 'failed' ? 'bad' : ''}` },
            t('popup.downloader.recentMeta', {
              site: siteLabel(item.site) || t('popup.downloader.unknownSource'),
              status: importStatusLabel(item.status)
            })
          )
        )
      )
    }
  } else {
    rows.push(h('p', { class: 'hintline' }, t('popup.downloader.noRecentImports')))
  }

  const candidates = state.recentDownloads || []
  if (candidates.length > 0) {
    rows.push(h('div', { class: 'rowitem' }, t('popup.downloader.recentDownloads')))
    for (const item of candidates.slice(0, 4)) {
      const targetSite = item.site || current
      const handled = item.imported || item.status === 'ok' || item.status === 'duplicate'
      const queued = item.status === 'queued'
      const canImport = Boolean(targetSite) && !handled && !queued
      rows.push(
        h(
          'div',
          { class: 'dlrow' },
          h('span', { class: 'dlname' }, item.fileName || t('popup.downloader.downloadFile')),
          h(
            'span',
            { class: 'dlmeta' },
            handled
              ? t('popup.importStatus.ok')
              : queued
                ? t('popup.importStatus.queued')
                : item.status === 'failed'
                  ? t('popup.downloader.lastFailed')
                  : siteLabel(item.site) ||
                    (current
                      ? t('popup.downloader.importAs', { site: siteLabel(current) })
                      : t('popup.downloader.unknownSource'))
          ),
          h('button', {
            class: 'btn secondary',
            text: handled
              ? t('popup.importStatus.ok')
              : queued
                ? t('popup.importStatus.queued')
                : item.status === 'failed'
                  ? t('popup.downloader.retry')
                  : t('popup.downloader.import'),
            disabled: !canImport,
            onclick: async (e) => {
              e.target.disabled = true
              const res = await send({
                type: 'import_download',
                downloadId: item.id,
                siteHint: targetSite,
                pageUrl: state.pageInfo.pageUrl || ''
              })
              if (!res?.ok && !res?.queued) state.error = res?.message || t('popup.downloader.importFailed')
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
      text: current
        ? t('popup.downloader.openScriptInstall', { script: SITES[current].script })
        : t('popup.downloader.openTampermonkey'),
      onclick: () =>
        chrome.tabs.create({ url: current ? SITES[current].installUrl : SITES.bilibili.tampermonkeyUrl })
    })
  )
  els.actions.appendChild(
    h('button', {
      class: 'btn secondary',
      text: t('popup.downloader.backToCapture'),
      onclick: () => setMode('main')
    })
  )
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
        h('div', { text: t('popup.counts.empty') }),
        h('div', { text: t('popup.main.protectedNote') })
      )
    )
    return
  }
  if (state.hostDown) {
    els.content.appendChild(
      h(
        'div',
        { class: 'list', style: 'margin-bottom:8px' },
        h('div', { class: 'rowitem bad' }, t('popup.main.hostDownTitle')),
        h('div', { class: 'rowitem' }, t('popup.main.hostDownBody'))
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
        h('div', { class: 'rowitem' }, t('popup.main.drmTitle', { site: drmSiteLabel(drmSite) })),
        h('div', { class: 'rowitem' }, t('popup.main.drmImages')),
        h('div', { class: 'rowitem' }, t('popup.main.drmRecord'))
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
            ? t('popup.main.blockedDrmTitle', { count: blockedVideos.length })
            : currentSite
              ? t('popup.main.blockedStreamTitle', { count: blockedVideos.length })
              : t('popup.main.blockedOtherTitle', { count: blockedVideos.length })
        ),
        h(
          'div',
          { class: 'rowitem' },
          drmSite
            ? t('popup.main.drmBody', { site: drmSiteLabel(drmSite) })
            : currentSite
              ? t('popup.main.streamBody', { site: siteLabel(currentSite) })
              : t('popup.main.blockedOtherBody')
        ),
        currentSite
          ? h('button', {
              class: 'btn primary',
              text: n.busy ? t('popup.notCapturable.downloading') : t('popup.notCapturable.downloadVideo'),
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
        : t('popup.card.streaming')
      : isVideo
        ? t('popup.card.video')
        : t('popup.card.image')
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
            h('span', { text: formatDuration(item.durationMs) || t('popup.card.video') })
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
                  ? t('popup.card.streaming')
                  : t('popup.card.notCapturable')
          })
        : null,
      blocked
        ? h('button', {
            class: 'copy-link',
            text: t('popup.card.copyLink'),
            title: t('popup.card.copyLinkTitle'),
            onclick: async (e) => {
              e.stopPropagation()
              try {
                await navigator.clipboard.writeText(item.url)
                e.target.textContent = t('popup.card.copied')
              } catch {
                e.target.textContent = t('popup.card.copyFailed')
              }
              setTimeout(() => {
                if (e.target.isConnected) e.target.textContent = t('popup.card.copyLink')
              }, 1200)
            }
          })
        : null
    )
    grid.appendChild(card)
  }
  els.content.appendChild(grid)
  els.content.appendChild(
    h('p', { class: 'hintline' }, t('popup.main.hint'))
  )

  const selectedItems = items.filter((i) => state.selected.has(i.url))
  const targets = selectedItems.length > 0 ? selectedItems : items.filter((i) => i.capturable !== false).slice(0, 1)
  const label =
    selectedItems.length > 1
      ? t('popup.main.captureMany', { count: selectedItems.length })
      : t('popup.main.capture')
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
      text:
        selectedItems.length > 0
          ? t('popup.main.clearSelection', { count: selectedItems.length })
          : t('popup.main.selectAll'),
      onclick: () => {
        if (state.selected.size > 0) state.selected.clear()
        else for (const i of items) if (i.capturable !== false) state.selected.add(i.url)
        render()
      }
    })
  )
  if (state.status?.queue?.count > 0) {
    els.actions.appendChild(
      h('button', {
        class: 'btn ghost',
        text: t('popup.main.syncQueue', { count: state.status.queue.count }),
        onclick: () => void doSync()
      })
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
    return t('popup.reason.drm', { site: drmSiteLabel(drmSite) })
  }
  return (
    {
      mse_blob: t('popup.reason.mseBlob'),
      hls_manifest: t('popup.reason.hlsManifest'),
      drm_protected: t('popup.reason.drmProtected'),
      cross_origin_iframe: t('popup.reason.crossOriginIframe'),
      canvas_tainted: t('popup.reason.canvasTainted')
    }[reason] || t('popup.reason.unknown')
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
  if (allFailed) title = t('popup.result.allFailedTitle', { count: failedCount })
  else if (allDup) title = t('popup.result.allDuplicateTitle', { count: dup })
  else if (added === 0 && dup === 0) title = t('popup.result.emptyTitle')
  else title = t('popup.result.summaryTitle', { added, duplicates: dup })

  const detail = allFailed
    ? t('popup.result.allFailedDetail')
    : allDup
      ? t('popup.result.allDuplicateDetail')
      : added > 0
        ? t('popup.result.addedDetail')
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
            text: item.ok
              ? item.duplicate
                ? t('popup.importStatus.duplicate')
                : t('popup.importStatus.ok')
              : t('popup.importStatus.failed')
          }),
          h('span', { text: (item.url || '').split('/').pop() || item.reason || '' }),
          h('span', { style: 'flex:1' }),
          !item.ok ? h('span', { class: 'bad', text: item.reason || '' }) : null
        )
      )
    )
  )
  els.actions.appendChild(
    h('button', { class: 'btn primary', text: t('popup.result.close'), onclick: () => window.close() })
  )
}

function renderOffline() {
  const q = state.status?.queue || { count: 0, totalBytes: 0 }
  els.content.appendChild(
    h(
      'div',
      { class: 'list' },
      h('div', { class: 'rowitem bad' }, t('popup.offline.title')),
      h('div', { class: 'rowitem' }, t('popup.offline.pending', { count: q.count })),
      h('div', { class: 'rowitem' }, t('popup.offline.limit')),
      h('p', { class: 'hintline' }, t('popup.offline.hint'))
    )
  )
  els.actions.appendChild(
    h('button', { class: 'btn primary', text: t('popup.offline.retrySync'), onclick: () => void doSync() })
  )
  els.actions.appendChild(
    h('button', { class: 'btn secondary', text: t('popup.result.close'), onclick: () => window.close() })
  )
}

function renderPairing() {
  els.content.appendChild(
    h(
      'div',
      { class: 'list' },
      h('div', { class: 'rowitem' }, t('popup.pairing.intro1')),
      h('div', { class: 'rowitem' }, t('popup.pairing.intro2')),
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
      text: t('popup.pairing.submit'),
      disabled: true,
      onclick: async (e) => {
        const code = document.getElementById('paircode')?.value || ''
        e.target.disabled = true
        e.target.textContent = t('popup.pairing.submitting')
        const res = await send({ type: 'pair', code })
        if (res?.ok) {
          state.status = { ...(state.status || {}), tokenSet: true }
          state.pairingError = null
          await loadMedia()
        } else {
          state.pairingError = res?.message || t('popup.pairing.failed')
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
    state.error =
      access.error ||
      t('popup.permission.deniedOrigins', {
        origins: (access.origins || []).join(t('popup.permission.originSeparator')) || t('popup.permission.thisSite')
      })
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
    const msg = String(res?.message || t('popup.capture.failed'))
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
      state.pairingError = t('popup.pairing.expired')
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
