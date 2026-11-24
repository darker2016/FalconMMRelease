export type MediaKind = 'image' | 'video'
export interface NativeMedia {
  url: string
  kind: MediaKind
}
export interface ParsedMedia {
  ok: boolean
  reason?: string
  title: string
  kind?: 'video' | 'images'
  media: NativeMedia[]
}
export interface BilibiliPart {
  order: number
  url: string
  backupUrls: string[]
  size: number | null
  lengthMs: number
}
export interface BilibiliInitialInfo {
  bvid: string
  cid: number | null
  title: string
  durationSec: number
  upowerExclusive: boolean
  upowerPlay: boolean
  paid: boolean
}
export interface BilibiliPgcEpisode {
  ok: boolean
  reason?: string
  epId: number | null
  cid: number | null
  aid: number | null
  title: string
  episodeTitle: string
  durationSec: number
  vip: boolean
}
export interface BilibiliDashTrack {
  url: string
  id: number | null
  quality?: string
  width?: number
  height?: number
  codecid?: number | null
  codecs?: string
  bandwidth?: number
}
export interface BilibiliDashSelection {
  ok: boolean
  video: BilibiliDashTrack | null
  audio: BilibiliDashTrack | null
  durationMs: number
}

export function sleep(ms: number): Promise<void>
export function normalizeUrl(value: string): string
export function sanitizeFileName(value: string, fallback?: string): string
export function extFromUrl(url: string, kind: MediaKind): string
export function mediaFileName(title: string, index: number, total: number, url: string, kind: MediaKind): string
export function parseBilibiliInitialState(state: unknown): BilibiliInitialInfo
export function parseBilibiliPgcSeason(season: unknown, epId?: number | string): BilibiliPgcEpisode
export function bilibiliQualityLabel(id: number | string): string
export function parseBilibiliPlayurl(payload: unknown): {
  ok: boolean
  parts: BilibiliPart[]
  quality: number | null
  format: string
  timelengthMs: number
  hasDash: boolean
}
export function selectBilibiliDash(payload: unknown): BilibiliDashSelection
export function bilibiliCoveredMs(payload: unknown): number
export function bilibiliPreviewGapMs(payload: unknown, fullDurationMs?: number): number
export function parseDouyinRouterData(root: unknown): ParsedMedia
export function parseXiaohongshuState(state: unknown, noteId?: string): ParsedMedia
/** 抖音候选地址按可靠性排序：playAddr CDN 直链 > bitRate 最高档 > playApi 包装地址。 */
export function douyinVideoUrlCandidates(video: unknown): string[]
/** 抖音封面（cover/originCover/rawCover/dynamicCover），供弹窗预览流媒体卡片。 */
export function douyinCoverUrl(video: unknown): string

/* ── 国际站点（2026-11 新增）── */

export interface YoutubeParsed extends ParsedMedia {
  quality?: string
  width?: number | null
  height?: number | null
  detail?: string
}
/** YouTube player response（watch 页内嵌或 innertube /player 响应）；只取明文 url 流。 */
export function parseYoutubePlayerResponse(payload: unknown): YoutubeParsed

export function parseTikTokItemStruct(itemStruct: unknown): ParsedMedia
export function parseTikTokRehydration(payload: unknown): ParsedMedia
export function parseTikTokLegacy(state: unknown): ParsedMedia
/** TikTok 封面（cover/originCover/dynamicCover）。 */
export function tiktokCoverUrl(itemStruct: unknown): string

export function parseTwitterTweetResult(payload: unknown): ParsedMedia

export function parseInstagramMediaItem(item: unknown): ParsedMedia
export function parseInstagramWebInfo(payload: unknown, shortcode?: string): ParsedMedia
export function parseInstagramOgMeta(meta: { ogVideo?: string; ogImage?: string; ogTitle?: string }): ParsedMedia

export interface VimeoParsed extends ParsedMedia {
  quality?: string
}
/** Vimeo player config（页面 playerConfig 或 player.vimeo.com config 端点）。 */
export function parseVimeoConfig(payload: unknown): VimeoParsed
