import { engineError } from './errors.js'

export function validateMulticamRangeOperation(operation: Record<string, unknown>): void {
  nonNegativeInteger(operation.startFrame, 'operation.startFrame')
  positiveInteger(operation.endFrame, 'operation.endFrame')
  if (Number(operation.endFrame) <= Number(operation.startFrame)) {
    fail('multicam operation range must be non-empty')
  }
  if (operation.coveragePolicy !== undefined) {
    oneOf(operation.coveragePolicy, ['reject', 'clamp'], 'operation.coveragePolicy')
  }
  if (operation.minimumSyncConfidence !== undefined) {
    finiteRange(operation.minimumSyncConfidence, 'operation.minimumSyncConfidence', 0, 1)
  }
}

export function exactObjectKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set(allowed)
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key))
  if (unknown.length > 0) fail(`${path} contains unsupported field ${unknown[0]}`)
}

export function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`)
  return value as Record<string, unknown>
}

export function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`)
  return value
}

export function boundedArray(
  value: unknown,
  path: string,
  maximum: number,
  minimum = 0
): unknown[] {
  const parsed = array(value, path)
  if (parsed.length < minimum || parsed.length > maximum) {
    fail(`${path} must contain between ${minimum} and ${maximum} entries`)
  }
  return parsed
}

export function uniqueObjectIds(values: readonly unknown[], path: string): void {
  const seen = new Set<string>()
  values.forEach((value, index) => {
    const entry = object(value, `${path}[${index}]`)
    const id = String(entry.id)
    if (seen.has(id)) fail(`${path} contains duplicate identity ${id}`)
    seen.add(id)
  })
}

export function identifier(value: unknown, path: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(value)) {
    fail(`${path} must be a bounded stable identifier`)
  }
}

export function optionalIdentifier(value: unknown, path: string): void {
  if (value !== undefined) identifier(value, path)
}

export function optionalRelativePath(value: unknown, path: string): void {
  if (value === undefined) return
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1024 ||
    value.startsWith('/') ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.split(/[\\/]/u).some((part) => part === '..' || part === '')
  ) {
    fail(`${path} must be a confined workspace-relative path`)
  }
}

export function boundedString(value: unknown, path: string, minimum: number, maximum: number): void {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    fail(`${path} must contain between ${minimum} and ${maximum} characters`)
  }
}

export function isoTimestamp(value: unknown, path: string): void {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail(`${path} must be an ISO timestamp`)
}

export function finite(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path} must be finite`)
}

export function finiteRange(value: unknown, path: string, minimum: number, maximum: number): void {
  finite(value, path)
  if (Number(value) < minimum || Number(value) > maximum) fail(`${path} is outside the supported range`)
}

export function nonNegativeInteger(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(`${path} must be a non-negative safe integer`)
}

export function positiveInteger(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail(`${path} must be a positive safe integer`)
}

export function optionalBoolean(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== 'boolean') fail(`${path} must be a boolean`)
}

export function oneOf(value: unknown, options: readonly unknown[], path: string): void {
  if (!options.includes(value)) fail(`${path} contains an unsupported value`)
}

export function fail(message: string): never {
  throw engineError('invalid_project', message)
}
