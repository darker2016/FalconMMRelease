"use strict";
(() => {
  // extension/lib/native-adapters.mjs
  function normalizeUrl(value) {
    if (!value) return "";
    const raw = String(value).trim();
    if (!raw) return "";
    if (raw.startsWith("//")) return `https:${raw}`;
    return raw;
  }
  function sanitizeFileName(value, fallback = "download") {
    const clean = String(value || "").replace(/[\u0000-\u001f<>:"/\\|?*]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
    return clean || fallback;
  }
  function extFromUrl(url, kind) {
    try {
      const path = new URL(normalizeUrl(url)).pathname;
      const match = /\.([a-z0-9]{2,5})$/i.exec(path);
      if (match) return match[1].toLowerCase();
    } catch {
    }
    return kind === "image" ? "jpg" : "mp4";
  }
  function mediaFileName(title, index, total, url, kind) {
    const suffix = total > 1 ? `-${index + 1}` : "";
    return `${sanitizeFileName(title, kind === "image" ? "image" : "video")}${suffix}.${extFromUrl(url, kind)}`;
  }
  function uniqueMedia(items) {
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const item of items) {
      if (!item?.url) continue;
      const url = normalizeUrl(item.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({ ...item, url });
    }
    return out;
  }
  var BILIBILI_QUALITY_LABELS = {
    127: "8K",
    126: "\u675C\u6BD4\u89C6\u754C",
    125: "HDR",
    120: "4K",
    116: "1080P60",
    112: "1080P+",
    80: "1080P",
    74: "720P60",
    64: "720P",
    32: "480P",
    16: "360P"
  };
  var BILIBILI_CODEC_PREF = { 7: 0, 12: 1, 13: 2 };
  function bilibiliQualityLabel(id) {
    return BILIBILI_QUALITY_LABELS[Number(id)] || String(id || "") || "\u672A\u77E5\u6E05\u6670\u5EA6";
  }
  function bilibiliPayloadData(payload) {
    return payload?.data ?? payload?.result ?? payload ?? {};
  }
  function parseBilibiliInitialState(state) {
    const data = state && typeof state === "object" ? state : {};
    const videoData = data.videoData && typeof data.videoData === "object" ? data.videoData : {};
    const rights = videoData.rights && typeof videoData.rights === "object" ? videoData.rights : {};
    return {
      bvid: String(videoData.bvid || data.bvid || ""),
      cid: Number(videoData.cid || data.cid || 0) || null,
      title: String(videoData.title || data.title || "").trim(),
      durationSec: Number(videoData.duration || data.duration || 0) || 0,
      // UP 主充电专属视频：upower_play=false 表示当前账号没有充电（只能拿试看）
      upowerExclusive: Boolean(videoData.is_upower_exclusive || data.is_upower_exclusive),
      upowerPlay: Boolean(videoData.is_upower_play || data.is_upower_play),
      // 付费稿件（pay / ugc_pay / arc_pay 任一非 0）
      paid: Boolean(Number(rights.pay) || Number(rights.ugc_pay) || Number(rights.arc_pay))
    };
  }
  function parseBilibiliPgcSeason(season, epId) {
    const result = season?.result ?? season?.data ?? season ?? {};
    const episodes = Array.isArray(result.episodes) ? result.episodes : [];
    if (episodes.length === 0) {
      return { ok: false, reason: "no_episodes", title: "", episodeTitle: "", epId: null, cid: null, durationSec: 0, vip: false };
    }
    const target = episodes.find((e) => String(e?.id) === String(epId)) || episodes[0];
    const badge = String(target?.badge || "");
    return {
      ok: true,
      epId: Number(target?.id) || null,
      cid: Number(target?.cid) || null,
      aid: Number(target?.aid) || null,
      title: String(result.title || target?.title || "").trim(),
      episodeTitle: String(target?.title || "").trim(),
      // PGC 的 duration 是毫秒
      durationSec: Math.round((Number(target?.duration) || 0) / 1e3) || 0,
      vip: /会员|专享|付费/.test(badge)
    };
  }
  function parseBilibiliPlayurl(payload) {
    const data = bilibiliPayloadData(payload);
    const durl = Array.isArray(data.durl) ? data.durl : [];
    const parts = durl.map((part, index) => ({
      order: Number(part?.order ?? index + 1),
      url: normalizeUrl(part?.url),
      backupUrls: [...part?.backup_url || part?.backupUrl || []].map(normalizeUrl).filter(Boolean),
      size: Number(part?.size || 0) || null,
      lengthMs: Number(part?.length || 0) || 0
    })).filter((part) => part.url);
    return {
      ok: parts.length > 0,
      parts,
      quality: Number(data.quality || 0) || null,
      format: String(data.format || ""),
      timelengthMs: Number(data.timelength) || 0,
      hasDash: Boolean(data.dash && (data.dash.video?.length || data.dash.audio?.length))
    };
  }
  function selectBilibiliDash(payload) {
    const data = bilibiliPayloadData(payload);
    const dash = data.dash && typeof data.dash === "object" ? data.dash : {};
    const urlOf = (track) => normalizeUrl(track?.baseUrl || track?.base_url || track?.baseURL || "");
    const videos = (Array.isArray(dash.video) ? dash.video : []).filter(
      (t) => t && urlOf(t) && Number(t.height || 0) > 0
    );
    const audios = (Array.isArray(dash.audio) ? dash.audio : []).filter((t) => t && urlOf(t));
    const durationMs = Number(data.timelength) || (Number(dash.duration) > 0 ? Math.round(Number(dash.duration) * 1e3) : 0) || 0;
    if (videos.length === 0) return { ok: false, video: null, audio: null, durationMs };
    const sdr = videos.filter((t) => ![125, 126].includes(Number(t.id)));
    const pool = sdr.length > 0 ? sdr : videos;
    const best = [...pool].sort((a, b) => {
      const byHeight = Number(b.height || 0) - Number(a.height || 0);
      if (byHeight !== 0) return byHeight;
      const byCodec = (BILIBILI_CODEC_PREF[Number(a.codecid)] ?? 9) - (BILIBILI_CODEC_PREF[Number(b.codecid)] ?? 9);
      if (byCodec !== 0) return byCodec;
      return Number(b.bandwidth || 0) - Number(a.bandwidth || 0);
    })[0];
    const audio = [...audios].sort((a, b) => Number(b.bandwidth || 0) - Number(a.bandwidth || 0))[0] || null;
    return {
      ok: true,
      video: {
        url: urlOf(best),
        id: Number(best.id) || null,
        quality: bilibiliQualityLabel(best.id),
        width: Number(best.width) || 0,
        height: Number(best.height) || 0,
        codecid: Number(best.codecid) || null,
        codecs: String(best.codecs || ""),
        bandwidth: Number(best.bandwidth) || 0
      },
      audio: audio ? {
        url: urlOf(audio),
        id: Number(audio.id) || null,
        codecs: String(audio.codecs || ""),
        bandwidth: Number(audio.bandwidth) || 0
      } : null,
      durationMs
    };
  }
  function bilibiliCoveredMs(payload) {
    const data = bilibiliPayloadData(payload);
    const durl = Array.isArray(data.durl) ? data.durl : [];
    const fromDurl = durl.reduce((sum, part) => sum + (Number(part?.length) || 0), 0);
    if (fromDurl > 0) return fromDurl;
    const dash = data.dash && typeof data.dash === "object" ? data.dash : {};
    const dashSeconds = Number(dash.duration) || 0;
    return dashSeconds > 0 ? Math.round(dashSeconds * 1e3) : 0;
  }
  function bilibiliPreviewGapMs(payload, fullDurationMs) {
    const data = bilibiliPayloadData(payload);
    const covered = bilibiliCoveredMs(payload);
    const expected = Number(fullDurationMs) || Number(data.timelength) || 0;
    if (!covered || !expected) return 0;
    return covered + 3e3 < expected ? expected - covered : 0;
  }
  function hasVideoShape(video) {
    if (!video || typeof video !== "object") return false;
    return Boolean(
      video.play_addr || video.playAddr || video.playApi || video.play_api || video.playApiH265 || video.bit_rate || video.bitRate || video.bitRateList || video.bit_rate_list
    );
  }
  function findAweme(node, depth = 0, seen = /* @__PURE__ */ new Set()) {
    if (!node || typeof node !== "object" || depth > 10 || seen.has(node)) return null;
    seen.add(node);
    if (hasVideoShape(node.video)) return node;
    if (Array.isArray(node.images) && node.images.length > 0 && (node.desc !== void 0 || node.aweme_id || node.awemeId)) {
      return node;
    }
    for (const value of Object.values(node)) {
      const found = findAweme(value, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }
  function firstUrl(value) {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      for (const item of value) {
        const url = firstUrl(item);
        if (url) return url;
      }
      return "";
    }
    return value.src || value.url || value.url_list?.[0] || value.urlList?.[0] || "";
  }
  function bestBitRateUrl(video) {
    const list = video.bitRateList || video.bit_rate_list || video.bit_rate || video.bitRate;
    if (!Array.isArray(list)) return "";
    const candidates = list.filter((item) => item && item.format !== "dash").map((item) => ({
      url: douyinPlayAddrUrl(item.playAddr || item.play_addr) || firstUrl(item.playApi || item.play_api),
      area: Number(item.width || 0) * Number(item.height || 0),
      size: Number(item.dataSize || item.data_size || 0)
    })).filter((item) => item.url);
    candidates.sort((a, b) => b.area - a.area || b.size - a.size);
    return candidates[0]?.url || "";
  }
  function douyinPlayAddrUrl(value) {
    if (!value) return "";
    if (typeof value === "string") return normalizeUrl(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const url = typeof item === "string" ? item : item?.src || item?.url || firstUrl(item?.url_list || item?.urlList);
        if (url) return normalizeUrl(url);
      }
      return "";
    }
    return firstUrl(value);
  }
  function douyinVideoUrlCandidates(video) {
    if (!video || typeof video !== "object") return [];
    const out = [];
    const push = (url) => {
      const clean = normalizeUrl(url);
      if (clean && !out.includes(clean)) out.push(clean);
    };
    push(douyinPlayAddrUrl(video.playAddr || video.play_addr));
    push(bestBitRateUrl(video));
    push(firstUrl(video.playApi || video.play_api));
    push(firstUrl(video.playApiH265 || video.play_api_h265));
    push(douyinPlayAddrUrl(video.download_addr || video.downloadAddr));
    return out;
  }
  function douyinVideoUrl(video) {
    return douyinVideoUrlCandidates(video)[0] || "";
  }
  function douyinCoverUrl(video) {
    if (!video || typeof video !== "object") return "";
    return douyinPlayAddrUrl(video.cover) || firstUrl(video.originCover || video.origin_cover) || douyinPlayAddrUrl(video.rawCover || video.raw_cover) || firstUrl(video.dynamicCover || video.dynamic_cover) || "";
  }
  function douyinImageUrl(image) {
    if (!image || typeof image !== "object") return "";
    return firstUrl(image.urlList) || firstUrl(image.url_list) || firstUrl(image.downloadUrlList) || firstUrl(image.download_url_list);
  }
  function parseDouyinRouterData(root) {
    const aweme = findAweme(root);
    if (!aweme) return { ok: false, reason: "no_aweme", title: "", media: [] };
    const title = String(aweme.desc || aweme.aweme_id || aweme.awemeId || "").trim();
    const images = Array.isArray(aweme.images) ? aweme.images : [];
    if (images.length > 0) {
      const media2 = [];
      for (const image of images) {
        if (image?.video) {
          const videoUrl = douyinVideoUrl(image.video);
          if (videoUrl) media2.push({ url: videoUrl, kind: "video" });
          continue;
        }
        const url2 = douyinImageUrl(image);
        if (url2) media2.push({ url: url2, kind: "image" });
      }
      return { ok: media2.length > 0, title, kind: "images", media: uniqueMedia(media2) };
    }
    const url = douyinVideoUrl(aweme.video);
    const media = url ? [{ url, kind: "video" }] : [];
    return { ok: media.length > 0, title, kind: "video", media: uniqueMedia(media) };
  }
  function parseXiaohongshuState(state, noteId) {
    const map = state?.note?.noteDetailMap;
    if (!map || typeof map !== "object") return { ok: false, reason: "no_note", title: "", media: [] };
    const ids = Object.keys(map);
    const key = noteId && map[noteId] ? noteId : ids[ids.length - 1];
    const entry = key ? map[key] : null;
    const note = entry?.note || entry;
    if (!note) return { ok: false, reason: "no_note", title: "", media: [] };
    const title = String(note.title || note.desc || "").trim();
    const type = String(note.type || "").toLowerCase();
    const stream = note.video?.media?.stream || {};
    const streams = Object.values(stream).flat().filter((item) => item && typeof item === "object").sort((a, b) => {
      const area = (x) => Number(x.height || 0) * Number(x.width || 0);
      return area(b) - area(a) || Number(b.videoBitrate || 0) - Number(a.videoBitrate || 0);
    });
    const videoTrack = streams[0];
    const originKey = note.video?.consumer?.originVideoKey;
    const videoUrl = (originKey ? `https://sns-video-bd.xhscdn.com/${originKey}` : "") || videoTrack?.backupUrls?.[0] || videoTrack?.masterUrl || videoTrack?.master_url || videoTrack?.backup_urls?.[0] || "";
    if (note.video || type === "video") {
      if (!videoUrl) return { ok: false, reason: "video_url_missing", title, media: [] };
      return { ok: true, title, kind: "video", media: uniqueMedia([{ url: videoUrl, kind: "video" }]) };
    }
    const images = Array.isArray(note.imageList) ? note.imageList : [];
    const media = [];
    for (const image of images) {
      const url = image?.urlDefault || image?.url_default || image?.urlPre || image?.url_pre || image?.infoList?.[0]?.url || image?.info_list?.[0]?.url;
      if (url) media.push({ url, kind: "image" });
    }
    return { ok: media.length > 0, title, kind: "images", media: uniqueMedia(media) };
  }
  function youtubeSortKey(item) {
    const height = Number(item?.height || 0);
    const bitrate = Number(item?.bitrate || 0);
    return height * 1e9 + bitrate;
  }
  function isYoutubeVideoStream(item) {
    const mime = String(item?.mimeType || "");
    return /video\//i.test(mime) && !/audio\//i.test(mime);
  }
  function isYoutubeAudioStream(item) {
    return /audio\//i.test(String(item?.mimeType || ""));
  }
  function parseYoutubePlayerResponse(payload) {
    const data = payload ?? {};
    const status = String(data.playabilityStatus?.status || "");
    if (status && status !== "OK") {
      const detail = String(data.playabilityStatus?.reason || "").slice(0, 200);
      return {
        ok: false,
        reason: status === "LOGIN_REQUIRED" ? "login_required" : "unplayable",
        detail,
        title: "",
        media: []
      };
    }
    const title = String(data.videoDetails?.title || "").trim();
    const streaming = data.streamingData || {};
    const formats = Array.isArray(streaming.formats) ? streaming.formats : [];
    const adaptive = Array.isArray(streaming.adaptiveFormats) ? streaming.adaptiveFormats : [];
    const progressive = formats.filter((item) => typeof item?.url === "string" && item.url && isYoutubeVideoStream(item)).sort((a, b) => youtubeSortKey(b) - youtubeSortKey(a));
    if (progressive.length > 0) {
      const best = progressive[0];
      return {
        ok: true,
        title,
        kind: "video",
        quality: String(best.qualityLabel || ""),
        width: Number(best.width || 0) || null,
        height: Number(best.height || 0) || null,
        media: uniqueMedia([{ url: best.url, kind: "video" }])
      };
    }
    const videoStreams = adaptive.filter((item) => typeof item?.url === "string" && item.url && isYoutubeVideoStream(item)).sort((a, b) => youtubeSortKey(b) - youtubeSortKey(a));
    const audioStreams = adaptive.filter((item) => typeof item?.url === "string" && item.url && isYoutubeAudioStream(item)).sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0));
    if (videoStreams.length > 0 && audioStreams.length > 0) {
      const video = videoStreams[0];
      const audio = audioStreams[0];
      const baseName = sanitizeFileName(title, "youtube");
      const media = [
        { url: video.url, kind: "video", role: "video", fileName: `${baseName}-${video.height || ""}.mp4` },
        { url: audio.url, kind: "video", role: "audio" }
      ];
      return {
        ok: true,
        title,
        kind: "video",
        quality: String(video.qualityLabel || ""),
        width: Number(video.width || 0) || null,
        height: Number(video.height || 0) || null,
        media: uniqueMedia(media)
      };
    }
    const hasCipher = [...formats, ...adaptive].some((item) => item?.signatureCipher || item?.s && item?.sp);
    return {
      ok: false,
      reason: hasCipher ? "needs_decipher" : "no_stream",
      title,
      media: []
    };
  }
  function parseTikTokItemStruct(itemStruct) {
    if (!itemStruct || typeof itemStruct !== "object") {
      return { ok: false, reason: "no_item", title: "", media: [] };
    }
    const title = String(itemStruct.desc || "").trim();
    const video = itemStruct.video || {};
    const imagePost = itemStruct.imagePost || null;
    if (imagePost && Array.isArray(imagePost.images) && imagePost.images.length > 0) {
      const media = [];
      for (const image of imagePost.images) {
        const url2 = image?.imageURL?.urlList?.[0] || "";
        if (url2) media.push({ url: url2, kind: "image" });
      }
      return { ok: media.length > 0, title, kind: "images", media: uniqueMedia(media) };
    }
    const bitrateBest = Array.isArray(video.bitrateInfo) ? video.bitrateInfo.filter((entry) => entry?.PlayAddr?.UrlList?.[0]).sort((a, b) => Number(b.Bitrate || 0) - Number(a.Bitrate || 0))[0]?.PlayAddr?.UrlList?.[0] : "";
    const url = bitrateBest || video.playAddr || video.play_addr?.url_list?.[0] || video.downloadAddr || video.download_addr?.url_list?.[0] || "";
    if (!url) return { ok: false, reason: "video_url_missing", title, media: [] };
    return { ok: true, title, kind: "video", media: uniqueMedia([{ url, kind: "video" }]) };
  }
  function parseTikTokRehydration(payload) {
    const scope = payload?.__DEFAULT_SCOPE__ || {};
    const detail = scope["webapp.video-detail"] || {};
    const itemStruct = detail?.itemInfo?.itemStruct;
    const status = String(detail?.statusCode || detail?.status_code || 0);
    if (!itemStruct && status && status !== "0") {
      return { ok: false, reason: status === "10216" ? "private" : "no_item", title: "", media: [] };
    }
    return parseTikTokItemStruct(itemStruct);
  }
  function parseTikTokLegacy(state) {
    const module = state?.ItemModule;
    if (!module || typeof module !== "object") return { ok: false, reason: "no_item", title: "", media: [] };
    const keys = Object.keys(module);
    const itemStruct = module[keys[keys.length - 1]];
    return parseTikTokItemStruct(itemStruct);
  }
  function tiktokCoverUrl(itemStruct) {
    const video = itemStruct?.video || {};
    return String(video.cover || video.originCover || video.dynamicCover || "");
  }
  function parseTwitterTweetResult(payload) {
    const tweet = payload ?? {};
    if (tweet.error || tweet.errors) {
      const detail = Array.isArray(tweet.errors) ? String(tweet.errors[0]?.message || "") : String(tweet.error || "");
      return { ok: false, reason: "fetch_failed", detail: detail.slice(0, 200), title: "", media: [] };
    }
    const text = String(tweet.text || "").trim();
    const title = text.length > 80 ? `${text.slice(0, 80)}\u2026` : text;
    const media = [];
    const variants = Array.isArray(tweet.videoDetails?.variants) ? tweet.videoDetails.variants : [];
    const mp4 = variants.filter((v) => /video\/mp4/i.test(String(v.content_type || "")) && v.url).sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0))[0];
    if (mp4) {
      return { ok: true, title, kind: "video", media: uniqueMedia([{ url: mp4.url, kind: "video" }]) };
    }
    const details = Array.isArray(tweet.mediaDetails) ? tweet.mediaDetails : [];
    for (const entity of details) {
      if (entity?.type === "video" || entity?.type === "animated_gif") {
        const candidates = (entity.video_info?.variants || []).filter((v) => /video\/mp4/i.test(String(v.content_type || "")) && v.url).sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0));
        if (candidates[0]?.url) media.push({ url: candidates[0].url, kind: "video" });
      } else if (entity?.type === "photo" && entity.media_url_https) {
        media.push({ url: `${entity.media_url_https}?name=orig`, kind: "image" });
      }
    }
    if (media.length > 0) {
      return { ok: true, title, kind: media.every((m) => m.kind === "image") ? "images" : "video", media: uniqueMedia(media) };
    }
    return { ok: false, reason: "no_media", title, media: [] };
  }
  function parseInstagramMediaItem(item) {
    if (!item || typeof item !== "object") return { ok: false, reason: "no_item", title: "", media: [] };
    const title = String(item.caption?.text || "").trim().slice(0, 80);
    const mediaVersions = Array.isArray(item.video_versions) ? item.video_versions : [];
    const productType = String(item.product_type || "");
    const media = [];
    if (mediaVersions.length > 0) {
      media.push({ url: mediaVersions[0].url, kind: "video" });
    } else if (Array.isArray(item.carousel_media)) {
      for (const child of item.carousel_media) {
        const childVideo = Array.isArray(child.video_versions) ? child.video_versions[0]?.url : "";
        if (childVideo) media.push({ url: childVideo, kind: "video" });
        else {
          const image = child.image_versions2?.candidates?.[0]?.url;
          if (image) media.push({ url: image, kind: "image" });
        }
      }
    } else {
      const image = item.image_versions2?.candidates?.[0]?.url;
      if (image && productType !== "video") media.push({ url: image, kind: "image" });
    }
    if (media.length === 0) return { ok: false, reason: productType === "video" ? "video_url_missing" : "no_media", title, media: [] };
    return {
      ok: true,
      title,
      kind: media.every((m) => m.kind === "image") ? "images" : "video",
      media: uniqueMedia(media)
    };
  }
  function parseInstagramWebInfo(payload, shortcode) {
    const info = payload?.data?.["xdt_api__v1__media__shortcode__web_info"];
    const items = Array.isArray(info?.items) ? info.items : [];
    const item = shortcode && items.find((x) => x?.code === shortcode) || items[0];
    return parseInstagramMediaItem(item);
  }
  function parseInstagramOgMeta(meta) {
    const video = String(meta?.ogVideo || "");
    const image = String(meta?.ogImage || "");
    const title = String(meta?.ogTitle || "").trim().slice(0, 80);
    if (video) return { ok: true, title, kind: "video", media: uniqueMedia([{ url: video, kind: "video" }]) };
    if (image) return { ok: true, title, kind: "image", media: uniqueMedia([{ url: image, kind: "image" }]) };
    return { ok: false, reason: "no_media", title, media: [] };
  }
  function parseVimeoConfig(payload) {
    const config = payload ?? {};
    const files = config.request?.files || {};
    const title = String(config.video?.title || "").trim();
    const progressive = Array.isArray(files.progressive) ? files.progressive : [];
    const best = progressive.filter((entry) => entry?.url).sort((a, b) => (Number(b.height || 0) || 0) - (Number(a.height || 0) || 0))[0];
    if (best) {
      return {
        ok: true,
        title,
        kind: "video",
        quality: String(best.quality || ""),
        media: uniqueMedia([{ url: best.url, kind: "video" }])
      };
    }
    if (files.dash?.cdns || files.hls?.cdns || files.streams) {
      return { ok: false, reason: "dash_only", title, media: [] };
    }
    return { ok: false, reason: "no_media", title, media: [] };
  }

  // extension/src/native-page.js
  function nativeError(key, vars, options = {}) {
    const error = new Error(key);
    error.key = key;
    error.vars = vars || {};
    if (options.retryable !== void 0) error.retryable = options.retryable;
    return error;
  }
  function bvidFromLocation() {
    return location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1] || "";
  }
  function bilibiliBangumiRoute() {
    const match = location.pathname.match(/\/bangumi\/play\/(ep|ss)(\d+)/);
    if (!match) return null;
    return { type: match[1], id: Number(match[2]) };
  }
  function xhsNoteIdFromLocation() {
    return location.pathname.match(/\/(?:explore|discovery\/item)\/([0-9a-f]+)/)?.[1] || "";
  }
  async function bilibiliView(bvid) {
    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
      credentials: "include"
    });
    if (!res.ok) throw nativeError("native.bilibili.viewFetchFailed", { status: res.status });
    const body = await res.json();
    if (body.code !== 0) {
      if (body.message) throw new Error(body.message);
      throw nativeError("native.bilibili.viewFailed");
    }
    return body.data || {};
  }
  async function bilibiliPlayurl(url) {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw nativeError("native.bilibili.playurlFetchFailed", { status: res.status });
    const body = await res.json();
    if (body.code !== 0) {
      if (body.message) throw new Error(body.message);
      throw nativeError("native.bilibili.playurlFailed");
    }
    return body;
  }
  function bilibiliPlayurlQuery(fnval) {
    return `qn=127&fnval=${fnval}&fourk=1&platform=pc&fnver=0`;
  }
  function mediaWithNames(title, media) {
    return media.map((item, index) => ({
      url: item.url,
      kind: item.kind,
      fileName: mediaFileName(title, index, media.length, item.url, item.kind)
    }));
  }
  function clockOf(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  function bilibiliPreviewError(body, context) {
    const coveredSec = Math.round(bilibiliCoveredMs(body) / 1e3);
    const totalSec = Math.round((Number(context.fullDurationMs) || 0) / 1e3);
    const span = `${clockOf(coveredSec)} / ${clockOf(totalSec)}`;
    let error;
    if (context.upowerExclusive && !context.upowerPlay) {
      error = nativeError("native.bilibili.upowerExclusive", { span }, { retryable: false });
    } else if (context.vip) {
      error = nativeError("native.bilibili.vipExclusive", { span }, { retryable: false });
    } else if (context.paid) {
      error = nativeError("native.bilibili.paidRequired", { span }, { retryable: false });
    } else {
      error = nativeError("native.bilibili.previewOnly", { span }, { retryable: false });
    }
    return error;
  }
  function bilibiliMediaFromPlayurl(body, title, context) {
    const gap = bilibiliPreviewGapMs(body, context.fullDurationMs);
    if (gap > 0) throw bilibiliPreviewError(body, context);
    const dash = selectBilibiliDash(body);
    if (dash.ok) {
      const baseName = `${sanitizeFileName(title, "bilibili")}-${dash.video.quality}`;
      const media = [
        { url: dash.video.url, kind: "video", role: "video", fileName: `${baseName}.mp4` }
      ];
      if (dash.audio?.url) media.push({ url: dash.audio.url, kind: "video", role: "audio" });
      return { media, quality: dash.video.quality, width: dash.video.width, height: dash.video.height };
    }
    const parsed = parseBilibiliPlayurl(body);
    if (!parsed.ok) {
      throw parsed.hasDash ? nativeError("native.bilibili.dashTrackUnavailable") : nativeError("native.bilibili.noMp4");
    }
    if (parsed.parts.some((part) => /\.flv(\?|$)/i.test(part.url))) {
      throw nativeError("native.bilibili.flvOnly");
    }
    return {
      media: mediaWithNames(title, parsed.parts.map((part) => ({ url: part.url, kind: "video" }))),
      quality: parsed.quality
    };
  }
  async function resolveBilibiliUgc(bvid) {
    const info = parseBilibiliInitialState(window.__INITIAL_STATE__);
    let cid = info.cid;
    let title = info.title;
    let durationSec = info.durationSec;
    const context = {
      upowerExclusive: info.upowerExclusive,
      upowerPlay: info.upowerPlay,
      paid: info.paid,
      vip: false,
      fullDurationMs: durationSec * 1e3
    };
    if (!cid || !durationSec) {
      const view = await bilibiliView(bvid);
      cid = cid || Number(view.cid) || null;
      title = title || view.title;
      durationSec = durationSec || Number(view.duration) || 0;
      context.upowerExclusive = context.upowerExclusive || Boolean(view.is_upower_exclusive);
      context.upowerPlay = context.upowerPlay || Boolean(view.is_upower_play);
      context.fullDurationMs = durationSec * 1e3;
    }
    if (!cid) throw nativeError("native.bilibili.ugcCidNotFound");
    const body = await bilibiliPlayurl(
      `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&${bilibiliPlayurlQuery(4048)}`
    );
    const displayTitle = title || document.title.replace(/\s*-\s*哔哩哔哩.*$/i, "").trim() || bvid;
    const built = bilibiliMediaFromPlayurl(body, displayTitle, context);
    return {
      ok: true,
      site: "bilibili",
      title: displayTitle,
      kind: "video",
      quality: built.quality,
      width: built.width,
      height: built.height,
      sourceUrl: location.href,
      pageTitle: document.title,
      media: built.media
    };
  }
  async function resolveBilibiliPgc(route) {
    const queryEp = Number(new URLSearchParams(location.search).get("ep_id")) || 0;
    const epId = route.type === "ep" ? route.id : queryEp;
    const seasonParam = route.type === "ep" ? `ep_id=${route.id}` : `season_id=${route.id}`;
    const res = await fetch(`https://api.bilibili.com/pgc/view/web/season?${seasonParam}`, {
      credentials: "include"
    });
    if (!res.ok) throw nativeError("native.bilibili.seasonFetchFailed", { status: res.status });
    const seasonBody = await res.json();
    if (seasonBody.code !== 0) {
      if (seasonBody.message) throw new Error(seasonBody.message);
      throw nativeError("native.bilibili.seasonFailed");
    }
    const season = parseBilibiliPgcSeason(seasonBody, epId);
    if (!season.ok || !season.cid) throw nativeError("native.bilibili.pgcCidNotFound");
    const episodeTitle = season.episodeTitle;
    const displayTitle = [season.title, episodeTitle].filter(Boolean).join(" ") || document.title.replace(/\s*-\s*哔哩哔哩.*$/i, "").trim();
    const body = await bilibiliPlayurl(
      `https://api.bilibili.com/pgc/player/web/playurl?ep_id=${season.epId}&cid=${season.cid}&${bilibiliPlayurlQuery(4048)}`
    );
    const built = bilibiliMediaFromPlayurl(body, displayTitle, {
      upowerExclusive: false,
      upowerPlay: true,
      paid: false,
      vip: season.vip,
      fullDurationMs: season.durationSec * 1e3
    });
    return {
      ok: true,
      site: "bilibili",
      title: displayTitle,
      kind: "video",
      quality: built.quality,
      width: built.width,
      height: built.height,
      sourceUrl: location.href,
      pageTitle: document.title,
      media: built.media
    };
  }
  async function resolveBilibili() {
    const bangumi = bilibiliBangumiRoute();
    if (bangumi) return resolveBilibiliPgc(bangumi);
    const bvid = bvidFromLocation();
    if (!bvid) throw nativeError("native.bilibili.unsupportedPage");
    return resolveBilibiliUgc(bvid);
  }
  function douyinRouterData() {
    if (window._ROUTER_DATA) return window._ROUTER_DATA;
    const el = document.querySelector("#RENDER_DATA");
    if (el?.textContent) {
      try {
        return JSON.parse(decodeURIComponent(el.textContent));
      } catch {
      }
    }
    return window.__INITIAL_STATE__ || null;
  }
  function hasPlayerMediaShape(media) {
    return Boolean(media && (media.awemeId || media.aweme_id) && (media.video || Array.isArray(media.images)));
  }
  function readDouyinPlayerMedia() {
    try {
      const player = window.player || window.__falconDouyinPlayer;
      if (!player) return null;
      const plugins = player?._config?._config?.pluginsConfig;
      if (plugins && typeof plugins === "object") {
        for (const key of ["WatchLaterPlugin", "DanmakuPlugin", "PlayClaritySettingPlugin", "Pip"]) {
          try {
            const info = plugins[key]?.awemeInfo;
            if (hasPlayerMediaShape(info)) return info;
          } catch {
          }
        }
        try {
          for (const value of Object.values(plugins)) {
            const info = value?.awemeInfo;
            if (hasPlayerMediaShape(info)) return info;
          }
        } catch {
        }
      }
      if (hasPlayerMediaShape(player?.config?.awemeInfo)) return player.config.awemeInfo;
      if (hasPlayerMediaShape(player?.controls?.playerConfig?.awemeInfo)) return player.controls.playerConfig.awemeInfo;
    } catch {
    }
    return null;
  }
  function resolveDouyin() {
    let parsed = parseDouyinRouterData(readDouyinPlayerMedia());
    if (!parsed.ok) parsed = parseDouyinRouterData(douyinRouterData());
    if (!parsed.ok) throw nativeError("native.douyin.noData");
    const title = parsed.title || "douyin";
    const playing = playingVideoUrl();
    if (playing && parsed.kind === "video" && parsed.media.length === 1) {
      parsed.media[0].url = playing;
    }
    return {
      ok: true,
      site: "douyin",
      title,
      kind: parsed.kind,
      sourceUrl: location.href,
      pageTitle: document.title,
      media: mediaWithNames(title, parsed.media)
    };
  }
  function playingVideoUrl() {
    let best = "";
    let bestArea = 0;
    for (const video of document.querySelectorAll("video")) {
      const src = video.currentSrc || video.src || "";
      if (!/^https?:/i.test(src)) continue;
      if (/\.m3u8(\?|$)|\.mpd(\?|$)/i.test(src)) continue;
      const area = (video.videoWidth || 0) * (video.videoHeight || 0);
      const playing = !video.paused && video.currentTime > 0;
      const score = (playing ? 1e12 : 0) + area;
      if (area > 0 && score > bestArea) {
        bestArea = score;
        best = src;
      }
    }
    return best;
  }
  function resolveXiaohongshu() {
    const state = window.__INITIAL_STATE__ || window.__INITIAL_SSR_STATE__ || null;
    const parsed = parseXiaohongshuState(state, xhsNoteIdFromLocation());
    if (!parsed.ok) {
      throw parsed.reason === "video_url_missing" ? nativeError("native.xiaohongshu.videoUrlMissing") : nativeError("native.xiaohongshu.noData");
    }
    const title = parsed.title || "xiaohongshu";
    return {
      ok: true,
      site: "xiaohongshu",
      title,
      kind: parsed.kind,
      sourceUrl: location.href,
      pageTitle: document.title,
      media: mediaWithNames(title, parsed.media)
    };
  }
  var YT_INNERTUBE_KEY = "AIzaSyAO_FJ2IrBoYIk1a-Fi-GIWfTfKmGEAuVI";
  function youtubeVideoId() {
    if (location.hostname === "youtu.be") return location.pathname.match(/^\/([\w-]{11})/)?.[1] || "";
    return location.search.match(/[?&]v=([\w-]{11})/)?.[1] || location.pathname.match(/\/(?:shorts|embed|live|v)\/([\w-]{11})/)?.[1] || "";
  }
  async function youtubePlayerFromAndroid(videoId) {
    const key = window.ytcfg?.get?.("INNERTUBE_API_KEY") || YT_INNERTUBE_KEY;
    const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${key}&prettyPrint=false`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId,
        // ANDROID client 的响应通常带明文 url，不需要页面播放器 JS 做 signature decipher
        context: { client: { clientName: "ANDROID", clientVersion: "19.09.37", androidSdkVersion: 30, hl: "en" } }
      })
    });
    if (!res.ok) throw nativeError("native.youtube.playerFetchFailed", { status: res.status });
    return res.json();
  }
  function youtubeError(parsed) {
    let error;
    if (parsed?.reason === "login_required") {
      error = nativeError("native.youtube.loginRequired", void 0, { retryable: false });
    } else if (parsed?.reason === "needs_decipher") {
      error = nativeError("native.youtube.needsDecipher");
    } else if (parsed?.reason === "unplayable") {
      error = parsed.detail ? nativeError("native.youtube.unplayableWithReason", { reason: parsed.detail }) : nativeError("native.youtube.unplayable");
    } else {
      error = nativeError("native.youtube.noStream");
    }
    return error;
  }
  async function resolveYouTube() {
    const videoId = youtubeVideoId();
    if (!videoId) throw nativeError("native.youtube.unsupportedPage");
    let parsed = parseYoutubePlayerResponse(window.ytInitialPlayerResponse || null);
    if (!parsed.ok) {
      parsed = parseYoutubePlayerResponse(await youtubePlayerFromAndroid(videoId));
    }
    if (!parsed.ok) throw youtubeError(parsed);
    const title = parsed.title || document.title.replace(/\s*-\s*YouTube.*$/i, "").trim() || videoId;
    return {
      ok: true,
      site: "youtube",
      title,
      kind: "video",
      quality: parsed.quality,
      width: parsed.width,
      height: parsed.height,
      sourceUrl: location.href,
      pageTitle: document.title,
      media: mediaWithNames(title, parsed.media)
    };
  }
  function tiktokRehydrationPayload() {
    const el = document.querySelector("script#__UNIVERSAL_DATA_FOR_REHYDRATION__");
    if (el?.textContent) {
      try {
        return JSON.parse(el.textContent);
      } catch {
      }
    }
    return null;
  }
  function tiktokLegacyPayload() {
    const el = document.querySelector("script#SIGI_STATE");
    if (el?.textContent) {
      try {
        return JSON.parse(el.textContent);
      } catch {
      }
    }
    return null;
  }
  async function resolveTikTok() {
    let parsed = parseTikTokRehydration(tiktokRehydrationPayload());
    if (!parsed.ok) parsed = parseTikTokLegacy(tiktokLegacyPayload());
    if (!parsed.ok) {
      throw parsed.reason === "private" ? nativeError("native.tiktok.private", void 0, { retryable: false }) : nativeError("native.tiktok.noData");
    }
    const title = parsed.title || "tiktok";
    const playing = playingVideoUrl();
    if (playing && parsed.kind === "video" && parsed.media.length === 1) {
      parsed.media[0].url = playing;
    }
    return {
      ok: true,
      site: "tiktok",
      title,
      kind: parsed.kind,
      sourceUrl: location.href,
      pageTitle: document.title,
      media: mediaWithNames(title, parsed.media)
    };
  }
  async function resolveTwitter() {
    const statusId = location.pathname.match(/\/status(?:es)?\/(\d+)/)?.[1];
    if (!statusId) throw nativeError("native.twitter.unsupportedPage");
    const res = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${statusId}&token=x&lang=en`);
    if (!res.ok) throw nativeError("native.twitter.tweetFetchFailed", { status: res.status });
    const parsed = parseTwitterTweetResult(await res.json());
    if (!parsed.ok) {
      if (parsed.reason === "no_media") throw nativeError("native.twitter.noMedia");
      throw parsed.detail ? nativeError("native.twitter.mediaFailedWithReason", { reason: parsed.detail }) : nativeError("native.twitter.mediaFailed");
    }
    const title = parsed.title || `tweet-${statusId}`;
    return {
      ok: true,
      site: "twitter",
      title,
      kind: parsed.kind,
      sourceUrl: location.href,
      pageTitle: document.title,
      media: mediaWithNames(title, parsed.media)
    };
  }
  function instagramShortcode() {
    return location.pathname.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/)?.[1] || "";
  }
  function instagramEmbeddedWebInfo() {
    for (const el of document.querySelectorAll('script[type="application/json"]')) {
      const text = el.textContent || "";
      if (!text.includes("xdt_api__v1__media__shortcode__web_info")) continue;
      try {
        return JSON.parse(text);
      } catch {
      }
    }
    return null;
  }
  function ogMetaContent(name) {
    return document.querySelector(`meta[property="${name}"]`)?.content || "";
  }
  function resolveInstagram() {
    const shortcode = instagramShortcode();
    if (!shortcode) throw nativeError("native.instagram.unsupportedPage");
    let parsed = parseInstagramWebInfo(instagramEmbeddedWebInfo(), shortcode);
    if (!parsed.ok) {
      parsed = parseInstagramOgMeta({
        ogVideo: ogMetaContent("og:video") || ogMetaContent("og:video:url"),
        ogImage: ogMetaContent("og:image"),
        ogTitle: ogMetaContent("og:title")
      });
    }
    if (!parsed.ok) {
      throw parsed.reason === "video_url_missing" ? nativeError("native.instagram.videoUrlMissing") : nativeError("native.instagram.noData", void 0, { retryable: false });
    }
    const title = parsed.title || `instagram-${shortcode}`;
    return {
      ok: true,
      site: "instagram",
      title,
      kind: parsed.kind,
      sourceUrl: location.href,
      pageTitle: document.title,
      media: mediaWithNames(title, parsed.media)
    };
  }
  function vimeoClipId() {
    return location.pathname.match(/\/(?:video\/)?(\d{6,})(?:[/?#]|$)/)?.[1] || "";
  }
  async function resolveVimeo() {
    const clipId = vimeoClipId();
    if (!clipId) throw nativeError("native.vimeo.unsupportedPage");
    let payload = window.playerConfig || null;
    if (!payload) {
      const res = await fetch(`https://player.vimeo.com/video/${clipId}/config`, { credentials: "omit" });
      if (!res.ok) throw nativeError("native.vimeo.configFetchFailed", { status: res.status });
      payload = await res.json();
    }
    const parsed = parseVimeoConfig(payload);
    if (!parsed.ok) {
      throw parsed.reason === "dash_only" ? nativeError("native.vimeo.dashOnly", void 0, { retryable: false }) : nativeError("native.vimeo.noUrl");
    }
    const title = parsed.title || `vimeo-${clipId}`;
    return {
      ok: true,
      site: "vimeo",
      title,
      kind: "video",
      quality: parsed.quality,
      sourceUrl: location.href,
      pageTitle: document.title,
      media: mediaWithNames(title, parsed.media)
    };
  }
  window.__falconResolveNative = async () => {
    try {
      const host = location.hostname;
      if (host === "bilibili.com" || host.endsWith(".bilibili.com")) return await resolveBilibili();
      if (host === "douyin.com" || host.endsWith(".douyin.com")) return resolveDouyin();
      if (host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com") || host.endsWith(".rednote.com")) {
        return resolveXiaohongshu();
      }
      if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") return await resolveYouTube();
      if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return await resolveTikTok();
      if (host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com")) {
        return await resolveTwitter();
      }
      if (host === "instagram.com" || host.endsWith(".instagram.com") || host === "instagr.am") {
        return await resolveInstagram();
      }
      if (host === "vimeo.com" || host.endsWith(".vimeo.com")) return await resolveVimeo();
      return { ok: false, message: "native.unsupportedSite", key: "native.unsupportedSite" };
    } catch (e) {
      return { ok: false, message: String(e?.message || e), key: e?.key, vars: e?.vars, retryable: e?.retryable !== false };
    }
  };
  window.__falconPageMeta = () => {
    const videos = [...document.querySelectorAll("video")].map((video, index) => ({
      index,
      durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1e3) : 0,
      area: (video.videoWidth || 0) * (video.videoHeight || 0),
      playing: !video.paused && video.currentTime > 0,
      poster: video.poster || ""
    }));
    try {
      const host = location.hostname;
      if (host === "douyin.com" || host.endsWith(".douyin.com")) {
        const video = readDouyinPlayerMedia()?.video || {};
        const cover = douyinCoverUrl(video);
        if (cover) {
          return { videos, cover: { url: cover, durationMs: Number(video.duration) || 0, origin: "douyin" } };
        }
        return { videos };
      }
      if (host === "bilibili.com" || host.endsWith(".bilibili.com")) {
        const pic = window.__INITIAL_STATE__?.videoData?.pic;
        if (pic) {
          return { videos, cover: { url: String(pic), durationMs: 0, origin: "bilibili" } };
        }
        return { videos };
      }
      if (host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com") || host.endsWith(".rednote.com")) {
        const map = window.__INITIAL_STATE__?.note?.noteDetailMap || {};
        const entry = Object.values(map).pop();
        const note = entry?.note || entry;
        const poster = note?.video?.image?.poster || note?.video?.imageList?.[0]?.urlDefault || note?.imageList?.[0]?.urlDefault || "";
        if (poster && (note?.video || note?.type === "video")) {
          return { videos, cover: { url: String(poster), durationMs: 0, origin: "xiaohongshu" } };
        }
        return { videos };
      }
      if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") {
        const thumbs = window.ytInitialPlayerResponse?.videoDetails?.thumbnail?.thumbnails || [];
        const best = thumbs.length > 0 ? thumbs[thumbs.length - 1]?.url : "";
        if (best) return { videos, cover: { url: String(best), durationMs: 0, origin: "youtube" } };
        return { videos };
      }
      if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
        const scope = tiktokRehydrationPayload()?.__DEFAULT_SCOPE__ || {};
        const itemStruct = scope["webapp.video-detail"]?.itemInfo?.itemStruct;
        const cover = tiktokCoverUrl(itemStruct);
        if (cover) {
          return { videos, cover: { url: cover, durationMs: Number(itemStruct?.video?.duration) * 1e3 || 0, origin: "tiktok" } };
        }
        return { videos };
      }
      if (host === "instagram.com" || host.endsWith(".instagram.com")) {
        const og = ogMetaContent("og:image");
        if (og) return { videos, cover: { url: String(og), durationMs: 0, origin: "instagram" } };
        return { videos };
      }
      if (host === "vimeo.com" || host.endsWith(".vimeo.com")) {
        const thumb = window.playerConfig?.video?.thumbs?.base || window.playerConfig?.clip?.thumbs?.base || "";
        if (thumb) return { videos, cover: { url: String(thumb), durationMs: 0, origin: "vimeo" } };
        return { videos };
      }
    } catch {
    }
    return { videos };
  };
})();
