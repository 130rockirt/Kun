import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ProviderQuotaMetric } from '../contracts/provider-quota.js'
import { GeminiCliOAuthSource } from '../adapters/model/gemini-cli-oauth.js'
import {
  codexCliUserAgent,
  geminiCliRequestHeaders
} from '../adapters/model/provider-cli-identity.js'
import {
  isStoredCodexCredentialExpired,
  parseStoredCodexOAuthCredentials,
  refreshStoredCodexOAuthCredentials,
  type StoredCodexOAuthCredentials
} from './codex-oauth-credential-refresher.js'
import {
  isStoredGrokCredentialExpired,
  parseStoredGrokOAuthCredentials,
  refreshStoredGrokOAuthCredentials,
  type StoredGrokOAuthCredentials
} from './grok-oauth-credential-refresher.js'
import {
  readOpenCodeGoLocalQuota,
  type OpenCodeGoLocalQuotaResult
} from './opencode-go-local-quota.js'
import {
  fetchOpenCodeGoWebQuota as fetchOpenCodeGoWebQuotaImpl,
  filterOpenCodeGoCookieHeader,
  OpenCodeGoWebQuotaError,
  type OpenCodeGoWebQuotaResult
} from './opencode-go-web-quota.js'
import {
  listChromiumCookieDatabaseCandidates,
  readChromiumCookiesForDomainsWithDiagnosis,
  type ChromiumCookieDatabaseCandidate
} from './chromium-browser-cookies.js'

export function isBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(value)
}

export function formatWindowSeconds(seconds: number): string {
  if (seconds % 604_800 === 0) return `${seconds / 604_800}-week`
  if (seconds % 86_400 === 0) return `${seconds / 86_400}-day`
  if (seconds % 3_600 === 0) return `${seconds / 3_600}-hour`
  return `${seconds}-second`
}

export function percentageFields(
  used: number | undefined,
  limit: number | undefined
): { usedPercent?: number } {
  if (used === undefined || limit === undefined || limit <= 0) return {}
  return { usedPercent: clampPercentage((used / limit) * 100) }
}

export function epochToIso(value: unknown): string | undefined {
  const numeric = numberValue(value)
  if (numeric === undefined || numeric <= 0) return undefined
  const date = new Date(numeric < 100_000_000_000 ? numeric * 1_000 : numeric)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

export function isoDateValue(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

export type JsonRecord = Record<string, unknown>

export function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function optionalRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

export function requireRecord(value: unknown, message: string): JsonRecord {
  const record = optionalRecord(value)
  if (!record) throw new Error(message)
  return record
}

export function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value))
}
