// 支持的视频站点与下载判定（MV3 service worker 与 popup 共用）。
// 只做纯函数：不访问 chrome.*，方便单元测试。

export const SITES = {
  bilibili: {
    key: 'bilibili',
    label: '哔哩哔哩',
    script: 'Bilibili-Evolved',
    installUrl: 'https://github.com/the1812/Bilibili-Evolved#安装',
    tampermonkeyUrl: 'https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo',
    origin: 'https://www.bilibili.com',
    hosts: [
      'bilibili.com',
      'b23.tv',
      'bilivideo.com',
      'bilivideo.cn',
      'hdslb.com',
      'biliapi.net',
      'biliapi.com',
      'szbdyd.com'
    ]
  },
  douyin: {
    key: 'douyin',
    label: '抖音',
    script: 'douyin-dl-user-js',
    installUrl: 'https://greasyfork.org/zh-CN/scripts/522326',
    tampermonkeyUrl: 'https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo',
    origin: 'https://www.douyin.com',
    hosts: [
      'douyin.com',
      'iesdouyin.com',
      'douyinvod.com',
      'douyinpic.com',
      'douyinstatic.com',
      'douyincdn.com',
      'bytedance.com',
      'byteimg.com',
      'bytecdn.cn',
      'bytecdntp.com',
      'pstatp.com',
      'zjcdn.com'
    ]
  },
  xiaohongshu: {
    key: 'xiaohongshu',
    label: '小红书',
    script: 'XHS-Downloader',
    installUrl: 'https://cdn.jsdelivr.net/gh/JoeanAmier/XHS-Downloader@master/static/XHS-Downloader.js',
    tampermonkeyUrl: 'https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo',
    origin: 'https://www.xiaohongshu.com',
    hosts: ['xiaohongshu.com', 'xhscdn.com', 'xhslink.com', 'rednote.com']
  },
  // ── 国际站点（2026-11 新增）。这些站没有稳定的 Tampermonkey 方案，script 留空：
  // popup 不再渲染脚本安装行；替代路径是发布库里的插件源码与开发者文档。
  youtube: {
    key: 'youtube',
    label: 'YouTube',
    script: '',
    installUrl: '',
    tampermonkeyUrl: '',
    origin: 'https://www.youtube.com',
    hosts: ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'googlevideo.com', 'ytimg.com']
  },
  tiktok: {
    key: 'tiktok',
    label: 'TikTok',
    script: '',
    installUrl: '',
    tampermonkeyUrl: '',
    origin: 'https://www.tiktok.com',
    hosts: [
      'tiktok.com',
      'tiktokv.com',
      'tiktokcdn.com',
      'tiktokcdn-us.com',
      'tiktokcdn-eu.com',
      'muscdn.com',
      'musical.ly',
      'byteoversea.com',
      'ibyteimg.com',
      'ttwstatic.com'
    ]
  },
  twitter: {
    key: 'twitter',
    label: 'X (Twitter)',
    script: '',
    installUrl: '',
    tampermonkeyUrl: '',
    origin: 'https://x.com',
    hosts: ['x.com', 'twitter.com', 'twimg.com', 't.co']
  },
  instagram: {
    key: 'instagram',
    label: 'Instagram',
    script: '',
    installUrl: '',
    tampermonkeyUrl: '',
    origin: 'https://www.instagram.com',
    hosts: ['instagram.com', 'instagr.am', 'cdninstagram.com', 'fbcdn.net']
  },
  vimeo: {
    key: 'vimeo',
    label: 'Vimeo',
    script: '',
    installUrl: '',
    tampermonkeyUrl: '',
    origin: 'https://vimeo.com',
    hosts: ['vimeo.com', 'vimeocdn.com', 'vod-progressive.akamaized.net', 'vod-adaptive.akamaized.net']
  }
}

export const SITE_KEYS = Object.keys(SITES)
export const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024 * 1024

/**
 * 受 DRM 保护的商业流媒体（Widevine / ChinaDRM 加密流）。
 * 插件只做站点识别与明确提示，不解析密钥、不解密、不绕过，也不并入 SITES：
 * 它们不参与「下载完成自动入库」白名单，避免把版权文件的下载记录收进素材库。
 */
export const DRM_SITES = {
  iqiyi: { key: 'iqiyi', label: '爱奇艺', hosts: ['iqiyi.com', 'iq.com'] },
  youku: { key: 'youku', label: '优酷', hosts: ['youku.com'] },
  tencent: { key: 'tencent', label: '腾讯视频', hosts: ['v.qq.com', 'wetv.vip'] },
  mango: { key: 'mango', label: '芒果TV', hosts: ['mgtv.com'] }
}

export const DRM_SITE_KEYS = Object.keys(DRM_SITES)

export function drmSiteOfUrl(value) {
  const host = hostOfUrl(value)
  if (!host) return null
  for (const key of DRM_SITE_KEYS) {
    const site = DRM_SITES[key]
    if (site.hosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return key
  }
  return null
}

export function drmSiteLabel(key) {
  return DRM_SITES[key]?.label || ''
}

export const MEDIA_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'avif',
  'gif',
  'bmp',
  'tif',
  'tiff',
  'heic',
  'mp4',
  'm4v',
  'webm',
  'mov',
  'mkv',
  'ogv'
])

const NON_MEDIA_EXTENSIONS = new Set(['zip', 'rar', '7z', 'm3u8', 'mpd', 'm4s', 'ts', 'html', 'htm', 'txt', 'json'])

export function hostOfUrl(value) {
  if (!value) return ''
  let raw = String(value).trim()
  if (!raw) return ''
  if (raw.startsWith('blob:')) raw = raw.slice(5)
  try {
    return new URL(raw).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function siteOfUrl(value) {
  const host = hostOfUrl(value)
  if (!host) return null
  for (const key of SITE_KEYS) {
    const site = SITES[key]
    if (site.hosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return key
  }
  return null
}

/** 优先参考来源页（referrer），其次最终地址，最后原始地址。 */
export function siteOfDownload(item) {
  if (!item) return null
  for (const candidate of [item.referrer, item.finalUrl, item.url]) {
    const site = siteOfUrl(candidate)
    if (site) return site
  }
  return null
}

export function siteLabel(site) {
  return SITES[site]?.label || ''
}

export function isMediaDownload(item) {
  if (!item) return false
  const name = String(item.fileName || item.filename || '')
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (MEDIA_EXTENSIONS.has(ext)) return true
  if (NON_MEDIA_EXTENSIONS.has(ext)) return false
  const mime = String(item.mime || '').toLowerCase()
  return mime.startsWith('image/') || mime.startsWith('video/')
}

/**
 * 判定一个已完成的浏览器下载是否应自动入库。
 * reason 枚举供 popup 展示，不要改语义。
 */
export function shouldImportDownload(item, options = {}) {
  const autoImport = options.autoImport !== false
  const maxBytes = Number(options.maxBytes || MAX_DOWNLOAD_BYTES)
  if (!autoImport) return { ok: false, reason: 'auto_import_off' }
  if (!item) return { ok: false, reason: 'not_found' }
  const state = typeof item.state === 'string' ? item.state : item.state?.current
  if (state !== 'complete') return { ok: false, reason: 'not_complete' }
  if (!item.filename) return { ok: false, reason: 'no_file' }
  if (item.exists === false) return { ok: false, reason: 'file_missing' }
  if (item.danger === 'dangerous' || item.danger === 'unwanted') return { ok: false, reason: 'dangerous' }
  if (!isMediaDownload(item)) return { ok: false, reason: 'not_media' }
  const size = Number(item.fileSize)
  if (Number.isFinite(size) && size > maxBytes) return { ok: false, reason: 'too_large' }
  const site = siteOfDownload(item)
  if (!site) return { ok: false, reason: 'site_unrecognized' }
  return { ok: true, site }
}
