// 注入到页面 MAIN world 的媒体地址解析器（由 esbuild 打包为 IIFE）。
// 只解析当前页面已经拿到的数据 / 站点自己的 API，不下载媒体字节。
// 真正的下载由 Falcon 桌面端执行：Node 不受页面 CORS 限制，下载与入库都在 Falcon。

import {
  bilibiliCoveredMs,
  bilibiliPreviewGapMs,
  douyinCoverUrl,
  mediaFileName,
  parseBilibiliInitialState,
  parseBilibiliPgcSeason,
  parseBilibiliPlayurl,
  parseDouyinRouterData,
  parseInstagramOgMeta,
  parseInstagramWebInfo,
  parseTikTokLegacy,
  parseTikTokRehydration,
  parseTwitterTweetResult,
  parseVimeoConfig,
  parseXiaohongshuState,
  parseYoutubePlayerResponse,
  sanitizeFileName,
  selectBilibiliDash,
  tiktokCoverUrl
} from '../lib/native-adapters.mjs'

/** 带词典 key 的错误：页面脚本不携带词典（避免 bundle 膨胀），由 background 用 t(key, vars) 翻译成用户语言。 */
function nativeError(key, vars, options = {}) {
  const error = new Error(key)
  error.key = key
  error.vars = vars || {}
  if (options.retryable !== undefined) error.retryable = options.retryable
  return error
}

function bvidFromLocation() {
  return location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1] || ''
}

/** 番剧/影视页：/bangumi/play/ep123 或 /bangumi/play/ss123（可能带 ?ep_id=）。 */
function bilibiliBangumiRoute() {
  const match = location.pathname.match(/\/bangumi\/play\/(ep|ss)(\d+)/)
  if (!match) return null
  return { type: match[1], id: Number(match[2]) }
}

function xhsNoteIdFromLocation() {
  return location.pathname.match(/\/(?:explore|discovery\/item)\/([0-9a-f]+)/)?.[1] || ''
}

async function bilibiliView(bvid) {
  const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
    credentials: 'include'
  })
  if (!res.ok) throw nativeError('native.bilibili.viewFetchFailed', { status: res.status })
  const body = await res.json()
  if (body.code !== 0) {
    // 站点自己返回了错误文案就原样透传（不带 key）；没有时用带 key 的兜底文案
    if (body.message) throw new Error(body.message)
    throw nativeError('native.bilibili.viewFailed')
  }
  return body.data || {}
}

async function bilibiliPlayurl(url) {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw nativeError('native.bilibili.playurlFetchFailed', { status: res.status })
  const body = await res.json()
  if (body.code !== 0) {
    if (body.message) throw new Error(body.message)
    throw nativeError('native.bilibili.playurlFailed')
  }
  return body
}

/** fnval=4048 一次性拿到 DASH（8K/4K/HDR/杜比 + 普通 AAC 音轨）。 */
function bilibiliPlayurlQuery(fnval) {
  return `qn=127&fnval=${fnval}&fourk=1&platform=pc&fnver=0`
}

function mediaWithNames(title, media) {
  return media.map((item, index) => ({
    url: item.url,
    kind: item.kind,
    fileName: mediaFileName(title, index, media.length, item.url, item.kind)
  }))
}

function clockOf(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * 账号没有完整观看权限时（充电专属 / 大会员 / 付费），B 站 playurl 仍返回 code=0，
 * 但只给试看片段。这里按缺口给出可操作的说明，而不是把一个 10 秒试看当正片入库。
 * 权限问题重试也没用（retryable=false），别让上层再解析一遍页面。
 */
function bilibiliPreviewError(body, context) {
  const coveredSec = Math.round(bilibiliCoveredMs(body) / 1000)
  const totalSec = Math.round((Number(context.fullDurationMs) || 0) / 1000)
  const span = `${clockOf(coveredSec)} / ${clockOf(totalSec)}`
  let error
  if (context.upowerExclusive && !context.upowerPlay) {
    error = nativeError('native.bilibili.upowerExclusive', { span }, { retryable: false })
  } else if (context.vip) {
    error = nativeError('native.bilibili.vipExclusive', { span }, { retryable: false })
  } else if (context.paid) {
    error = nativeError('native.bilibili.paidRequired', { span }, { retryable: false })
  } else {
    error = nativeError('native.bilibili.previewOnly', { span }, { retryable: false })
  }
  return error
}

/** 把 playurl 结果转成 media（DASH 走「视频轨 + 音频轨」，由 Falcon 合并）。 */
function bilibiliMediaFromPlayurl(body, title, context) {
  const gap = bilibiliPreviewGapMs(body, context.fullDurationMs)
  if (gap > 0) throw bilibiliPreviewError(body, context)

  const dash = selectBilibiliDash(body)
  if (dash.ok) {
    const baseName = `${sanitizeFileName(title, 'bilibili')}-${dash.video.quality}`
    const media = [
      { url: dash.video.url, kind: 'video', role: 'video', fileName: `${baseName}.mp4` }
    ]
    if (dash.audio?.url) media.push({ url: dash.audio.url, kind: 'video', role: 'audio' })
    return { media, quality: dash.video.quality, width: dash.video.width, height: dash.video.height }
  }

  const parsed = parseBilibiliPlayurl(body)
  if (!parsed.ok) {
    throw parsed.hasDash
      ? nativeError('native.bilibili.dashTrackUnavailable')
      : nativeError('native.bilibili.noMp4')
  }
  if (parsed.parts.some((part) => /\.flv(\?|$)/i.test(part.url))) {
    throw nativeError('native.bilibili.flvOnly')
  }
  return {
    media: mediaWithNames(title, parsed.parts.map((part) => ({ url: part.url, kind: 'video' }))),
    quality: parsed.quality
  }
}

async function resolveBilibiliUgc(bvid) {
  const info = parseBilibiliInitialState(window.__INITIAL_STATE__)
  let cid = info.cid
  let title = info.title
  let durationSec = info.durationSec
  const context = {
    upowerExclusive: info.upowerExclusive,
    upowerPlay: info.upowerPlay,
    paid: info.paid,
    vip: false,
    fullDurationMs: durationSec * 1000
  }
  if (!cid || !durationSec) {
    const view = await bilibiliView(bvid)
    cid = cid || Number(view.cid) || null
    title = title || view.title
    durationSec = durationSec || Number(view.duration) || 0
    context.upowerExclusive = context.upowerExclusive || Boolean(view.is_upower_exclusive)
    context.upowerPlay = context.upowerPlay || Boolean(view.is_upower_play)
    context.fullDurationMs = durationSec * 1000
  }
  if (!cid) throw nativeError('native.bilibili.ugcCidNotFound')
  const body = await bilibiliPlayurl(
    `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&${bilibiliPlayurlQuery(4048)}`
  )
  const displayTitle = title || document.title.replace(/\s*-\s*哔哩哔哩.*$/i, '').trim() || bvid
  const built = bilibiliMediaFromPlayurl(body, displayTitle, context)
  return {
    ok: true,
    site: 'bilibili',
    title: displayTitle,
    kind: 'video',
    quality: built.quality,
    width: built.width,
    height: built.height,
    sourceUrl: location.href,
    pageTitle: document.title,
    media: built.media
  }
}

async function resolveBilibiliPgc(route) {
  // ss 页通常会被站点跳到 ep；带 ?ep_id= 时以它为准，否则取 season 的第一集
  const queryEp = Number(new URLSearchParams(location.search).get('ep_id')) || 0
  const epId = route.type === 'ep' ? route.id : queryEp
  const seasonParam = route.type === 'ep' ? `ep_id=${route.id}` : `season_id=${route.id}`
  const res = await fetch(`https://api.bilibili.com/pgc/view/web/season?${seasonParam}`, {
    credentials: 'include'
  })
  if (!res.ok) throw nativeError('native.bilibili.seasonFetchFailed', { status: res.status })
  const seasonBody = await res.json()
  if (seasonBody.code !== 0) {
    if (seasonBody.message) throw new Error(seasonBody.message)
    throw nativeError('native.bilibili.seasonFailed')
  }
  const season = parseBilibiliPgcSeason(seasonBody, epId)
  if (!season.ok || !season.cid) throw nativeError('native.bilibili.pgcCidNotFound')
  const episodeTitle = season.episodeTitle
  const displayTitle =
    [season.title, episodeTitle].filter(Boolean).join(' ') || document.title.replace(/\s*-\s*哔哩哔哩.*$/i, '').trim()
  const body = await bilibiliPlayurl(
    `https://api.bilibili.com/pgc/player/web/playurl?ep_id=${season.epId}&cid=${season.cid}&${bilibiliPlayurlQuery(4048)}`
  )
  const built = bilibiliMediaFromPlayurl(body, displayTitle, {
    upowerExclusive: false,
    upowerPlay: true,
    paid: false,
    vip: season.vip,
    fullDurationMs: season.durationSec * 1000
  })
  return {
    ok: true,
    site: 'bilibili',
    title: displayTitle,
    kind: 'video',
    quality: built.quality,
    width: built.width,
    height: built.height,
    sourceUrl: location.href,
    pageTitle: document.title,
    media: built.media
  }
}

async function resolveBilibili() {
  const bangumi = bilibiliBangumiRoute()
  if (bangumi) return resolveBilibiliPgc(bangumi)
  const bvid = bvidFromLocation()
  if (!bvid) throw nativeError('native.bilibili.unsupportedPage')
  return resolveBilibiliUgc(bvid)
}

function douyinRouterData() {
  if (window._ROUTER_DATA) return window._ROUTER_DATA
  const el = document.querySelector('#RENDER_DATA')
  if (el?.textContent) {
    try {
      return JSON.parse(decodeURIComponent(el.textContent))
    } catch {
      // 继续尝试 __INITIAL_STATE__
    }
  }
  return window.__INITIAL_STATE__ || null
}

function hasPlayerMediaShape(media) {
  return Boolean(media && (media.awemeId || media.aweme_id) && (media.video || Array.isArray(media.images)))
}

function readDouyinPlayerMedia() {
  try {
    const player = window.player || window.__falconDouyinPlayer
    if (!player) return null
    const plugins = player?._config?._config?.pluginsConfig
    if (plugins && typeof plugins === 'object') {
      for (const key of ['WatchLaterPlugin', 'DanmakuPlugin', 'PlayClaritySettingPlugin', 'Pip']) {
        try {
          const info = plugins[key]?.awemeInfo
          if (hasPlayerMediaShape(info)) return info
        } catch {
          // 单个插件 Proxy 抛错不影响其他插件
        }
      }
      try {
        for (const value of Object.values(plugins)) {
          const info = value?.awemeInfo
          if (hasPlayerMediaShape(info)) return info
        }
      } catch {
        // pluginsConfig 本身不可枚举时走已知 key / SSR
      }
    }
    if (hasPlayerMediaShape(player?.config?.awemeInfo)) return player.config.awemeInfo
    if (hasPlayerMediaShape(player?.controls?.playerConfig?.awemeInfo)) return player.controls.playerConfig.awemeInfo
  } catch {
    // 播放器内部 Proxy 可能抛错，继续走 SSR 数据兜底
  }
  return null
}

function resolveDouyin() {
  let parsed = parseDouyinRouterData(readDouyinPlayerMedia())
  if (!parsed.ok) parsed = parseDouyinRouterData(douyinRouterData())
  if (!parsed.ok) throw nativeError('native.douyin.noData')
  const title = parsed.title || 'douyin'
  // 正在播放的 <video>.currentSrc 是浏览器刚解析出的 CDN 直链，比播放器数据里的
  // playApi 包装地址更新鲜（playApi 过期会 403/空响应）。拿到就直接排为首选。
  const playing = playingVideoUrl()
  if (playing && parsed.kind === 'video' && parsed.media.length === 1) {
    parsed.media[0].url = playing
  }
  return {
    ok: true,
    site: 'douyin',
    title,
    kind: parsed.kind,
    sourceUrl: location.href,
    pageTitle: document.title,
    media: mediaWithNames(title, parsed.media)
  }
}

/** 取当前正在播放的 video 元素直链（跳过 blob:/m3u8，选画面最大且在播的那个）。 */
function playingVideoUrl() {
  let best = ''
  let bestArea = 0
  for (const video of document.querySelectorAll('video')) {
    const src = video.currentSrc || video.src || ''
    if (!/^https?:/i.test(src)) continue
    if (/\.m3u8(\?|$)|\.mpd(\?|$)/i.test(src)) continue
    const area = (video.videoWidth || 0) * (video.videoHeight || 0)
    const playing = !video.paused && video.currentTime > 0
    const score = (playing ? 1e12 : 0) + area
    if (area > 0 && score > bestArea) {
      bestArea = score
      best = src
    }
  }
  return best
}

function resolveXiaohongshu() {
  const state = window.__INITIAL_STATE__ || window.__INITIAL_SSR_STATE__ || null
  const parsed = parseXiaohongshuState(state, xhsNoteIdFromLocation())
  if (!parsed.ok) {
    throw parsed.reason === 'video_url_missing'
      ? nativeError('native.xiaohongshu.videoUrlMissing')
      : nativeError('native.xiaohongshu.noData')
  }
  const title = parsed.title || 'xiaohongshu'
  return {
    ok: true,
    site: 'xiaohongshu',
    title,
    kind: parsed.kind,
    sourceUrl: location.href,
    pageTitle: document.title,
    media: mediaWithNames(title, parsed.media)
  }
}

/* ─────────────── 国际站点（解析入口） ─────────────── */

// innertube 公共 Web key（youtube 网页自身使用，非机密）；优先读页面 ytcfg
const YT_INNERTUBE_KEY = 'AIzaSyAO_FJ2IrBoYIk1a-Fi-GIWfTfKmGEAuVI'

function youtubeVideoId() {
  if (location.hostname === 'youtu.be') return location.pathname.match(/^\/([\w-]{11})/)?.[1] || ''
  return (
    location.search.match(/[?&]v=([\w-]{11})/)?.[1] ||
    location.pathname.match(/\/(?:shorts|embed|live|v)\/([\w-]{11})/)?.[1] ||
    ''
  )
}

async function youtubePlayerFromAndroid(videoId) {
  const key = window.ytcfg?.get?.('INNERTUBE_API_KEY') || YT_INNERTUBE_KEY
  const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${key}&prettyPrint=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      videoId,
      // ANDROID client 的响应通常带明文 url，不需要页面播放器 JS 做 signature decipher
      context: { client: { clientName: 'ANDROID', clientVersion: '19.09.37', androidSdkVersion: 30, hl: 'en' } }
    })
  })
  if (!res.ok) throw nativeError('native.youtube.playerFetchFailed', { status: res.status })
  return res.json()
}

function youtubeError(parsed) {
  let error
  if (parsed?.reason === 'login_required') {
    error = nativeError('native.youtube.loginRequired', undefined, { retryable: false })
  } else if (parsed?.reason === 'needs_decipher') {
    error = nativeError('native.youtube.needsDecipher')
  } else if (parsed?.reason === 'unplayable') {
    // 可选原因不拼进变量：带 / 不带原因各一个 key，标点交给各语言词典
    error = parsed.detail
      ? nativeError('native.youtube.unplayableWithReason', { reason: parsed.detail })
      : nativeError('native.youtube.unplayable')
  } else {
    error = nativeError('native.youtube.noStream')
  }
  return error
}

async function resolveYouTube() {
  const videoId = youtubeVideoId()
  if (!videoId) throw nativeError('native.youtube.unsupportedPage')
  // 1) watch 页自带的 player response：若有明文 url 流直接用（含标题，省一次 API 调用）
  let parsed = parseYoutubePlayerResponse(window.ytInitialPlayerResponse || null)
  if (!parsed.ok) {
    // 2) ANDROID client player API：通常带明文直链
    parsed = parseYoutubePlayerResponse(await youtubePlayerFromAndroid(videoId))
  }
  if (!parsed.ok) throw youtubeError(parsed)
  const title = parsed.title || document.title.replace(/\s*-\s*YouTube.*$/i, '').trim() || videoId
  return {
    ok: true,
    site: 'youtube',
    title,
    kind: 'video',
    quality: parsed.quality,
    width: parsed.width,
    height: parsed.height,
    sourceUrl: location.href,
    pageTitle: document.title,
    media: mediaWithNames(title, parsed.media)
  }
}

function tiktokRehydrationPayload() {
  const el = document.querySelector('script#__UNIVERSAL_DATA_FOR_REHYDRATION__')
  if (el?.textContent) {
    try {
      return JSON.parse(el.textContent)
    } catch {
      // 新版数据损坏时走旧版 SIGI_STATE
    }
  }
  return null
}

function tiktokLegacyPayload() {
  const el = document.querySelector('script#SIGI_STATE')
  if (el?.textContent) {
    try {
      return JSON.parse(el.textContent)
    } catch {
      // 两套数据都没有时走空态
    }
  }
  return null
}

async function resolveTikTok() {
  let parsed = parseTikTokRehydration(tiktokRehydrationPayload())
  if (!parsed.ok) parsed = parseTikTokLegacy(tiktokLegacyPayload())
  if (!parsed.ok) {
    throw parsed.reason === 'private'
      ? nativeError('native.tiktok.private', undefined, { retryable: false })
      : nativeError('native.tiktok.noData')
  }
  const title = parsed.title || 'tiktok'
  // 正在播放的 video.currentSrc 是刚解析出的 CDN 直链，比页面数据里的地址更新鲜
  const playing = playingVideoUrl()
  if (playing && parsed.kind === 'video' && parsed.media.length === 1) {
    parsed.media[0].url = playing
  }
  return {
    ok: true,
    site: 'tiktok',
    title,
    kind: parsed.kind,
    sourceUrl: location.href,
    pageTitle: document.title,
    media: mediaWithNames(title, parsed.media)
  }
}

async function resolveTwitter() {
  // 支持 /:user/status/:id 与 /i/web/status/:id（x.com 与 twitter.com）
  const statusId = location.pathname.match(/\/status(?:es)?\/(\d+)/)?.[1]
  if (!statusId) throw nativeError('native.twitter.unsupportedPage')
  // 嵌入组件公共端点：公开推文免登录，页面上下文 fetch 无 CORS 阻碍
  const res = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${statusId}&token=x&lang=en`)
  if (!res.ok) throw nativeError('native.twitter.tweetFetchFailed', { status: res.status })
  const parsed = parseTwitterTweetResult(await res.json())
  if (!parsed.ok) {
    if (parsed.reason === 'no_media') throw nativeError('native.twitter.noMedia')
    throw parsed.detail
      ? nativeError('native.twitter.mediaFailedWithReason', { reason: parsed.detail })
      : nativeError('native.twitter.mediaFailed')
  }
  const title = parsed.title || `tweet-${statusId}`
  return {
    ok: true,
    site: 'twitter',
    title,
    kind: parsed.kind,
    sourceUrl: location.href,
    pageTitle: document.title,
    media: mediaWithNames(title, parsed.media)
  }
}

function instagramShortcode() {
  return location.pathname.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/)?.[1] || ''
}

/** 帖子页内嵌的 GraphQL JSON（script[type=application/json] 里含 web_info 键）。 */
function instagramEmbeddedWebInfo() {
  for (const el of document.querySelectorAll('script[type="application/json"]')) {
    const text = el.textContent || ''
    if (!text.includes('xdt_api__v1__media__shortcode__web_info')) continue
    try {
      return JSON.parse(text)
    } catch {
      // 单个 script 解析失败不影响其他
    }
  }
  return null
}

function ogMetaContent(name) {
  return document.querySelector(`meta[property="${name}"]`)?.content || ''
}

function resolveInstagram() {
  const shortcode = instagramShortcode()
  if (!shortcode) throw nativeError('native.instagram.unsupportedPage')
  let parsed = parseInstagramWebInfo(instagramEmbeddedWebInfo(), shortcode)
  if (!parsed.ok) {
    // og 元标签兜底：公开帖未登录也能拿到的最小信息
    parsed = parseInstagramOgMeta({
      ogVideo: ogMetaContent('og:video') || ogMetaContent('og:video:url'),
      ogImage: ogMetaContent('og:image'),
      ogTitle: ogMetaContent('og:title')
    })
  }
  if (!parsed.ok) {
    throw parsed.reason === 'video_url_missing'
      ? nativeError('native.instagram.videoUrlMissing')
      : nativeError('native.instagram.noData', undefined, { retryable: false })
  }
  const title = parsed.title || `instagram-${shortcode}`
  return {
    ok: true,
    site: 'instagram',
    title,
    kind: parsed.kind,
    sourceUrl: location.href,
    pageTitle: document.title,
    media: mediaWithNames(title, parsed.media)
  }
}

function vimeoClipId() {
  // vimeo.com/{id}、vimeo.com/channels/x/{id}、player.vimeo.com/video/{id}
  return location.pathname.match(/\/(?:video\/)?(\d{6,})(?:[/?#]|$)/)?.[1] || ''
}

async function resolveVimeo() {
  const clipId = vimeoClipId()
  if (!clipId) throw nativeError('native.vimeo.unsupportedPage')
  let payload = window.playerConfig || null
  if (!payload) {
    const res = await fetch(`https://player.vimeo.com/video/${clipId}/config`, { credentials: 'omit' })
    if (!res.ok) throw nativeError('native.vimeo.configFetchFailed', { status: res.status })
    payload = await res.json()
  }
  const parsed = parseVimeoConfig(payload)
  if (!parsed.ok) {
    throw parsed.reason === 'dash_only'
      ? nativeError('native.vimeo.dashOnly', undefined, { retryable: false })
      : nativeError('native.vimeo.noUrl')
  }
  const title = parsed.title || `vimeo-${clipId}`
  return {
    ok: true,
    site: 'vimeo',
    title,
    kind: 'video',
    quality: parsed.quality,
    sourceUrl: location.href,
    pageTitle: document.title,
    media: mediaWithNames(title, parsed.media)
  }
}

window.__falconResolveNative = async () => {
  try {
    const host = location.hostname
    if (host === 'bilibili.com' || host.endsWith('.bilibili.com')) return await resolveBilibili()
    if (host === 'douyin.com' || host.endsWith('.douyin.com')) return resolveDouyin()
    if (host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com') || host.endsWith('.rednote.com')) {
      return resolveXiaohongshu()
    }
    if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return await resolveYouTube()
    if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return await resolveTikTok()
    if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) {
      return await resolveTwitter()
    }
    if (host === 'instagram.com' || host.endsWith('.instagram.com') || host === 'instagr.am') {
      return await resolveInstagram()
    }
    if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) return await resolveVimeo()
    return { ok: false, message: 'native.unsupportedSite', key: 'native.unsupportedSite' }
  } catch (e) {
    // retryable=false：权限类失败（登录/版权/私密内容），重新解析页面也不会变
    return { ok: false, message: String(e?.message || e), key: e?.key, vars: e?.vars, retryable: e?.retryable !== false }
  }
}

/**
 * 页面元数据读取（MAIN world 专用，弹窗预览增强）：
 * 视频 CDN 直链在弹窗上下文里会被站点拒绝（Referer/Cookie 校验），预览不了的流媒体
 * 卡片改用封面图展示；封面是普通图片，弹窗可以直接加载。
 * 按 durationMs 匹配 video 元素，页面内多个视频也能对上是哪一个。
 */
window.__falconPageMeta = () => {
  const videos = [...document.querySelectorAll('video')].map((video, index) => ({
    index,
    durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0,
    area: (video.videoWidth || 0) * (video.videoHeight || 0),
    playing: !video.paused && video.currentTime > 0,
    poster: video.poster || ''
  }))
  try {
    const host = location.hostname
    if (host === 'douyin.com' || host.endsWith('.douyin.com')) {
      const video = readDouyinPlayerMedia()?.video || {}
      const cover = douyinCoverUrl(video)
      if (cover) {
        return { videos, cover: { url: cover, durationMs: Number(video.duration) || 0, origin: 'douyin' } }
      }
      return { videos }
    }
    if (host === 'bilibili.com' || host.endsWith('.bilibili.com')) {
      const pic = window.__INITIAL_STATE__?.videoData?.pic
      if (pic) {
        return { videos, cover: { url: String(pic), durationMs: 0, origin: 'bilibili' } }
      }
      return { videos }
    }
    if (host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com') || host.endsWith('.rednote.com')) {
      const map = window.__INITIAL_STATE__?.note?.noteDetailMap || {}
      const entry = Object.values(map).pop()
      const note = entry?.note || entry
      const poster =
        note?.video?.image?.poster ||
        note?.video?.imageList?.[0]?.urlDefault ||
        note?.imageList?.[0]?.urlDefault ||
        ''
      if (poster && (note?.video || note?.type === 'video')) {
        return { videos, cover: { url: String(poster), durationMs: 0, origin: 'xiaohongshu' } }
      }
      return { videos }
    }
    if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') {
      const thumbs = window.ytInitialPlayerResponse?.videoDetails?.thumbnail?.thumbnails || []
      const best = thumbs.length > 0 ? thumbs[thumbs.length - 1]?.url : ''
      if (best) return { videos, cover: { url: String(best), durationMs: 0, origin: 'youtube' } }
      return { videos }
    }
    if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
      const scope = tiktokRehydrationPayload()?.__DEFAULT_SCOPE__ || {}
      const itemStruct = scope['webapp.video-detail']?.itemInfo?.itemStruct
      const cover = tiktokCoverUrl(itemStruct)
      if (cover) {
        return { videos, cover: { url: cover, durationMs: Number(itemStruct?.video?.duration) * 1000 || 0, origin: 'tiktok' } }
      }
      return { videos }
    }
    if (host === 'instagram.com' || host.endsWith('.instagram.com')) {
      const og = ogMetaContent('og:image')
      if (og) return { videos, cover: { url: String(og), durationMs: 0, origin: 'instagram' } }
      return { videos }
    }
    if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
      const thumb =
        window.playerConfig?.video?.thumbs?.base ||
        window.playerConfig?.clip?.thumbs?.base ||
        ''
      if (thumb) return { videos, cover: { url: String(thumb), durationMs: 0, origin: 'vimeo' } }
      return { videos }
    }
  } catch {
    // 播放器内部结构变化时静默降级：弹窗只显示占位卡片
  }
  return { videos }
}
