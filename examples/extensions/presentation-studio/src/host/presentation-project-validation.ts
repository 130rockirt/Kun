import { ExtensionApiError, type JsonObject } from '@kun/extension-api'
import {
  MAX_PRESENTATION_HTML_BYTES,
  MAX_PRESENTATION_OPERATIONS,
  stableStringify,
  type PresentationOperation,
  type PresentationValidationIssue
} from '../shared/presentation.js'

const MAX_OPERATION_BATCH_BYTES = 256_000
const PRESENTATION_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]*\.kun-ppt\.html$/

export function validatePresentationPath(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 240 ||
    !PRESENTATION_PATH_PATTERN.test(value)
  ) {
    throw invalidArgument(
      'Presentation path must be one root-level ASCII filename ending in .kun-ppt.html',
      { path: typeof value === 'string' ? value.slice(0, 240) : '' }
    )
  }
  return value
}

export function validateTitle(value: string): string {
  // eslint-disable-next-line no-control-regex -- explicit rejection of unsafe ASCII controls
  if (value.trim().length === 0 || value.length > 160 || /[\u0000-\u001F]/.test(value)) {
    throw invalidArgument('Presentation title must contain 1 to 160 printable characters')
  }
  return value
}

export function validateRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalidArgument('expectedRevision must be a positive safe integer')
  }
  return value
}

export function validateOperationId(value: string): string {
  // eslint-disable-next-line no-control-regex -- explicit rejection of unsafe ASCII controls
  if (value.trim().length === 0 || value.length > 128 || /[\u0000-\u001F]/.test(value)) {
    throw invalidArgument('operationId must contain 1 to 128 printable characters')
  }
  return value
}

export function validateOperations(value: PresentationOperation[]): PresentationOperation[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PRESENTATION_OPERATIONS) {
    throw invalidArgument(`operations must contain 1 to ${MAX_PRESENTATION_OPERATIONS} entries`)
  }
  let bytes: number
  try {
    bytes = byteLength(stableStringify(value))
  } catch {
    throw invalidArgument('operations must be bounded JSON values')
  }
  if (bytes > MAX_OPERATION_BATCH_BYTES) {
    throw new ExtensionApiError({
      code: 'RESOURCE_LIMIT',
      message: `Operation batch exceeds ${MAX_OPERATION_BATCH_BYTES} bytes`,
      operation: 'presentation.apply',
      retryable: false,
      details: { bytes, limit: MAX_OPERATION_BATCH_BYTES }
    })
  }
  return value
}

export function assertExpectedRevision(path: string, actual: number, expected: number): void {
  if (actual === expected) return
  throw conflict(
    `Revision conflict for ${path}: expected revision ${expected}, current revision is ${actual}`,
    { path, expectedRevision: expected, currentRevision: actual }
  )
}

export function assertHtmlSize(path: string, bytes: number): void {
  if (bytes <= MAX_PRESENTATION_HTML_BYTES) return
  throw new ExtensionApiError({
    code: 'RESOURCE_LIMIT',
    message: `Presentation ${path} exceeds ${MAX_PRESENTATION_HTML_BYTES} bytes`,
    operation: 'presentation.workspace',
    retryable: false,
    details: { path, bytes, limit: MAX_PRESENTATION_HTML_BYTES }
  })
}

export function titleFromPath(path: string): string {
  return path.slice(0, -'.kun-ppt.html'.length).replaceAll(/[-_]+/g, ' ').trim() || 'Untitled presentation'
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function issuesFrom(
  error: unknown,
  fallbackCode: string,
  fallbackPath: string,
  fallbackMessage: string
): PresentationValidationIssue[] {
  if (
    typeof error === 'object' && error !== null &&
    'issues' in error && Array.isArray((error as { issues?: unknown }).issues)
  ) {
    const issues = (error as { issues: PresentationValidationIssue[] }).issues.slice(0, 1024)
    if (issues.length > 0) return issues
  }
  return [{ code: fallbackCode, path: fallbackPath, message: fallbackMessage }]
}

export function entryName(entry: JsonObject): string {
  const value = entry.name ?? entry.path
  return typeof value === 'string' ? value : ''
}

export function nonCanonicalHtmlIssue(): PresentationValidationIssue {
  return {
    code: 'non_canonical_html',
    path: '$html',
    message: 'HTML outside the embedded model must match the deterministic script-free projection'
  }
}

export function invalidArgument(message: string, details?: JsonObject): ExtensionApiError {
  return new ExtensionApiError({
    code: 'INVALID_ARGUMENT',
    message,
    operation: 'presentation.input',
    retryable: false,
    ...(details ? { details } : {})
  })
}

export function conflict(message: string, details?: JsonObject): ExtensionApiError {
  return new ExtensionApiError({
    code: 'CONFLICT',
    message,
    operation: 'presentation.workspace',
    retryable: true,
    ...(details ? { details } : {})
  })
}

export function validationFailure(
  message: string,
  issues: PresentationValidationIssue[] = []
): ExtensionApiError {
  return new ExtensionApiError({
    code: 'VALIDATION_FAILED',
    message,
    operation: 'presentation.parse',
    retryable: false,
    details: { issues: issues.slice(0, 1024) }
  })
}

export function unknownWriteOutcome(message: string, details: JsonObject): ExtensionApiError {
  return new ExtensionApiError({
    code: 'INTERNAL_ERROR',
    message,
    operation: 'presentation.workspace.write.verify',
    retryable: false,
    details
  })
}
