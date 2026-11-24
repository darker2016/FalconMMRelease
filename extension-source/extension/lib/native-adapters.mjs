// 原生站内下载的纯解析函数（页面注入脚本与单元测试共用）。
// 只处理「当前页面已经拿到的数据」，不逆向站点签名：
// - B 站：__INITIAL_STATE__ 取 cid，playurl fnval=1 取单文件 MP4（带音轨）
// - 抖音：_ROUTER_DATA / RENDER_DATA 取 play_addr 或图集
// - 小红书：__INITIAL_STATE__.note.noteDetailMap 取视频/图片

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function normalizeUrl(value) {
  if (!value) return ''
  const raw = String(value).trim()
  if (!raw) return ''
  if (raw.startsWith('//')) return `https:${raw}`
  return raw
}

export function sanitizeFileName(value, fallback = 'download') {
  const clean = String(value || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return clean || fallback
}

export function extFromUrl(url, kind) {
  try {
    const path = new URL(normalizeUrl(url)).pathname
    const match = /\.([a-z0-9]{2,5})$/i.exec(path)
    if (match) return match[1].toLowerCase()
  } catch {
    // 非法 URL 回退按媒体类型给默认扩展名
  }
  return kind === 'image' ? 'jpg' : 'mp4'
}

export function mediaFileName(title, index, total, url, kind) {
  const suffix = total > 1 ? `-${index + 1}` : ''
  return `${sanitizeFileName(title, kind === 'image' ? 'image' : 'video')}${suffix}.${extFromUrl(url, kind)}`
}

function uniqueMedia(items) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    if (!item?.url) continue
    const url = normalizeUrl(item.url)
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push({ ...item, url })
  }
  return out
}

/* ---------------- B 站 ---------------- */

/** dash.video[].id（清晰度编号）→ 展示标签。 */
const BILIBILI_QUALITY_LABELS = {
  127: '8K',
  126: '杜比视界',
  125: 'HDR',
  120: '4K',
  116: '1080P60',
  112: '1080P+',
  80: '1080P',
  74: '720P60',
  64: '720P',
  32: '480P',
  16: '360P'
}

/** 同分辨率下的编码偏好：AVC 兼容性最好，其次 HEVC，最后 AV1。 */
const BILIBILI_CODEC_PREF = { 7: 0, 12: 1, 13: 2 }

export function bilibiliQualityLabel(id) {
  return BILIBILI_QUALITY_LABELS[Number(id)] || String(id || '') || '未知清晰度'
}

/** UGC playurl 把结果放在 data，PGC playurl 放在 result，统一取值。 */
function bilibiliPayloadData(payload) {
  return payload?.data ?? payload?.result ?? payload ?? {}
}

export function parseBilibiliInitialState(state) {
  const data = state && typeof state === 'object' ? state : {}
  const videoData = data.videoData && typeof data.videoData === 'object' ? data.videoData : {}
  const rights = videoData.rights && typeof videoData.rights === 'object' ? videoData.rights : {}
  return {
    bvid: String(videoData.bvid || data.bvid || ''),
    cid: Number(videoData.cid || data.cid || 0) || null,
    title: String(videoData.title || data.title || '').trim(),
    durationSec: Number(videoData.duration || data.duration || 0) || 0,
    // UP 主充电专属视频：upower_play=false 表示当前账号没有充电（只能拿试看）
    upowerExclusive: Boolean(videoData.is_upower_exclusive || data.is_upower_exclusive),
    upowerPlay: Boolean(videoData.is_upower_play || data.is_upower_play),
    // 付费稿件（pay / ugc_pay / arc_pay 任一非 0）
    paid: Boolean(Number(rights.pay) || Number(rights.ugc_pay) || Number(rights.arc_pay))
  }
}

/** 番剧/影视 season 数据：定位当前 ep，拿到 cid 与「是否会员专享」。 */
export function parseBilibiliPgcSeason(season, epId) {
  const result = season?.result ?? season?.data ?? season ?? {}
  const episodes = Array.isArray(result.episodes) ? result.episodes : []
  if (episodes.length === 0) {
    return { ok: false, reason: 'no_episodes', title: '', episodeTitle: '', epId: null, cid: null, durationSec: 0, vip: false }
  }
  const target = episodes.find((e) => String(e?.id) === String(epId)) || episodes[0]
  const badge = String(target?.badge || '')
  return {
    ok: true,
    epId: Number(target?.id) || null,
    cid: Number(target?.cid) || null,
    aid: Number(target?.aid) || null,
    title: String(result.title || target?.title || '').trim(),
    episodeTitle: String(target?.title || '').trim(),
    // PGC 的 duration 是毫秒
    durationSec: Math.round((Number(target?.duration) || 0) / 1000) || 0,
    vip: /会员|专享|付费/.test(badge)
  }
}

export function parseBilibiliPlayurl(payload) {
  const data = bilibiliPayloadData(payload)
  const durl = Array.isArray(data.durl) ? data.durl : []
  const parts = durl
    .map((part, index) => ({
      order: Number(part?.order ?? index + 1),
      url: normalizeUrl(part?.url),
      backupUrls: [...(part?.backup_url || part?.backupUrl || [])].map(normalizeUrl).filter(Boolean),
      size: Number(part?.size || 0) || null,
      lengthMs: Number(part?.length || 0) || 0
    }))
    .filter((part) => part.url)
  return {
    ok: parts.length > 0,
    parts,
    quality: Number(data.quality || 0) || null,
    format: String(data.format || ''),
    timelengthMs: Number(data.timelength) || 0,
    hasDash: Boolean(data.dash && (data.dash.video?.length || data.dash.audio?.length))
  }
}

/**
 * 从 DASH 结果里选一路视频 + 一路音频。
 * - 默认避开 HDR(125) / 杜比视界(126)：SDR 文件在任何播放器里都不会偏色；
 * - 分辨率最高的；同分辨率优先 AVC，其次 HEVC/AV1；
 * - 音轨取 AAC 里码率最高的一路（杜比/FLAC 不参与，避免 MP4 容器兼容问题）。
 */
export function selectBilibiliDash(payload) {
  const data = bilibiliPayloadData(payload)
  const dash = data.dash && typeof data.dash === 'object' ? data.dash : {}
  const urlOf = (track) => normalizeUrl(track?.baseUrl || track?.base_url || track?.baseURL || '')
  const videos = (Array.isArray(dash.video) ? dash.video : []).filter(
    (t) => t && urlOf(t) && Number(t.height || 0) > 0
  )
  const audios = (Array.isArray(dash.audio) ? dash.audio : []).filter((t) => t && urlOf(t))
  const durationMs =
    Number(data.timelength) || (Number(dash.duration) > 0 ? Math.round(Number(dash.duration) * 1000) : 0) || 0
  if (videos.length === 0) return { ok: false, video: null, audio: null, durationMs }
  const sdr = videos.filter((t) => ![125, 126].includes(Number(t.id)))
  const pool = sdr.length > 0 ? sdr : videos
  const best = [...pool].sort((a, b) => {
    const byHeight = Number(b.height || 0) - Number(a.height || 0)
    if (byHeight !== 0) return byHeight
    const byCodec = (BILIBILI_CODEC_PREF[Number(a.codecid)] ?? 9) - (BILIBILI_CODEC_PREF[Number(b.codecid)] ?? 9)
    if (byCodec !== 0) return byCodec
    return Number(b.bandwidth || 0) - Number(a.bandwidth || 0)
  })[0]
  const audio = [...audios].sort((a, b) => Number(b.bandwidth || 0) - Number(a.bandwidth || 0))[0] || null
  return {
    ok: true,
    video: {
      url: urlOf(best),
      id: Number(best.id) || null,
      quality: bilibiliQualityLabel(best.id),
      width: Number(best.width) || 0,
      height: Number(best.height) || 0,
      codecid: Number(best.codecid) || null,
      codecs: String(best.codecs || ''),
      bandwidth: Number(best.bandwidth) || 0
    },
    audio: audio
      ? {
          url: urlOf(audio),
          id: Number(audio.id) || null,
          codecs: String(audio.codecs || ''),
          bandwidth: Number(audio.bandwidth) || 0
        }
      : null,
    durationMs
  }
}

/** 本次 playurl 实际覆盖的时长（毫秒）：durl 累加，DASH 取 dash.duration。 */
export function bilibiliCoveredMs(payload) {
  const data = bilibiliPayloadData(payload)
  const durl = Array.isArray(data.durl) ? data.durl : []
  const fromDurl = durl.reduce((sum, part) => sum + (Number(part?.length) || 0), 0)
  if (fromDurl > 0) return fromDurl
  const dash = data.dash && typeof data.dash === 'object' ? data.dash : {}
  const dashSeconds = Number(dash.duration) || 0
  return dashSeconds > 0 ? Math.round(dashSeconds * 1000) : 0
}

/**
 * 试看缺口：充电专属 / 大会员 / 付费内容在账号没有权限时，接口仍返回 code=0，
 * 但 durl 只有试看片段（timelength 是全片时长）。缺口 > 3 秒即判定为「只拿到试看」。
 */
export function bilibiliPreviewGapMs(payload, fullDurationMs) {
  const data = bilibiliPayloadData(payload)
  const covered = bilibiliCoveredMs(payload)
  const expected = Number(fullDurationMs) || Number(data.timelength) || 0
  if (!covered || !expected) return 0
  return covered + 3000 < expected ? expected - covered : 0
}

/* ---------------- 抖音 ---------------- */

function hasVideoShape(video) {
  if (!video || typeof video !== 'object') return false
  return Boolean(
    video.play_addr ||
      video.playAddr ||
      video.playApi ||
      video.play_api ||
      video.playApiH265 ||
      video.bit_rate ||
      video.bitRate ||
      video.bitRateList ||
      video.bit_rate_list
  )
}

function findAweme(node, depth = 0, seen = new Set()) {
  if (!node || typeof node !== 'object' || depth > 10 || seen.has(node)) return null
  seen.add(node)
  if (hasVideoShape(node.video)) return node
  if (Array.isArray(node.images) && node.images.length > 0 && (node.desc !== undefined || node.aweme_id || node.awemeId)) {
    return node
  }
  for (const value of Object.values(node)) {
    const found = findAweme(value, depth + 1, seen)
    if (found) return found
  }
  return null
}

function firstUrl(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = firstUrl(item)
      if (url) return url
    }
    return ''
  }
  return value.src || value.url || value.url_list?.[0] || value.urlList?.[0] || ''
}

function bestBitRateUrl(video) {
  const list = video.bitRateList || video.bit_rate_list || video.bit_rate || video.bitRate
  if (!Array.isArray(list)) return ''
  const candidates = list
    .filter((item) => item && item.format !== 'dash')
    .map((item) => ({
      url: douyinPlayAddrUrl(item.playAddr || item.play_addr) || firstUrl(item.playApi || item.play_api),
      area: Number(item.width || 0) * Number(item.height || 0),
      size: Number(item.dataSize || item.data_size || 0)
    }))
    .filter((item) => item.url)
  candidates.sort((a, b) => b.area - a.area || b.size - a.size)
  return candidates[0]?.url || ''
}

/** playAddr 是 [{src}] / {url_list} 数组结构，src 指向 douyinvod CDN 直链。 */
function douyinPlayAddrUrl(value) {
  if (!value) return ''
  if (typeof value === 'string') return normalizeUrl(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      const url =
        typeof item === 'string'
          ? item
          : item?.src || item?.url || firstUrl(item?.url_list || item?.urlList)
      if (url) return normalizeUrl(url)
    }
    return ''
  }
  return firstUrl(value)
}

/**
 * 抖音候选地址按可靠性排序：
 * 1. playAddr[].src —— 浏览器实际播放的 douyinvod CDN 直链，签名随页面会话刷新；
 * 2. bitRateList 最高分辨率档的 playAddr[].src；
 * 3. playApi —— www.douyin.com/aweme/v1/play/ 包装地址，302 到 CDN，但 biz_sign 短时效
 *    且过期后返回 200 空体/403，所以只作为兜底，不作为首选。
 */
export function douyinVideoUrlCandidates(video) {
  if (!video || typeof video !== 'object') return []
  const out = []
  const push = (url) => {
    const clean = normalizeUrl(url)
    if (clean && !out.includes(clean)) out.push(clean)
  }
  push(douyinPlayAddrUrl(video.playAddr || video.play_addr))
  push(bestBitRateUrl(video))
  push(firstUrl(video.playApi || video.play_api))
  push(firstUrl(video.playApiH265 || video.play_api_h265))
  push(douyinPlayAddrUrl(video.download_addr || video.downloadAddr))
  return out
}

function douyinVideoUrl(video) {
  return douyinVideoUrlCandidates(video)[0] || ''
}

/** 抖音封面：弹窗预览用（视频 CDN 直链在弹窗里加载不了，图片可以）。 */
export function douyinCoverUrl(video) {
  if (!video || typeof video !== 'object') return ''
  return (
    douyinPlayAddrUrl(video.cover) ||
    firstUrl(video.originCover || video.origin_cover) ||
    douyinPlayAddrUrl(video.rawCover || video.raw_cover) ||
    firstUrl(video.dynamicCover || video.dynamic_cover) ||
    ''
  )
}

function douyinImageUrl(image) {
  if (!image || typeof image !== 'object') return ''
  return (
    firstUrl(image.urlList) ||
    firstUrl(image.url_list) ||
    firstUrl(image.downloadUrlList) ||
    firstUrl(image.download_url_list)
  )
}

/**
 * 兼容两种抖音数据：
 * 1. SSR `_ROUTER_DATA` / `RENDER_DATA`：video.play_addr.url_list
 * 2. 新版播放器 awemeInfo：video.playApi / playAddr[].src / bitRateList
 */
export function parseDouyinRouterData(root) {
  const aweme = findAweme(root)
  if (!aweme) return { ok: false, reason: 'no_aweme', title: '', media: [] }
  const title = String(aweme.desc || aweme.aweme_id || aweme.awemeId || '').trim()
  const images = Array.isArray(aweme.images) ? aweme.images : []
  if (images.length > 0) {
    const media = []
    for (const image of images) {
      if (image?.video) {
        const videoUrl = douyinVideoUrl(image.video)
        if (videoUrl) media.push({ url: videoUrl, kind: 'video' })
        continue
      }
      const url = douyinImageUrl(image)
      if (url) media.push({ url, kind: 'image' })
    }
    return { ok: media.length > 0, title, kind: 'images', media: uniqueMedia(media) }
  }
  const url = douyinVideoUrl(aweme.video)
  const media = url ? [{ url, kind: 'video' }] : []
  return { ok: media.length > 0, title, kind: 'video', media: uniqueMedia(media) }
}

/* ---------------- 小红书 ---------------- */

export function parseXiaohongshuState(state, noteId) {
  const map = state?.note?.noteDetailMap
  if (!map || typeof map !== 'object') return { ok: false, reason: 'no_note', title: '', media: [] }
  const ids = Object.keys(map)
  // 页面常把推荐流/浮层卡片也塞进 noteDetailMap；当前笔记在最后一项，
  // 只有 URL 里的 noteId 能精确命中时才用它，否则取最后一项（与 XHS-Downloader 一致）。
  const key = noteId && map[noteId] ? noteId : ids[ids.length - 1]
  const entry = key ? map[key] : null
  const note = entry?.note || entry
  if (!note) return { ok: false, reason: 'no_note', title: '', media: [] }
  const title = String(note.title || note.desc || '').trim()
  const type = String(note.type || '').toLowerCase()

  const stream = note.video?.media?.stream || {}
  const streams = Object.values(stream)
    .flat()
    .filter((item) => item && typeof item === 'object')
    .sort((a, b) => {
      const area = (x) => Number(x.height || 0) * Number(x.width || 0)
      return area(b) - area(a) || Number(b.videoBitrate || 0) - Number(a.videoBitrate || 0)
    })
  const videoTrack = streams[0]
  const originKey = note.video?.consumer?.originVideoKey
  const videoUrl =
    (originKey ? `https://sns-video-bd.xhscdn.com/${originKey}` : '') ||
    videoTrack?.backupUrls?.[0] ||
    videoTrack?.masterUrl ||
    videoTrack?.master_url ||
    videoTrack?.backup_urls?.[0] ||
    ''

  // 只要识别为视频笔记，就绝不再回退到 imageList：
  // 视频笔记的 imageList 第一张是封面，回退会把封面当视频下载。
  if (note.video || type === 'video') {
    if (!videoUrl) return { ok: false, reason: 'video_url_missing', title, media: [] }
    return { ok: true, title, kind: 'video', media: uniqueMedia([{ url: videoUrl, kind: 'video' }]) }
  }

  const images = Array.isArray(note.imageList) ? note.imageList : []
  const media = []
  for (const image of images) {
    const url =
      image?.urlDefault ||
      image?.url_default ||
      image?.urlPre ||
      image?.url_pre ||
      image?.infoList?.[0]?.url ||
      image?.info_list?.[0]?.url
    if (url) media.push({ url, kind: 'image' })
  }
  return { ok: media.length > 0, title, kind: 'images', media: uniqueMedia(media) }
}

/* ---------------- YouTube ----------------
 * 数据源：watch 页的 ytInitialPlayerResponse（或 innertube /player 响应，结构一致）。
 * 注意：只有「带明文 url」的流可用——signatureCipher / s 字段的流需要站点播放器 JS
 * 做 decipher，这里不做逆向；明文流通常来自 ANDROID 等 client 的 player 响应。
 */

function youtubeSortKey(item) {
  const height = Number(item?.height || 0)
  const bitrate = Number(item?.bitrate || 0)
  return height * 1e9 + bitrate
}

function isYoutubeVideoStream(item) {
  const mime = String(item?.mimeType || '')
  return /video\//i.test(mime) && !/audio\//i.test(mime)
}

function isYoutubeAudioStream(item) {
  return /audio\//i.test(String(item?.mimeType || ''))
}

export function parseYoutubePlayerResponse(payload) {
  const data = payload ?? {}
  const status = String(data.playabilityStatus?.status || '')
  if (status && status !== 'OK') {
    const detail = String(data.playabilityStatus?.reason || '').slice(0, 200)
    return {
      ok: false,
      reason: status === 'LOGIN_REQUIRED' ? 'login_required' : 'unplayable',
      detail,
      title: '',
      media: []
    }
  }
  const title = String(data.videoDetails?.title || '').trim()
  const streaming = data.streamingData || {}
  const formats = Array.isArray(streaming.formats) ? streaming.formats : []
  const adaptive = Array.isArray(streaming.adaptiveFormats) ? streaming.adaptiveFormats : []

  // 首选：合并轨（音视频同文件，单条直链，兼容性最好）
  const progressive = formats
    .filter((item) => typeof item?.url === 'string' && item.url && isYoutubeVideoStream(item))
    .sort((a, b) => youtubeSortKey(b) - youtubeSortKey(a))
  if (progressive.length > 0) {
    const best = progressive[0]
    return {
      ok: true,
      title,
      kind: 'video',
      quality: String(best.qualityLabel || ''),
      width: Number(best.width || 0) || null,
      height: Number(best.height || 0) || null,
      media: uniqueMedia([{ url: best.url, kind: 'video' }])
    }
  }

  // 次选：分离轨（视频 + 音频），Falcon 下载后 remux 合并
  const videoStreams = adaptive
    .filter((item) => typeof item?.url === 'string' && item.url && isYoutubeVideoStream(item))
    .sort((a, b) => youtubeSortKey(b) - youtubeSortKey(a))
  const audioStreams = adaptive
    .filter((item) => typeof item?.url === 'string' && item.url && isYoutubeAudioStream(item))
    .sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0))
  if (videoStreams.length > 0 && audioStreams.length > 0) {
    const video = videoStreams[0]
    const audio = audioStreams[0]
    const baseName = sanitizeFileName(title, 'youtube')
    const media = [
      { url: video.url, kind: 'video', role: 'video', fileName: `${baseName}-${video.height || ''}.mp4` },
      { url: audio.url, kind: 'video', role: 'audio' }
    ]
    return {
      ok: true,
      title,
      kind: 'video',
      quality: String(video.qualityLabel || ''),
      width: Number(video.width || 0) || null,
      height: Number(video.height || 0) || null,
      media: uniqueMedia(media)
    }
  }

  const hasCipher = [...formats, ...adaptive].some((item) => item?.signatureCipher || (item?.s && item?.sp))
  return {
    ok: false,
    reason: hasCipher ? 'needs_decipher' : 'no_stream',
    title,
    media: []
  }
}

/* ---------------- TikTok ---------------- */

export function parseTikTokItemStruct(itemStruct) {
  if (!itemStruct || typeof itemStruct !== 'object') {
    return { ok: false, reason: 'no_item', title: '', media: [] }
  }
  const title = String(itemStruct.desc || '').trim()
  const video = itemStruct.video || {}
  const imagePost = itemStruct.imagePost || null

  if (imagePost && Array.isArray(imagePost.images) && imagePost.images.length > 0) {
    const media = []
    for (const image of imagePost.images) {
      const url = image?.imageURL?.urlList?.[0] || ''
      if (url) media.push({ url, kind: 'image' })
    }
    return { ok: media.length > 0, title, kind: 'images', media: uniqueMedia(media) }
  }

  // bitrateInfo 按清晰度组织，取码率最高的一路；playAddr / downloadAddr 兜底
  const bitrateBest = Array.isArray(video.bitrateInfo)
    ? video.bitrateInfo
        .filter((entry) => entry?.PlayAddr?.UrlList?.[0])
        .sort((a, b) => Number(b.Bitrate || 0) - Number(a.Bitrate || 0))[0]?.PlayAddr?.UrlList?.[0]
    : ''
  const url =
    bitrateBest ||
    video.playAddr ||
    video.play_addr?.url_list?.[0] ||
    video.downloadAddr ||
    video.download_addr?.url_list?.[0] ||
    ''
  if (!url) return { ok: false, reason: 'video_url_missing', title, media: [] }
  return { ok: true, title, kind: 'video', media: uniqueMedia([{ url, kind: 'video' }]) }
}

/** 新版水合数据：script#__UNIVERSAL_DATA_FOR_REHYDRATION__ 的 JSON。 */
export function parseTikTokRehydration(payload) {
  const scope = payload?.__DEFAULT_SCOPE__ || {}
  const detail = scope['webapp.video-detail'] || {}
  const itemStruct = detail?.itemInfo?.itemStruct
  const status = String(detail?.statusCode || detail?.status_code || 0)
  if (!itemStruct && status && status !== '0') {
    return { ok: false, reason: status === '10216' ? 'private' : 'no_item', title: '', media: [] }
  }
  return parseTikTokItemStruct(itemStruct)
}

/** 旧版数据：script#SIGI_STATE 的 JSON（ItemModule 取最后一项）。 */
export function parseTikTokLegacy(state) {
  const module = state?.ItemModule
  if (!module || typeof module !== 'object') return { ok: false, reason: 'no_item', title: '', media: [] }
  const keys = Object.keys(module)
  const itemStruct = module[keys[keys.length - 1]]
  return parseTikTokItemStruct(itemStruct)
}

export function tiktokCoverUrl(itemStruct) {
  const video = itemStruct?.video || {}
  return String(video.cover || video.originCover || video.dynamicCover || '')
}

/* ---------------- X (Twitter) ----------------
 * 数据源：cdn.syndication.twimg.com/tweet-result（嵌入组件公共端点，公开推文免登录）。
 */

export function parseTwitterTweetResult(payload) {
  const tweet = payload ?? {}
  if (tweet.error || tweet.errors) {
    const detail = Array.isArray(tweet.errors) ? String(tweet.errors[0]?.message || '') : String(tweet.error || '')
    return { ok: false, reason: 'fetch_failed', detail: detail.slice(0, 200), title: '', media: [] }
  }
  const text = String(tweet.text || '').trim()
  const title = text.length > 80 ? `${text.slice(0, 80)}…` : text
  const media = []

  // 单视频推文：videoDetails.variants
  const variants = Array.isArray(tweet.videoDetails?.variants) ? tweet.videoDetails.variants : []
  const mp4 = variants
    .filter((v) => /video\/mp4/i.test(String(v.content_type || '')) && v.url)
    .sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0))[0]
  if (mp4) {
    return { ok: true, title, kind: 'video', media: uniqueMedia([{ url: mp4.url, kind: 'video' }]) }
  }

  // mediaDetails：照片与多视频
  const details = Array.isArray(tweet.mediaDetails) ? tweet.mediaDetails : []
  for (const entity of details) {
    if (entity?.type === 'video' || entity?.type === 'animated_gif') {
      const candidates = (entity.video_info?.variants || [])
        .filter((v) => /video\/mp4/i.test(String(v.content_type || '')) && v.url)
        .sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0))
      if (candidates[0]?.url) media.push({ url: candidates[0].url, kind: 'video' })
    } else if (entity?.type === 'photo' && entity.media_url_https) {
      media.push({ url: `${entity.media_url_https}?name=orig`, kind: 'image' })
    }
  }
  if (media.length > 0) {
    return { ok: true, title, kind: media.every((m) => m.kind === 'image') ? 'images' : 'video', media: uniqueMedia(media) }
  }
  return { ok: false, reason: 'no_media', title, media: [] }
}

/* ---------------- Instagram ---------------- */

export function parseInstagramMediaItem(item) {
  if (!item || typeof item !== 'object') return { ok: false, reason: 'no_item', title: '', media: [] }
  const title = String(item.caption?.text || '').trim().slice(0, 80)
  const mediaVersions = Array.isArray(item.video_versions) ? item.video_versions : []
  const productType = String(item.product_type || '')
  const media = []

  if (mediaVersions.length > 0) {
    media.push({ url: mediaVersions[0].url, kind: 'video' })
  } else if (Array.isArray(item.carousel_media)) {
    for (const child of item.carousel_media) {
      const childVideo = Array.isArray(child.video_versions) ? child.video_versions[0]?.url : ''
      if (childVideo) media.push({ url: childVideo, kind: 'video' })
      else {
        const image = child.image_versions2?.candidates?.[0]?.url
        if (image) media.push({ url: image, kind: 'image' })
      }
    }
  } else {
    const image = item.image_versions2?.candidates?.[0]?.url
    if (image && productType !== 'video') media.push({ url: image, kind: 'image' })
  }
  if (media.length === 0) return { ok: false, reason: productType === 'video' ? 'video_url_missing' : 'no_media', title, media: [] }
  return {
    ok: true,
    title,
    kind: media.every((m) => m.kind === 'image') ? 'images' : 'video',
    media: uniqueMedia(media)
  }
}

/** xdt_api__v1__media__shortcode__web_info 页面内嵌 JSON。 */
export function parseInstagramWebInfo(payload, shortcode) {
  const info = payload?.data?.['xdt_api__v1__media__shortcode__web_info']
  const items = Array.isArray(info?.items) ? info.items : []
  const item = (shortcode && items.find((x) => x?.code === shortcode)) || items[0]
  return parseInstagramMediaItem(item)
}

/** og:video / og:image 元标签兜底（公开帖、未登录也能拿到的最小信息）。 */
export function parseInstagramOgMeta(meta) {
  const video = String(meta?.ogVideo || '')
  const image = String(meta?.ogImage || '')
  const title = String(meta?.ogTitle || '').trim().slice(0, 80)
  if (video) return { ok: true, title, kind: 'video', media: uniqueMedia([{ url: video, kind: 'video' }]) }
  if (image) return { ok: true, title, kind: 'image', media: uniqueMedia([{ url: image, kind: 'image' }]) }
  return { ok: false, reason: 'no_media', title, media: [] }
}

/* ---------------- Vimeo ---------------- */

export function parseVimeoConfig(payload) {
  const config = payload ?? {}
  const files = config.request?.files || {}
  const title = String(config.video?.title || '').trim()
  const progressive = Array.isArray(files.progressive) ? files.progressive : []
  const best = progressive
    .filter((entry) => entry?.url)
    .sort((a, b) => (Number(b.height || 0) || 0) - (Number(a.height || 0) || 0))[0]
  if (best) {
    return {
      ok: true,
      title,
      kind: 'video',
      quality: String(best.quality || ''),
      media: uniqueMedia([{ url: best.url, kind: 'video' }])
    }
  }
  // 只有 DASH/HLS 流：不引入额外解码链路，明确告知边界
  if (files.dash?.cdns || files.hls?.cdns || files.streams) {
    return { ok: false, reason: 'dash_only', title, media: [] }
  }
  return { ok: false, reason: 'no_media', title, media: [] }
}
