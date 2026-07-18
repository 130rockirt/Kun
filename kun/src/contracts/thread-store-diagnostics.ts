import { z } from 'zod'

export const ThreadStoreArtifactStatus = z.enum([
  'ok',
  'missing',
  'invalid',
  'truncated',
  'mismatch',
  'indeterminate',
  'changed',
  'limit_exceeded'
])
export type ThreadStoreArtifactStatus = z.infer<typeof ThreadStoreArtifactStatus>

export const ThreadStoreMetadataSource = z.enum([
  'metadata_jsonl',
  'legacy_thread_json',
  'none'
])
export type ThreadStoreMetadataSource = z.infer<typeof ThreadStoreMetadataSource>

export const ThreadStoreDiagnosticSeverity = z.enum(['warning', 'error'])
export type ThreadStoreDiagnosticSeverity = z.infer<typeof ThreadStoreDiagnosticSeverity>

export const ThreadStoreDiagnosticIssue = z.object({
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(1024),
  severity: ThreadStoreDiagnosticSeverity
}).strict()
export type ThreadStoreDiagnosticIssue = z.infer<typeof ThreadStoreDiagnosticIssue>

export const ThreadStoreDoctorLimitsSchema = z.object({
  maxThreads: z.number().int().positive(),
  maxDirectoryEntries: z.number().int().positive(),
  maxAttachments: z.number().int().positive(),
  maxAttachmentScopeEntries: z.number().int().positive(),
  maxAttachmentScopeItemChars: z.number().int().positive(),
  maxRecordsPerArtifact: z.number().int().positive(),
  maxTotalRecords: z.number().int().positive(),
  maxArtifactBytes: z.number().int().positive(),
  maxTotalBytes: z.number().int().positive()
}).strict()
export type ThreadStoreDoctorLimits = z.infer<typeof ThreadStoreDoctorLimitsSchema>

export const ThreadStoreDiagnostic = z.object({
  threadId: z.string().min(1).max(256),
  metadata: ThreadStoreArtifactStatus,
  metadataSource: ThreadStoreMetadataSource,
  messages: ThreadStoreArtifactStatus,
  events: ThreadStoreArtifactStatus,
  sqliteIndex: ThreadStoreArtifactStatus,
  attachments: ThreadStoreArtifactStatus,
  recoverable: z.boolean(),
  issues: z.array(ThreadStoreDiagnosticIssue).max(64),
  checkedAt: z.string().datetime({ offset: true })
}).strict()
export type ThreadStoreDiagnostic = z.infer<typeof ThreadStoreDiagnostic>

export const ThreadStoreDiagnosticReport = z.object({
  schemaVersion: z.literal(1),
  checkedAt: z.string().datetime({ offset: true }),
  complete: z.boolean(),
  limits: ThreadStoreDoctorLimitsSchema,
  scanned: z.object({
    threads: z.number().int().nonnegative(),
    attachments: z.number().int().nonnegative(),
    records: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative()
  }).strict(),
  issues: z.array(ThreadStoreDiagnosticIssue).max(64),
  threads: z.array(ThreadStoreDiagnostic).max(10_000)
}).strict()
export type ThreadStoreDiagnosticReport = z.infer<typeof ThreadStoreDiagnosticReport>
