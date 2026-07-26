import { z } from 'zod'

/** Hard request-level backstops; per-file limits remain capability-configured. */
export const MAX_TURN_ATTACHMENT_IDS = 8
export const MAX_TURN_ATTACHMENT_BYTES = 20 * 1024 * 1024

export const AttachmentTextFallback = z.object({
  dataBase64: z.string().min(1),
  mimeType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  wasCompressed: z.boolean().optional()
}).strict()
export type AttachmentTextFallback = z.infer<typeof AttachmentTextFallback>
export const AttachmentVisualPreview = AttachmentTextFallback
export type AttachmentVisualPreview = z.infer<typeof AttachmentVisualPreview>

export const AttachmentMetadata = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['image', 'document']).default('image'),
  mimeType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  hash: z.string().min(1),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  documentText: z.string().optional(),
  documentFormat: z.enum(['pdf', 'docx', 'xlsx', 'pptx', 'text', 'csv', 'json', 'xml']).optional(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  pageCount: z.number().int().positive().optional(),
  truncated: z.boolean().optional(),
  localFilePath: z.string().min(1).optional(),
  textFallback: AttachmentTextFallback.optional(),
  visualPreview: AttachmentVisualPreview.optional(),
  threadIds: z.array(z.string().min(1)).default([]),
  workspaces: z.array(z.string().min(1)).default([]),
  createdAt: z.string(),
  updatedAt: z.string()
}).strict()
export type AttachmentMetadata = z.infer<typeof AttachmentMetadata>

export const AttachmentUploadRequest = z.object({
  name: z.string().min(1),
  mimeType: z.string().min(1).optional(),
  dataBase64: z.string().min(1),
  documentText: z.string().optional(),
  documentFormat: z.enum(['pdf', 'docx', 'xlsx', 'pptx', 'text', 'csv', 'json', 'xml']).optional(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  pageCount: z.number().int().positive().optional(),
  localFilePath: z.string().min(1).optional(),
  textFallback: AttachmentTextFallback.optional(),
  visualPreview: AttachmentVisualPreview.optional(),
  leaseId: z.string().min(8).max(128).optional(),
  threadId: z.string().min(1).optional(),
  workspace: z.string().min(1).optional()
}).strict()
export type AttachmentUploadRequest = z.infer<typeof AttachmentUploadRequest>

export const AttachmentUploadResponse = z.object({
  attachment: AttachmentMetadata
}).strict()
export type AttachmentUploadResponse = z.infer<typeof AttachmentUploadResponse>

export const AttachmentReleaseResponse = z.object({
  released: z.boolean()
}).strict()
export type AttachmentReleaseResponse = z.infer<typeof AttachmentReleaseResponse>

export const AttachmentDiagnostics = z.object({
  enabled: z.boolean(),
  rootDir: z.string(),
  count: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative()
}).strict()
export type AttachmentDiagnostics = z.infer<typeof AttachmentDiagnostics>
