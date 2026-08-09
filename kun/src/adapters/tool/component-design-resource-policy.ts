const NETWORK_SCRIPT_RE = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/i
const REMOTE_URL_RE = /https?:\/\/[^\s"'<>`)}\]]+/gi
const REMOTE_SCRIPT_SRC_RE = /<script\b[^>]*\bsrc\s*=\s*(["'])(https?:\/\/[^"']+)\1[^>]*>/gi
const REMOTE_FORM_ACTION_RE = /<form\b[^>]*\baction\s*=\s*(["'])https?:\/\/[^"']+\1/i
const COMPONENT_ARTIFACT_PATH_RE =
  /^\.kun-design\/component-prototypes\/[^/]+\/prototype\.html$/i

export type ComponentPrototypeResourcePolicy = {
  assetOrigins: string[]
  scriptOrigins: string[]
  connectOrigins: string[]
}

export function emptyResourcePolicy(): ComponentPrototypeResourcePolicy {
  return { assetOrigins: [], scriptOrigins: [], connectOrigins: [] }
}

export function hasRemoteResourcePolicy(policy: ComponentPrototypeResourcePolicy): boolean {
  return policy.assetOrigins.length + policy.scriptOrigins.length + policy.connectOrigins.length > 0
}

export function normalizeResourcePolicy(value: unknown): ComponentPrototypeResourcePolicy {
  if (value === undefined || value === null) return emptyResourcePolicy()
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('resourcePolicy must be an object')
  const record = value as Record<string, unknown>
  return {
    assetOrigins: normalizeOrigins(record.assetOrigins, 'resourcePolicy.assetOrigins', 24),
    scriptOrigins: normalizeOrigins(record.scriptOrigins, 'resourcePolicy.scriptOrigins', 12),
    connectOrigins: normalizeOrigins(record.connectOrigins, 'resourcePolicy.connectOrigins', 24)
  }
}

function normalizeOrigins(value: unknown, field: string, maxItems: number): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  if (value.length > maxItems) throw new Error(`${field} may contain at most ${maxItems} origins`)
  return [...new Set(value.map((entry, index) => {
    if (typeof entry !== 'string') throw new Error(`${field}[${index}] must be a string`)
    let url: URL
    try {
      url = new URL(entry.trim())
    } catch {
      throw new Error(`${field}[${index}] must be an exact HTTPS origin`)
    }
    const host = url.hostname.toLowerCase()
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
      || isLocalOrPrivateHost(host)
    ) {
      throw new Error(`${field}[${index}] must be a public exact HTTPS origin`)
    }
    return url.origin
  }))]
}

function isLocalOrPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '[::1]') return true
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31)
    || (parts[0] === 192 && parts[1] === 168)
}

export function normalizeComponentArtifactPath(path: string): string {
  const normalized = path.trim().replaceAll('\\', '/')
  if (!COMPONENT_ARTIFACT_PATH_RE.test(normalized) || normalized.split('/').includes('..')) {
    throw new Error('artifactPath must match .kun-design/component-prototypes/<id>/prototype.html')
  }
  return normalized
}

export function componentPrototypeCsp(policy: ComponentPrototypeResourcePolicy): string {
  const sources = (base: string[], origins: string[]): string => [...base, ...origins].join(' ')
  return [
    "default-src 'none'",
    `style-src ${sources(["'unsafe-inline'", "'self'"], policy.assetOrigins)}`,
    `script-src ${sources(["'unsafe-inline'", "'self'"], policy.scriptOrigins)}`,
    `img-src ${sources(["'self'", 'data:', 'blob:'], policy.assetOrigins)}`,
    `font-src ${sources(["'self'", 'data:'], policy.assetOrigins)}`,
    `media-src ${sources(["'self'", 'data:', 'blob:'], policy.assetOrigins)}`,
    policy.connectOrigins.length > 0 ? `connect-src ${policy.connectOrigins.join(' ')}` : "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
}

export function validateRemoteResources(
  html: string,
  policy: ComponentPrototypeResourcePolicy
): void {
  if (REMOTE_FORM_ACTION_RE.test(html)) throw new Error('component prototype must not submit remote forms')
  const allowed = new Set([
    ...policy.assetOrigins,
    ...policy.scriptOrigins,
    ...policy.connectOrigins
  ])
  const urls = html.match(REMOTE_URL_RE) ?? []
  for (const raw of urls) {
    let origin = ''
    try {
      origin = new URL(raw).origin
    } catch {
      throw new Error(`component prototype contains an invalid remote URL: ${raw.slice(0, 120)}`)
    }
    if (!allowed.has(origin)) {
      throw new Error(`component prototype uses undeclared remote origin: ${origin}`)
    }
  }
  for (const match of html.matchAll(REMOTE_SCRIPT_SRC_RE)) {
    const origin = new URL(match[2]!).origin
    if (!policy.scriptOrigins.includes(origin)) {
      throw new Error(`component prototype remote script origin is not explicitly trusted: ${origin}`)
    }
  }
  if (NETWORK_SCRIPT_RE.test(html) && policy.connectOrigins.length === 0) {
    throw new Error('component prototype network requests require resourcePolicy.connectOrigins')
  }
}
