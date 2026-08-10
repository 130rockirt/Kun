export const DEFAULT_DEV_PREVIEW_URL = 'http://127.0.0.1:5173/'

export type DevPreviewUrlRejectionReason = 'invalid' | 'scheme' | 'metadata'

/**
 * Cloud metadata endpoints that must never be reachable from the preview
 * webview. Mirrors src/main/browser-use/network-policy.ts.
 */
const BLOCKED_PUBLIC_METADATA_IPS = new Set(['169.254.169.254', '168.63.129.16'])

function stripIpv6Brackets(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
}

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN
    return Number(part)
  })
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null
  }
  return octets
}

/**
 * Local-network hostname predicate, kept for callers that only want to detect
 * or label local preview targets. The preview URL policy itself also accepts
 * public HTTP(S) hosts; see classifyDevPreviewUrlInput.
 */
export function isAllowedDevPreviewHostname(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname)
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'host.docker.internal' ||
    host.endsWith('.local') ||
    host === '::1'
  ) {
    return true
  }

  const octets = parseIpv4(host)
  if (!octets) return false

  const [a, b] = octets
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  )
}

function isCloudMetadataHost(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname)
  return host === 'metadata' || host.startsWith('metadata.')
}

function isBlockedCloudMetadataIp(hostname: string): boolean {
  return BLOCKED_PUBLIC_METADATA_IPS.has(stripIpv6Brackets(hostname))
}

type DevPreviewUrlClassification =
  | { kind: 'ok'; url: URL }
  | { kind: 'rejected'; reason: DevPreviewUrlRejectionReason }

function classifyDevPreviewUrlInput(input: string): DevPreviewUrlClassification {
  let value = input.trim()
  if (!value) return { kind: 'rejected', reason: 'invalid' }

  if (/^\d{2,5}$/.test(value)) {
    value = `http://127.0.0.1:${value}`
  } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    // Bare input: either a hostname or host:port (http://localhost:5173), or a
    // semantic scheme without a delimiter (javascript:, data:, file:). Only the
    // former is completed with http://; semantic schemes stay as-is so the
    // protocol check below can reject them with the 'scheme' reason.
    const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(value)
    const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : null
    const rest = schemeMatch ? value.slice(schemeMatch[0].length) : value
    if (!scheme || /^\d{1,5}$/.test(rest)) {
      value = `http://${value}`
    }
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { kind: 'rejected', reason: 'invalid' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'rejected', reason: 'scheme' }
  }

  if (url.username || url.password) {
    return { kind: 'rejected', reason: 'invalid' }
  }

  const host = stripIpv6Brackets(url.hostname)
  if (host === '0.0.0.0' || host === '::') {
    url.hostname = '127.0.0.1'
  }

  if (isCloudMetadataHost(host) || isBlockedCloudMetadataIp(host)) {
    return { kind: 'rejected', reason: 'metadata' }
  }

  if (!url.pathname) url.pathname = '/'
  return { kind: 'ok', url }
}

/**
 * Returns the rejection reason for a preview URL input, or null when the input
 * is acceptable. Mirrors normalizeDevPreviewUrlInput so callers can show
 * precise error messages.
 */
export function devPreviewUrlRejectionReason(
  input: string
): DevPreviewUrlRejectionReason | null {
  const result = classifyDevPreviewUrlInput(input)
  return result.kind === 'ok' ? null : result.reason
}

export function normalizeDevPreviewUrlInput(input: string): string | null {
  const result = classifyDevPreviewUrlInput(input)
  return result.kind === 'ok' ? result.url.toString() : null
}

export function isAllowedDevPreviewUrl(value: string): boolean {
  return normalizeDevPreviewUrlInput(value) !== null
}
