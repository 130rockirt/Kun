import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, win32 as win32Path } from 'node:path'
import electronUpdater from 'electron-updater'
import type { UpdateInfo } from 'electron-updater'
import type { GuiUpdateChannel } from '../shared/gui-update'

// R2 prefix 保持旧值:线上还在运行的 DeepSeek GUI 老版本轮询的
// 就是 `deepseek-gui/channels/<channel>/latest/`,prefix 一改老客户端
// 就再也收不到 Kun 的升级包。域名优先使用 kun-agent,旧域名仅作兜底。
export const PRIMARY_R2_PUBLIC_BASE_URL = 'https://www.kun-agent.com/api/r2'
export const SECONDARY_R2_PUBLIC_BASE_URL = 'https://kun-agent.com/api/r2'
export const LEGACY_R2_PUBLIC_BASE_URL = 'https://deepseek-gui.com/api/r2'
export const DEFAULT_R2_RELEASE_PREFIX = 'deepseek-gui'
export const UPDATE_FEED_PROBE_TIMEOUT_MS = 5_000
export const { autoUpdater } = electronUpdater
export const DEVELOPMENT_APP_FLAVOR = process.env.KUN_APP_FLAVOR === 'development'
export const DEVELOPMENT_UPDATE_MESSAGE =
  'kun-dv is a source/testing application and cannot use the production Kun update channel.'
export const WINDOWS_INSTALLER_UPDATE_SOURCE_ENV = 'KUN_INSTALLER_UPDATE_SOURCE'

export function envWithLegacyFallback(kunName: string, legacyName: string): string {
  return process.env[kunName]?.trim() || process.env[legacyName]?.trim() || ''
}

export function setWindowsInstallerUpdateSource(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  executablePath: string = process.execPath
): () => void {
  if (platform !== 'win32') return () => undefined
  const hadPrevious = Object.prototype.hasOwnProperty.call(env, WINDOWS_INSTALLER_UPDATE_SOURCE_ENV)
  const previous = env[WINDOWS_INSTALLER_UPDATE_SOURCE_ENV]
  env[WINDOWS_INSTALLER_UPDATE_SOURCE_ENV] = win32Path.dirname(executablePath)
  return () => {
    if (hadPrevious && previous !== undefined) {
      env[WINDOWS_INSTALLER_UPDATE_SOURCE_ENV] = previous
    } else {
      delete env[WINDOWS_INSTALLER_UPDATE_SOURCE_ENV]
    }
  }
}

export const GUI_UPDATE_SCHEDULE_FILE = 'gui-update-schedule.json'
export const GUI_VERSION_STATE_FILE = 'gui-version-state.json'
export const DEFAULT_CHANGELOG_DIRECTORY_URL = 'https://github.com/KunAgent/Kun/tree/master/release'
export const DEFAULT_CHANGELOG_FILE_BASE_URL = 'https://github.com/KunAgent/Kun/blob/master/release'

export type GuiVersionState = {
  lastSeenVersion?: string
  pendingUpdate?: {
    version: string
    releaseNotes?: string
  }
}

export function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '')
}

export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

export function joinUrl(base: string, ...parts: string[]): string {
  const cleanBase = normalizeBaseUrl(base)
  const cleanParts = parts.map((p) => trimSlashes(p)).filter(Boolean)
  return [cleanBase, ...cleanParts].join('/')
}

export function envUpdateUrl(channel: GuiUpdateChannel): string {
  const channelSpecific = envWithLegacyFallback(
    `KUN_UPDATE_URL_${channel.toUpperCase()}`,
    `DEEPSEEK_GUI_UPDATE_URL_${channel.toUpperCase()}`
  )
  const direct = channelSpecific || envWithLegacyFallback('KUN_UPDATE_URL', 'DEEPSEEK_GUI_UPDATE_URL')
  return direct ? direct.replace(/\{channel\}/g, channel).replace(/\/?$/, '/') : ''
}

export function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

export function defaultR2BaseUrls(): string[] {
  const configured = process.env.R2_PUBLIC_BASE_URL?.trim()
  if (configured) return [configured]
  return [PRIMARY_R2_PUBLIC_BASE_URL, SECONDARY_R2_PUBLIC_BASE_URL, LEGACY_R2_PUBLIC_BASE_URL]
}

export function updateFeedUrlCandidates(channel: GuiUpdateChannel): string[] {
  const direct = envUpdateUrl(channel)
  if (direct) return [direct]

  const prefix = process.env.R2_RELEASE_PREFIX?.trim() || DEFAULT_R2_RELEASE_PREFIX
  return uniqueStrings(
    defaultR2BaseUrls().map((base) => `${joinUrl(base, prefix, 'channels', channel, 'latest')}/`)
  )
}

export function updateFeedUrl(channel: GuiUpdateChannel): string {
  return updateFeedUrlCandidates(channel)[0]
}

export function updateFeedManifestUrl(feedUrl: string): string {
  return `${feedUrl}${platformManifestName()}`
}

export async function isUpdateFeedAccessible(feedUrl: string): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), UPDATE_FEED_PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(updateFeedManifestUrl(feedUrl), {
      method: 'HEAD',
      headers: {
        Accept: 'application/x-yaml,text/yaml,text/plain,*/*',
        'User-Agent': `kun/${app.getVersion()}`
      },
      signal: controller.signal
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

export async function resolveUpdateFeedUrl(channel: GuiUpdateChannel): Promise<string> {
  const candidates = updateFeedUrlCandidates(channel)
  if (candidates.length <= 1) return candidates[0]

  for (const candidate of candidates) {
    if (await isUpdateFeedAccessible(candidate)) return candidate
  }
  return candidates[candidates.length - 1]
}

export function guiUpdateSchedulePath(): string {
  return join(app.getPath('userData'), GUI_UPDATE_SCHEDULE_FILE)
}

export function guiVersionStatePath(): string {
  return join(app.getPath('userData'), GUI_VERSION_STATE_FILE)
}

export async function readGuiVersionState(): Promise<GuiVersionState> {
  try {
    const raw = await readFile(guiVersionStatePath(), 'utf8')
    const parsed = JSON.parse(raw) as GuiVersionState
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export async function writeGuiVersionState(state: GuiVersionState): Promise<void> {
  const path = guiVersionStatePath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(state, null, 2), 'utf8')
}

export function normalizeChangelogVersion(version: string): string {
  const cleaned = version.trim().replace(/^v/i, '')
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(cleaned) ? `v${cleaned}` : ''
}

export function changelogUrl(version?: string): string {
  const normalizedVersion = normalizeChangelogVersion(version ?? '')
  const configured = envWithLegacyFallback('KUN_CHANGELOG_URL', 'DEEPSEEK_GUI_CHANGELOG_URL')
  if (configured) {
    return normalizedVersion ? configured.replace(/\{version\}/g, normalizedVersion) : configured
  }
  return normalizedVersion
    ? `${DEFAULT_CHANGELOG_FILE_BASE_URL}/release-${encodeURIComponent(normalizedVersion)}.md`
    : DEFAULT_CHANGELOG_DIRECTORY_URL
}

export function normalizeReleaseNotes(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (!Array.isArray(value)) return undefined
  const notes = value
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || !('note' in entry)) return ''
      return typeof entry.note === 'string' ? entry.note.trim() : ''
    })
    .filter(Boolean)
  return notes.length > 0 ? notes.join('\n\n') : undefined
}

export async function recordPendingUpdate(updateInfo: UpdateInfo): Promise<void> {
  const state = await readGuiVersionState()
  await writeGuiVersionState({
    ...state,
    pendingUpdate: {
      version: updateInfo.version.trim(),
      releaseNotes: normalizeReleaseNotes(updateInfo.releaseNotes)
    }
  })
}
export async function readLastScheduledCheckAt(): Promise<number | null> {
  try {
    const raw = await readFile(guiUpdateSchedulePath(), 'utf8')
    const parsed = JSON.parse(raw) as { lastCheckedAt?: unknown }
    const ms = typeof parsed.lastCheckedAt === 'string' ? Date.parse(parsed.lastCheckedAt) : Number.NaN
    return Number.isFinite(ms) ? ms : null
  } catch {
    return null
  }
}

export async function writeLastScheduledCheckAt(nowMs: number): Promise<void> {
  const path = guiUpdateSchedulePath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    JSON.stringify({ lastCheckedAt: new Date(nowMs).toISOString() }, null, 2),
    'utf8'
  )
}

export function normalizeGithubOwnerRepo(raw: string): string | null {
  let s = raw.trim()
  if (!s) return null
  if (s.startsWith('github:')) s = s.slice('github:'.length).trim()
  const ssh = s.match(/^git@github\.com:([\w.-]+\/[\w.-]+?)(?:\.git)?$/i)
  if (ssh?.[1]) return ssh[1].replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
  const https = s.match(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:$|[#/])/i)
  if (https?.[1]) return https[1].replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return s
  return null
}

export function packageJsonPath(): string {
  return join(app.getAppPath(), 'package.json')
}

export function readPackageJson(): Record<string, unknown> | null {
  try {
    const path = packageJsonPath()
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

export function resolveGithubReleaseUrl(): string | null {
  const envRepo = normalizeGithubOwnerRepo(process.env.DEEPSEEK_GUI_GITHUB_REPO?.trim() ?? '')
  if (envRepo) return `https://github.com/${envRepo}/releases`

  const pkg = readPackageJson()
  const repository = pkg?.repository
  const raw =
    typeof repository === 'string'
      ? repository
      : repository && typeof repository === 'object' && 'url' in repository
        ? String((repository as { url?: unknown }).url ?? '')
        : ''
  const repo = normalizeGithubOwnerRepo(raw)
  return repo ? `https://github.com/${repo}/releases` : null
}

export function downloadPageUrl(channel: GuiUpdateChannel): string {
  const direct = envWithLegacyFallback('KUN_DOWNLOAD_URL', 'DEEPSEEK_GUI_DOWNLOAD_URL')
  if (direct) return direct

  const pkg = readPackageJson()
  const homepage = typeof pkg?.homepage === 'string' ? pkg.homepage.trim() : ''
  if (homepage) return homepage

  return resolveGithubReleaseUrl() ?? updateFeedUrl(channel)
}

export function releaseUrlForVersion(version: string, channel: GuiUpdateChannel): string {
  const page = downloadPageUrl(channel)
  if (/github\.com\/.+\/releases\/?$/i.test(page)) {
    return `${page.replace(/\/+$/, '')}/tag/v${version.replace(/^v/i, '')}`
  }
  return page
}

export function parseVersionParts(v: string): number[] {
  const cleaned = v.trim().replace(/^v/i, '').replace(/-.*$/, '')
  return cleaned.split('.').map((part) => Number.parseInt(part, 10) || 0)
}

export function isVersionGreater(latest: string, current: string): boolean {
  const a = parseVersionParts(latest)
  const b = parseVersionParts(current)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av > bv) return true
    if (av < bv) return false
  }
  return false
}

export function platformManifestName(): string {
  if (process.platform === 'darwin') return 'latest-mac.yml'
  if (process.platform === 'linux') return 'latest-linux.yml'
  return 'latest.yml'
}

export function parseYamlScalar(source: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`^${escaped}:\\s*['"]?([^'"\\n]+)['"]?\\s*$`, 'm'))
  return match?.[1]?.trim() ?? ''
}

export function macAutoUpdateAllowed(): boolean {
  if (process.platform !== 'darwin') return true
  if (process.env.DEEPSEEK_GUI_ALLOW_UNSIGNED_UPDATES === '1') return true

  const pkg = readPackageJson()
  const hints = pkg?.buildHints
  if (!hints || typeof hints !== 'object') return false
  const values = hints as { macSigningEnabled?: unknown; notarizationEnabled?: unknown }
  return values.macSigningEnabled === true && values.notarizationEnabled === true
}

export function unsupportedMessage(): string {
  if (process.platform === 'darwin') {
    return 'Automatic updates require a signed and notarized macOS build. Use the download page for this build.'
  }
  return 'Automatic updates are not supported for this build. Use the download page instead.'
}

export function extractHttpStatus(raw: string): number | null {
  const match = raw.match(/\b(\d{3})\b/)
  if (!match) return null
  const status = Number.parseInt(match[1], 10)
  return Number.isFinite(status) ? status : null
}

export function sanitizeUpdaterError(raw: string, channel: GuiUpdateChannel): string {
  const message = raw.trim()
  if (!message) {
    return `Could not read GUI update metadata for the ${channel} channel. Open the download page instead.`
  }

  if (/Invalid release object path\./i.test(message)) {
    return `The ${channel} update feed is not published correctly yet. Open the download page instead.`
  }

  if (/Object not found\./i.test(message)) {
    return `The ${channel} update feed is missing release metadata right now. Open the download page instead.`
  }

  const status = extractHttpStatus(message)
  if (status === 400 || status === 404) {
    return `The ${channel} update feed is not available right now. Open the download page instead.`
  }
  if (status === 403) {
    return `The ${channel} update feed denied this request. Open the download page instead.`
  }
  if (status === 429) {
    return `The ${channel} update feed is rate limited right now. Please try again later.`
  }
  if (status && status >= 500) {
    return `The ${channel} update feed is temporarily unavailable. Please try again later.`
  }

  return message.split(/\n(?:Headers:|Data:)/, 1)[0].trim() || message
}
