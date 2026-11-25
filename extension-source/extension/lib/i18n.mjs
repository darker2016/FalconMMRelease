// 插件界面多语言（11 种，与桌面应用一致）。
// - 词典 key 以 zh-CN 为基准，其余语言全量覆盖（tests/domain/extension-i18n.test.ts 强制一致）
// - 纯模块：导入时不触碰 chrome.*，语言由宿主启动时注入：
//     setLanguage(resolveLanguage(chrome.i18n.getUILanguage()))
// - 页面注入脚本（src/native-page.js）不要 import 本模块：它会被 esbuild 打成注入每个页面的
//   bundle，11 份词典会让体积翻几倍。注入脚本用 nativeError(key, vars) 带 key 抛错，
//   由 background 用 t(key, vars) 翻译成用户语言。

import zhCN from './i18n/zh-CN.mjs'
import zhTW from './i18n/zh-TW.mjs'
import en from './i18n/en.mjs'
import ja from './i18n/ja.mjs'
import ko from './i18n/ko.mjs'
import fr from './i18n/fr.mjs'
import de from './i18n/de.mjs'
import es from './i18n/es.mjs'
import pt from './i18n/pt.mjs'
import ru from './i18n/ru.mjs'
import ar from './i18n/ar.mjs'

export const LANGUAGES = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru', 'ar']

/** 词典基准语言：宿主未注入语言时的默认值（单测与既有中文行为依赖它）。 */
export const DEFAULT_LANGUAGE = 'zh-CN'
/** 系统语言不在支持列表时的回退语言（与桌面应用一致）。 */
export const FALLBACK_LANGUAGE = 'en'

const RTL_LANGUAGES = new Set(['ar'])

export const DICTIONARIES = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  en,
  ja,
  ko,
  fr,
  de,
  es,
  pt,
  ru,
  ar
}

let current = DEFAULT_LANGUAGE

/**
 * 把浏览器界面语言（BCP-47，如 "zh-CN"、"zh-TW"、"pt-BR"）解析到支持的语言。
 * 繁体中文区（TW / HK / MO / Hant）用繁体；其余不在列表里的回退英文。
 */
export function resolveLanguage(locale) {
  if (!locale) return FALLBACK_LANGUAGE
  const lower = String(locale).toLowerCase()
  if (/^zh[-_](tw|hk|mo)/.test(lower) || lower.includes('hant')) return 'zh-TW'
  if (lower.startsWith('zh')) return 'zh-CN'
  if (LANGUAGES.includes(lower)) return lower
  const base = lower.split(/[-_]/)[0]
  if (LANGUAGES.includes(base)) return base
  return FALLBACK_LANGUAGE
}

export function setLanguage(locale) {
  current = resolveLanguage(locale)
  return current
}

export function getLanguage() {
  return current
}

export function isRtl(lang = current) {
  return RTL_LANGUAGES.has(lang)
}

/** 替换模板里的 {name} 变量；缺变量时保留原样，便于排查漏传。 */
export function interpolate(template, vars) {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole))
}

/** 查词顺序：当前语言 → 回退语言 → 基准语言 → key 本身（漏译时界面直接暴露 key）。 */
export function t(key, vars) {
  const value =
    DICTIONARIES[current]?.[key] ??
    DICTIONARIES[FALLBACK_LANGUAGE]?.[key] ??
    DICTIONARIES[DEFAULT_LANGUAGE]?.[key] ??
    key
  return interpolate(value, vars)
}
