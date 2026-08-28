import { z } from 'zod'

export const WpsOfficeFormatSchema = z.enum(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'])
export const WpsOfficeVersionSchema = z.object({
  id: z.string().min(1).max(512),
  etag: z.string().max(512).optional(),
  updatedAt: z.string().datetime()
}).strict()
export const WpsOfficeDocumentRefSchema = z.object({
  documentId: z.string().min(1).max(512),
  fileId: z.string().min(1).max(512),
  format: WpsOfficeFormatSchema,
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  version: WpsOfficeVersionSchema
}).strict()
export const WpsOfficeSessionSchema = z.object({
  sessionId: z.string().min(1).max(512),
  appId: z.string().min(1).max(512),
  fileId: z.string().min(1).max(512),
  officeType: z.enum(['word', 'sheet', 'slide']),
  token: z.string().min(1).max(8192),
  expiresAt: z.string().datetime(),
  frameOrigin: z.string().url()
}).strict().superRefine((session, context) => {
  const url = new URL(session.frameOrigin)
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['frameOrigin'],
      message: 'frameOrigin must be a credential-free HTTPS origin'
    })
  }
})

export const WpsOfficeInspectRequestSchema = z.object({
  action: z.enum(['summary', 'text', 'outline', 'query', 'issues', 'validate']),
  target: z.string().max(4096).optional(),
  maxLines: z.number().int().min(1).max(4000).optional()
}).strict()
export const WpsOfficeInspectResponseSchema = z.object({
  version: WpsOfficeVersionSchema,
  result: z.unknown()
}).strict()
export const WpsOfficeRenderResponseSchema = z.object({
  kind: z.enum(['image/png', 'text/html']),
  dataBase64: z.string().max(5_592_408)
}).strict()

export type WpsOfficeFormat = z.infer<typeof WpsOfficeFormatSchema>
export type WpsOfficeVersion = z.infer<typeof WpsOfficeVersionSchema>
export type WpsOfficeDocumentRef = z.infer<typeof WpsOfficeDocumentRefSchema>
export type WpsOfficeSession = z.infer<typeof WpsOfficeSessionSchema>
export type WpsOfficeInspectRequest = z.infer<typeof WpsOfficeInspectRequestSchema>
export type WpsOfficeInspectResponse = z.infer<typeof WpsOfficeInspectResponseSchema>
export type WpsOfficeRenderResponse = z.infer<typeof WpsOfficeRenderResponseSchema>

export type WpsOfficeOperation = Record<string, unknown>

export type WpsOfficeGatewayErrorCode =
  | 'not_configured'
  | 'gateway_unavailable'
  | 'invalid_gateway_response'
  | 'remote_changed'
  | 'source_changed'
  | 'download_failed'

export class WpsOfficeGatewayError extends Error {
  constructor(
    readonly code: WpsOfficeGatewayErrorCode,
    message: string,
    readonly retryable = false
  ) {
    super(message)
    this.name = 'WpsOfficeGatewayError'
  }
}
