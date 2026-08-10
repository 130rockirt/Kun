import { normalizeModelId } from './compat-request-reasoning.js'

/**
 * Moonshot/Kimi K3 pins sampling server-side. Passing temperature/top_p
 * (including temperature=0 used by classifier helpers) returns HTTP 400.
 * Docs require omitting these fields rather than forcing temperature=1.
 */
export function isFixedSamplingModel(model: string | undefined, providerId?: string): boolean {
  const normalized = normalizeModelId(model)
  if (!normalized) return false
  const basename = normalized.split('/').at(-1) ?? normalized
  if (
    basename === 'k3' ||
    basename.startsWith('k3-') ||
    basename === 'kimi-k3' ||
    basename.startsWith('kimi-k3-')
  ) {
    return true
  }
  const provider = `${providerId ?? ''}`.trim().toLowerCase()
  if (!(provider.includes('kimi-code') || provider.includes('moonshot'))) return false
  return basename === 'k3' || basename.startsWith('k3-') || basename.includes('kimi-k3')
}

export function stripFixedSamplingParams<T extends { temperature?: number; topP?: number; model?: string }>(
  request: T,
  providerId?: string
): T {
  if (!isFixedSamplingModel(request.model, providerId)) return request
  if (request.temperature === undefined && request.topP === undefined) return request
  const next = { ...request }
  delete next.temperature
  delete next.topP
  return next
}

export function bodyHasSamplingParams(body: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(body, 'temperature') ||
    Object.prototype.hasOwnProperty.call(body, 'top_p')
}

export function stripSamplingFromBody(body: Record<string, unknown>): Record<string, unknown> {
  if (!bodyHasSamplingParams(body)) return body
  const next = { ...body }
  delete next.temperature
  delete next.top_p
  return next
}

export function shouldRetryWithoutSamplingParams(
  status: number,
  text: string,
  body: Record<string, unknown>
): boolean {
  if (status !== 400 && status !== 422) return false
  if (!bodyHasSamplingParams(body)) return false
  return /\b(temperature|top[_ ]?p|sampling)\b/i.test(text)
}
