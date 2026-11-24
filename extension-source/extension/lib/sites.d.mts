export interface SiteConfig {
  key: string
  label: string
  script: string
  installUrl: string
  tampermonkeyUrl: string
  origin: string
  hosts: string[]
}

export const SITES: Record<string, SiteConfig>
export const SITE_KEYS: string[]
export const MAX_DOWNLOAD_BYTES: number
export const MEDIA_EXTENSIONS: Set<string>
export const DRM_SITES: Record<string, { key: string; label: string; hosts: string[] }>
export const DRM_SITE_KEYS: string[]

export function hostOfUrl(value: string): string
export function siteOfUrl(value: string): string | null
export function siteOfDownload(item: unknown): string | null
export function siteLabel(site: string): string
export function drmSiteOfUrl(value: string | undefined): string | null
export function drmSiteLabel(key: string | null | undefined): string
export function isMediaDownload(item: unknown): boolean
export function shouldImportDownload(
  item: unknown,
  options?: { autoImport?: boolean; maxBytes?: number }
): { ok: boolean; reason?: string; site?: string }
