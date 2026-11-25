export type Language = 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'pt' | 'ru' | 'ar'
export type TranslateVars = Record<string, string | number>

export const LANGUAGES: Language[]
export const DEFAULT_LANGUAGE: Language
export const FALLBACK_LANGUAGE: Language
export const DICTIONARIES: Record<Language, Record<string, string>>

/** 浏览器界面语言（BCP-47）→ 支持的语言；不在列表里回退英文。 */
export function resolveLanguage(locale: string | null | undefined): Language
export function setLanguage(locale: string | null | undefined): Language
export function getLanguage(): Language
export function isRtl(lang?: string): boolean
export function interpolate(template: string, vars?: TranslateVars): string
export function t(key: string, vars?: TranslateVars): string
