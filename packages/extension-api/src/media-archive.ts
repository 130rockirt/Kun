import { z } from 'zod'
import { JsonObjectSchema } from './common.js'
import { JobReferenceSchema } from './jobs.js'
import { MediaHandleIdSchema, MediaMetadataSchema } from './media-core.js'

export const MAX_MEDIA_ARCHIVE_ENTRIES = 512
export const MAX_MEDIA_ARCHIVE_INLINE_BYTES = 2 * 1024 * 1024

export const MediaArchivePathSchema = z.string().min(1).max(512).superRefine((value, context) => {
  if (
    value.startsWith('/') || value.endsWith('/') || value.includes('\\') ||
    value.includes('\0') || value.split('/').some((segment) =>
      !segment || segment === '.' || segment === '..' || segment.length > 160
    )
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Archive entry paths must be normalized relative POSIX file paths'
    })
  }
})
export type MediaArchivePath = z.infer<typeof MediaArchivePathSchema>

export const MediaArchiveInputEntrySchema = z.strictObject({
  kind: z.literal('media'),
  inputHandleId: MediaHandleIdSchema,
  archivePath: MediaArchivePathSchema
})
export type MediaArchiveInputEntry = z.infer<typeof MediaArchiveInputEntrySchema>

export const MediaArchiveInlineEntrySchema = z.strictObject({
  kind: z.literal('inline-text'),
  archivePath: MediaArchivePathSchema,
  content: z.string().max(MAX_MEDIA_ARCHIVE_INLINE_BYTES),
  mimeType: z.enum(['application/json', 'application/x-otio+json', 'text/markdown', 'text/plain'])
})
export type MediaArchiveInlineEntry = z.infer<typeof MediaArchiveInlineEntrySchema>

export const MediaStartArchiveJobRequestSchema = z.strictObject({
  format: z.literal('zip'),
  outputHandleId: MediaHandleIdSchema,
  entries: z.array(z.discriminatedUnion('kind', [
    MediaArchiveInputEntrySchema,
    MediaArchiveInlineEntrySchema
  ])).min(1).max(MAX_MEDIA_ARCHIVE_ENTRIES),
  idempotencyKey: z.string().min(1).max(256).optional()
}).superRefine((value, context) => {
  const paths = value.entries.map(({ archivePath }) => archivePath)
  if (new Set(paths).size !== paths.length) {
    context.addIssue({
      code: 'custom',
      path: ['entries'],
      message: 'Archive entry paths must be unique'
    })
  }
  const inlineBytes = value.entries.reduce((total, entry) =>
    total + (entry.kind === 'inline-text' ? new TextEncoder().encode(entry.content).byteLength : 0), 0)
  if (inlineBytes > MAX_MEDIA_ARCHIVE_INLINE_BYTES) {
    context.addIssue({
      code: 'custom',
      path: ['entries'],
      message: `Inline archive content exceeds ${MAX_MEDIA_ARCHIVE_INLINE_BYTES} UTF-8 bytes`
    })
  }
})
export type MediaStartArchiveJobRequest = z.input<typeof MediaStartArchiveJobRequestSchema>
export type ParsedMediaStartArchiveJobRequest = z.infer<typeof MediaStartArchiveJobRequestSchema>

export const MediaStartArchiveJobResultSchema = z.strictObject({
  outcome: z.literal('started'),
  job: JobReferenceSchema
})
export type MediaStartArchiveJobResult = z.infer<typeof MediaStartArchiveJobResultSchema>

export const MediaArchiveJobResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  format: z.literal('zip'),
  entryCount: z.number().int().min(1).max(MAX_MEDIA_ARCHIVE_ENTRIES),
  inputBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  archiveBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().length(64).regex(/^[a-f0-9]{64}$/),
  generatedMedia: MediaMetadataSchema
})
export type MediaArchiveJobResult = z.infer<typeof MediaArchiveJobResultSchema>

export const MEDIA_ERROR_CODES = [
  'MEDIA_CANCELLED',
  'MEDIA_INTERACTION_REQUIRED',
  'MEDIA_PERMISSION_DENIED',
  'MEDIA_SCOPE_DENIED',
  'MEDIA_NOT_FOUND',
  'MEDIA_HANDLE_REVOKED',
  'MEDIA_EXECUTABLE_UNAVAILABLE',
  'MEDIA_INVALID_ARGUMENT',
  'MEDIA_INVALID_OUTPUT',
  'MEDIA_LIMIT_EXCEEDED',
  'MEDIA_TIMEOUT'
] as const

export const MediaErrorCodeSchema = z.enum(MEDIA_ERROR_CODES)
export type MediaErrorCode = z.infer<typeof MediaErrorCodeSchema>

export const MediaErrorSchema = z.strictObject({
  code: MediaErrorCodeSchema,
  message: z.string().min(1).max(4096),
  operation: z.string().min(1).max(128),
  retryable: z.boolean(),
  limitCategory: z.string().min(1).max(128).optional(),
  details: JsonObjectSchema.optional()
})
export type MediaError = z.infer<typeof MediaErrorSchema>
