import { z } from 'zod'

export const DATA_MIGRATION_FORMAT_VERSION = 1 as const

export const DATA_MIGRATION_MINIMUM_READER_VERSION = 1 as const

export const DATA_MIGRATION_BACKUP_RETENTION_DAYS = 7 as const

export const DATA_MIGRATION_DEFAULT_FRAME_BYTES = 4 * 1024 * 1024

export const DATA_MIGRATION_MAX_METADATA_BYTES = 8 * 1024 * 1024

export const DATA_MIGRATION_MAX_ENTRY_COUNT = 1_000_000

export const DATA_MIGRATION_MINIMUM_FREE_SPACE_RATIO = 0.1

export const DATA_MIGRATION_V1_DEFAULTS = Object.freeze({
  encryption: 'optional' as const,
  allowUnencryptedAfterAcknowledgement: true,
  completeIncludesGit: true,
  smallerIncludesGit: false,
  backupRetentionDays: DATA_MIGRATION_BACKUP_RETENTION_DAYS,
  workflowsImportActive: false,
  schedulesImportEnabled: false,
  clearScheduleChannelBindings: true,
  enterprisePolicyGateReserved: true,
  defaultWorkspaceConflictStrategy: 'keep-both' as const
})

export const DataMigrationSourcePlatformSchema = z.enum(['windows', 'macos', 'linux'])

export type DataMigrationSourcePlatform = z.infer<typeof DataMigrationSourcePlatformSchema>

export const DataMigrationPresetSchema = z.enum(['complete', 'smaller'])

export type DataMigrationPreset = z.infer<typeof DataMigrationPresetSchema>

export const DataMigrationCategorySchema = z.enum([
  'workspace-files',
  'thread-history',
  'attachments',
  'artifacts',
  'memory',
  'portable-settings',
  'renderer-state',
  'workflows',
  'schedules'
])

export type DataMigrationCategory = z.infer<typeof DataMigrationCategorySchema>

export const DataMigrationComponentNameSchema = z.enum([
  'manifest',
  'workspace',
  'thread',
  'session',
  'event',
  'attachment',
  'artifact',
  'memory',
  'portable-settings',
  'renderer-state',
  'workflow',
  'schedule'
])

export type DataMigrationComponentName = z.infer<typeof DataMigrationComponentNameSchema>

export const MIGRATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export const SHA256_PATTERN = /^[a-f0-9]{64}$/

export const DataMigrationIdSchema = z.string().regex(MIGRATION_ID_PATTERN)

export const DataMigrationSha256Schema = z.string().regex(SHA256_PATTERN)

export function isStrictPackageRelativePath(value: string): boolean {
  if (!value || value.includes('\0') || value.includes('\\')) return false
  if (value.startsWith('/') || value.endsWith('/') || value.includes('//')) return false
  if (/^[A-Za-z]:/.test(value) || value.startsWith('~')) return false
  const segments = value.split('/')
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

export const PackageRelativePathSchema = z.string().refine(isStrictPackageRelativePath, {
  message: 'expected a non-absolute POSIX path without dot segments'
}).brand<'PackageRelativePath'>()

export type PackageRelativePath = z.infer<typeof PackageRelativePathSchema>

export function parsePackageRelativePath(value: string): PackageRelativePath {
  return PackageRelativePathSchema.parse(value)
}

export const DataMigrationEncryptionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({
    mode: z.literal('passphrase'),
    algorithm: z.literal('aes-256-gcm-framed'),
    kdf: z.literal('scrypt'),
    saltBase64: z.string().min(1),
    noncePrefixBase64: z.string().min(1),
    frameBytes: z.number().int().positive().max(64 * 1024 * 1024),
    cost: z.number().int().positive(),
    blockSize: z.number().int().positive(),
    parallelization: z.number().int().positive()
  }).strict()
])

export type DataMigrationEncryption = z.infer<typeof DataMigrationEncryptionSchema>

export const DataMigrationEnvelopeHeaderV1Schema = z.object({
  envelopeVersion: z.literal(1),
  payloadFormat: z.literal('zip64'),
  formatVersion: z.literal(DATA_MIGRATION_FORMAT_VERSION),
  createdAt: z.string().min(1),
  plainPayloadBytes: z.number().int().nonnegative(),
  plainPayloadSha256: DataMigrationSha256Schema,
  encryption: DataMigrationEncryptionSchema
}).strict()

export type DataMigrationEnvelopeHeaderV1 = z.infer<typeof DataMigrationEnvelopeHeaderV1Schema>

export const DataMigrationSelectionSchema = z.object({
  preset: DataMigrationPresetSchema,
  workspaceIds: z.array(DataMigrationIdSchema).default([]),
  threadIds: z.array(DataMigrationIdSchema).default([]),
  categories: z.array(DataMigrationCategorySchema).min(1),
  sensitiveContentAcknowledged: z.boolean().default(false),
  unencryptedPackageAcknowledged: z.boolean().default(false)
}).strict()

export type DataMigrationSelection = z.infer<typeof DataMigrationSelectionSchema>

export const DataMigrationWorkspaceCatalogEntrySchema = z.object({
  workspaceId: DataMigrationIdSchema,
  displayName: z.string().min(1),
  sourcePathDisplay: z.string().min(1),
  sourcePlatform: DataMigrationSourcePlatformSchema,
  fileCount: z.number().int().nonnegative(),
  logicalBytes: z.number().int().nonnegative(),
  relatedThreadIds: z.array(DataMigrationIdSchema).default([]),
  capabilities: z.array(z.enum(['code', 'design', 'write'])).default([]),
  nestedUnderWorkspaceId: DataMigrationIdSchema.optional()
}).strict()

export type DataMigrationWorkspaceCatalogEntry = z.infer<typeof DataMigrationWorkspaceCatalogEntrySchema>

export const DataMigrationThreadCatalogEntrySchema = z.object({
  exportThreadId: DataMigrationIdSchema,
  sourceThreadId: DataMigrationIdSchema,
  title: z.string(),
  workspaceId: DataMigrationIdSchema.optional(),
  status: z.enum(['idle', 'archived']),
  relation: z.enum(['primary', 'fork', 'side']).default('primary'),
  parentExportThreadId: DataMigrationIdSchema.optional(),
  model: z.string().optional(),
  providerId: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  canonicalSha256: DataMigrationSha256Schema
}).strict()

export type DataMigrationThreadCatalogEntry = z.infer<typeof DataMigrationThreadCatalogEntrySchema>

export const DataMigrationPackageEntryKindSchema = z.enum([
  'workspace-file',
  'runtime-record',
  'attachment',
  'artifact',
  'memory',
  'catalog',
  'report'
])

export type DataMigrationPackageEntryKind = z.infer<typeof DataMigrationPackageEntryKindSchema>

export const DataMigrationPackageEntrySchema = z.object({
  path: PackageRelativePathSchema,
  kind: DataMigrationPackageEntryKindSchema,
  ownerId: DataMigrationIdSchema.optional(),
  logicalBytes: z.number().int().nonnegative(),
  compressedBytes: z.number().int().nonnegative().optional(),
  sha256: DataMigrationSha256Schema,
  mode: z.number().int().nonnegative().optional(),
  modifiedAt: z.string().min(1).optional(),
  linkTarget: PackageRelativePathSchema.optional()
}).strict()

export type DataMigrationPackageEntry = z.infer<typeof DataMigrationPackageEntrySchema>

export const DataMigrationManifestV1Schema = z.object({
  formatVersion: z.literal(DATA_MIGRATION_FORMAT_VERSION),
  minimumReaderVersion: z.number().int().positive().max(DATA_MIGRATION_FORMAT_VERSION),
  packageId: DataMigrationIdSchema,
  sourceInstallationId: DataMigrationIdSchema,
  sourceAppVersion: z.string().min(1),
  sourceRuntimeVersion: z.string().min(1),
  sourcePlatform: DataMigrationSourcePlatformSchema,
  sourceArch: z.string().min(1),
  createdAt: z.string().min(1),
  encryption: DataMigrationEncryptionSchema,
  componentVersions: z.record(DataMigrationComponentNameSchema, z.number().int().positive()),
  selection: DataMigrationSelectionSchema,
  counts: z.object({
    workspaces: z.number().int().nonnegative(),
    threads: z.number().int().nonnegative(),
    entries: z.number().int().nonnegative(),
    attachments: z.number().int().nonnegative(),
    artifacts: z.number().int().nonnegative(),
    memories: z.number().int().nonnegative()
  }).strict(),
  expandedBytes: z.number().int().nonnegative(),
  catalogsSha256: DataMigrationSha256Schema,
  checksumsSha256: DataMigrationSha256Schema
}).strict()

export type DataMigrationManifestV1 = z.infer<typeof DataMigrationManifestV1Schema>

export const DataMigrationEstimateSchema = z.object({
  workspaces: z.array(DataMigrationWorkspaceCatalogEntrySchema),
  threadCount: z.number().int().nonnegative(),
  attachmentCount: z.number().int().nonnegative(),
  artifactCount: z.number().int().nonnegative(),
  memoryCount: z.number().int().nonnegative(),
  logicalBytes: z.number().int().nonnegative(),
  estimatedPackageBytes: z.number().int().nonnegative(),
  sensitiveFindings: z.array(z.object({
    workspaceId: DataMigrationIdSchema,
    path: PackageRelativePathSchema,
    ruleId: z.string().min(1)
  }).strict()).default([]),
  exclusions: z.array(z.object({
    scope: z.enum(['workspace', 'runtime', 'profile']),
    path: z.string().min(1),
    ruleId: z.string().min(1),
    logicalBytes: z.number().int().nonnegative().default(0)
  }).strict()).default([])
}).strict()

export type DataMigrationEstimate = z.infer<typeof DataMigrationEstimateSchema>

export const DataMigrationReferenceKindSchema = z.enum([
  'workspace-root',
  'workspace-file',
  'thread-id',
  'parent-thread-id',
  'attachment-id',
  'artifact-id',
  'provider-id'
])

export type DataMigrationReferenceKind = z.infer<typeof DataMigrationReferenceKindSchema>

export const DataMigrationReferenceDescriptorSchema = z.object({
  component: DataMigrationComponentNameSchema,
  schemaVersion: z.number().int().positive(),
  kind: DataMigrationReferenceKindSchema,
  jsonPointerPatterns: z.array(z.string().startsWith('/')).min(1),
  required: z.boolean().default(false)
}).strict()

export type DataMigrationReferenceDescriptor = z.infer<typeof DataMigrationReferenceDescriptorSchema>

export const DATA_MIGRATION_REFERENCE_DESCRIPTORS_V1 = Object.freeze([
  { component: 'thread', schemaVersion: 1, kind: 'workspace-root', jsonPointerPatterns: ['/workspace', '/knowledgeBases/*/root'], required: true },
  { component: 'thread', schemaVersion: 1, kind: 'thread-id', jsonPointerPatterns: ['/id'], required: true },
  { component: 'thread', schemaVersion: 1, kind: 'parent-thread-id', jsonPointerPatterns: ['/parentThreadId', '/forkedFromThreadId'], required: false },
  { component: 'thread', schemaVersion: 1, kind: 'provider-id', jsonPointerPatterns: ['/providerId'], required: false },
  { component: 'session', schemaVersion: 1, kind: 'workspace-root', jsonPointerPatterns: ['/workspace', '/context/workspace'], required: false },
  { component: 'session', schemaVersion: 1, kind: 'thread-id', jsonPointerPatterns: ['/threadId'], required: true },
  { component: 'event', schemaVersion: 1, kind: 'thread-id', jsonPointerPatterns: ['/threadId', '/payload/threadId'], required: false },
  { component: 'event', schemaVersion: 1, kind: 'workspace-file', jsonPointerPatterns: ['/payload/path', '/payload/workspaceRoot', '/payload/localFilePath'], required: false },
  { component: 'attachment', schemaVersion: 1, kind: 'workspace-file', jsonPointerPatterns: ['/localFilePath', '/workspaces/*'], required: false },
  { component: 'attachment', schemaVersion: 1, kind: 'thread-id', jsonPointerPatterns: ['/threadIds/*'], required: false },
  { component: 'memory', schemaVersion: 1, kind: 'workspace-root', jsonPointerPatterns: ['/workspace'], required: false },
  { component: 'renderer-state', schemaVersion: 1, kind: 'workspace-file', jsonPointerPatterns: ['/write/*/filePaths/*'], required: false },
  { component: 'renderer-state', schemaVersion: 1, kind: 'workspace-root', jsonPointerPatterns: ['/design/*/workspaceRoot', '/write/*/workspaceRoot', '/plans/*/workspaceRoot', '/sdd/*/workspaceRoot', '/workspaces/*/workspaceRoot'], required: false },
  { component: 'renderer-state', schemaVersion: 1, kind: 'thread-id', jsonPointerPatterns: ['/design/*/threadId', '/write/*/threadId', '/plans/*/threadId', '/sdd/*/threadId', '/sdd/*/threadIds/*', '/sdd/*/publicThreadIds/*', '/forks/*/threadId', '/forks/*/parentThreadId', '/composer/modes/*/threadId'], required: false },
  { component: 'portable-settings', schemaVersion: 1, kind: 'workspace-root', jsonPointerPatterns: ['/workspaceRoot', '/conversationWorkspaceRoot', '/write/workspaceRoot', '/design/workspaceRoot'], required: false },
  { component: 'workflow', schemaVersion: 1, kind: 'workspace-root', jsonPointerPatterns: ['/defaultWorkspaceRoot', '/workflows/*/triggers/*/config/workspaceRoot', '/workflows/*/nodes/*/config/workspaceRoot'], required: false },
  { component: 'schedule', schemaVersion: 1, kind: 'workspace-root', jsonPointerPatterns: ['/tasks/*/workspaceRoot'], required: false },
  { component: 'artifact', schemaVersion: 1, kind: 'artifact-id', jsonPointerPatterns: ['/id'], required: true }
] satisfies readonly DataMigrationReferenceDescriptor[])

export const DataMigrationWorkspaceConflictStrategySchema = z.enum([
  'keep-both',
  'merge',
  'replace',
  'skip'
])

export type DataMigrationWorkspaceConflictStrategy = z.infer<typeof DataMigrationWorkspaceConflictStrategySchema>

export const DataMigrationFileConflictResolutionSchema = z.enum([
  'keep-target',
  'import-sibling',
  'replace-with-backup',
  'skip',
  'rename-source'
])

export type DataMigrationFileConflictResolution = z.infer<typeof DataMigrationFileConflictResolutionSchema>

export const DataMigrationConflictSchema = z.object({
  conflictId: DataMigrationIdSchema,
  workspaceId: DataMigrationIdSchema,
  path: PackageRelativePathSchema,
  kind: z.enum(['different-content', 'file-directory', 'case-collision', 'unicode-collision', 'invalid-name', 'path-too-long', 'unsafe-link']),
  fatal: z.boolean(),
  sourceSha256: DataMigrationSha256Schema.optional(),
  targetSha256: DataMigrationSha256Schema.optional(),
  sourceBytes: z.number().int().nonnegative().optional(),
  targetBytes: z.number().int().nonnegative().optional(),
  resolution: DataMigrationFileConflictResolutionSchema.optional(),
  renamedPath: PackageRelativePathSchema.optional()
}).strict()

export type DataMigrationConflict = z.infer<typeof DataMigrationConflictSchema>

export const DataMigrationWorkspaceMappingSchema = z.object({
  workspaceId: DataMigrationIdSchema,
  sourcePathDisplay: z.string().min(1),
  destinationRoot: z.string().min(1).optional(),
  strategy: DataMigrationWorkspaceConflictStrategySchema,
  compatible: z.boolean(),
  // Optional so recovery can still read journals written before this
  // conflict-independent compatibility marker was introduced.
  preflightCompatible: z.boolean().optional(),
  estimatedPeakBytes: z.number().int().nonnegative().optional(),
  freeBytes: z.number().int().nonnegative().optional(),
  requiredBytes: z.number().int().nonnegative(),
  unresolvedIssueCount: z.number().int().nonnegative()
}).strict()

export type DataMigrationWorkspaceMapping = z.infer<typeof DataMigrationWorkspaceMappingSchema>

export const DataMigrationImportPlanSchema = z.object({
  operationId: DataMigrationIdSchema,
  packageId: DataMigrationIdSchema,
  inspectedAt: z.string().min(1),
  sourcePlatform: DataMigrationSourcePlatformSchema,
  encrypted: z.boolean(),
  mappings: z.array(DataMigrationWorkspaceMappingSchema),
  conflicts: z.array(DataMigrationConflictSchema),
  threadIdMap: z.record(DataMigrationIdSchema, DataMigrationIdSchema).default({}),
  unresolvedReferences: z.array(z.object({
    component: DataMigrationComponentNameSchema,
    ownerId: DataMigrationIdSchema.optional(),
    pointer: z.string().startsWith('/'),
    originalValue: z.string()
  }).strict()).default([]),
  disabledItems: z.array(z.object({
    component: z.enum(['workflow', 'schedule', 'integration', 'provider']),
    id: z.string().min(1),
    reason: z.string().min(1)
  }).strict()).default([]),
  estimatedPeakBytes: z.number().int().nonnegative(),
  fatalIssueCount: z.number().int().nonnegative()
}).strict()

export type DataMigrationImportPlan = z.infer<typeof DataMigrationImportPlanSchema>

export const DataMigrationOperationKindSchema = z.enum(['export', 'import'])

export type DataMigrationOperationKind = z.infer<typeof DataMigrationOperationKindSchema>

export const DataMigrationOperationPhaseSchema = z.enum([
  'inspecting',
  'inspected',
  'snapshotting',
  'scanning',
  'packaging',
  'staging',
  'staged',
  'committing',
  'verifying',
  'rolling-back',
  'completed',
  'failed',
  'cancelled'
])

export type DataMigrationOperationPhase = z.infer<typeof DataMigrationOperationPhaseSchema>

export const DataMigrationProgressSchema = z.object({
  operationId: DataMigrationIdSchema,
  kind: DataMigrationOperationKindSchema,
  phase: DataMigrationOperationPhaseSchema,
  completedItems: z.number().int().nonnegative(),
  totalItems: z.number().int().nonnegative().optional(),
  completedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative().optional(),
  currentWorkspaceId: DataMigrationIdSchema.optional(),
  currentPath: PackageRelativePathSchema.optional(),
  cancellable: z.boolean(),
  cancellationEffect: z.enum(['stop', 'cleanup', 'rollback']).optional(),
  updatedAt: z.string().min(1)
}).strict()

export type DataMigrationProgress = z.infer<typeof DataMigrationProgressSchema>

export const DATA_MIGRATION_ERROR_CODES = [
  'PACKAGE_NOT_KUNPACK',
  'PACKAGE_PASSWORD_REQUIRED',
  'PACKAGE_PASSWORD_INVALID',
  'PACKAGE_INTEGRITY_FAILED',
  'PACKAGE_UNSAFE_ENTRY',
  'PACKAGE_BUDGET_EXCEEDED',
  'VERSION_UNSUPPORTED',
  'PATH_INVALID',
  'PATH_COLLISION',
  'PATH_UNSAFE_LINK',
  'SPACE_INSUFFICIENT',
  'CONFLICT_UNRESOLVED',
  'RUNTIME_BUSY',
  'RUNTIME_IMPORT_FAILED',
  'IO_PERMISSION_DENIED',
  'IO_SOURCE_CHANGED',
  'RECOVERY_REQUIRED',
  'RECOVERY_MANUAL_INTERVENTION'
] as const

export const DataMigrationErrorCodeSchema = z.enum(DATA_MIGRATION_ERROR_CODES)

export type DataMigrationErrorCode = z.infer<typeof DataMigrationErrorCodeSchema>

export const DataMigrationErrorSchema = z.object({
  code: DataMigrationErrorCodeSchema,
  phase: DataMigrationOperationPhaseSchema,
  message: z.string().min(1),
  destinationEffect: z.enum(['untouched', 'staged-only', 'rolled-back', 'partially-committed', 'committed']),
  retryable: z.boolean(),
  nextActions: z.array(z.string().min(1)).min(1),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional()
}).strict()

export type DataMigrationError = z.infer<typeof DataMigrationErrorSchema>

export const DataMigrationReportSchema = z.object({
  operationId: DataMigrationIdSchema,
  packageId: DataMigrationIdSchema,
  kind: DataMigrationOperationKindSchema,
  outcome: z.enum(['success', 'completed-with-review', 'rolled-back', 'failed']),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  workspacePathMap: z.record(DataMigrationIdSchema, z.string()),
  threadIdMap: z.record(DataMigrationIdSchema, DataMigrationIdSchema),
  exclusions: z.array(z.object({ ruleId: z.string().min(1), count: z.number().int().nonnegative() }).strict()).default([]),
  warnings: z.array(z.string()).default([]),
  unresolvedReferences: z.number().int().nonnegative(),
  disabledItems: z.number().int().nonnegative(),
  sourcePlatform: DataMigrationSourcePlatformSchema.optional(),
  destinationPlatform: DataMigrationSourcePlatformSchema.optional(),
  conflicts: z.array(z.object({
    workspaceId: DataMigrationIdSchema,
    path: PackageRelativePathSchema,
    kind: DataMigrationConflictSchema.shape.kind,
    resolution: DataMigrationFileConflictResolutionSchema.optional()
  }).strict()).optional(),
  skippedItems: z.array(z.object({
    component: DataMigrationComponentNameSchema,
    id: z.string().min(1),
    reason: z.string().min(1)
  }).strict()).optional(),
  renamedPaths: z.record(PackageRelativePathSchema, PackageRelativePathSchema).optional(),
  disabledItemDetails: z.array(z.object({
    component: z.enum(['workflow', 'schedule', 'integration', 'provider']),
    id: z.string().min(1),
    reason: z.string().min(1)
  }).strict()).optional(),
  unresolvedReferenceDetails: z.array(z.object({
    component: DataMigrationComponentNameSchema,
    ownerId: DataMigrationIdSchema.optional(),
    pointer: z.string().startsWith('/'),
    originalValue: z.string()
  }).strict()).optional(),
  backups: z.array(z.object({
    workspaceId: DataMigrationIdSchema.optional(),
    path: z.string().min(1),
    expiresAt: z.string().min(1).optional()
  }).strict()).optional(),
  timingsMs: z.record(z.string(), z.number().int().nonnegative()).optional(),
  backupExpiresAt: z.string().min(1).optional(),
  error: DataMigrationErrorSchema.optional()
}).strict()

export type DataMigrationReport = z.infer<typeof DataMigrationReportSchema>

export const DataMigrationPolicySchema = z.object({
  exportEnabled: z.boolean().default(true),
  importEnabled: z.boolean().default(true),
  requireEncryption: z.boolean().default(false),
  allowedExportRoots: z.array(z.string().min(1)).default([]),
  allowedImportRoots: z.array(z.string().min(1)).default([]),
  maximumExpandedBytes: z.number().int().positive().optional()
}).strict()

export type DataMigrationPolicy = z.infer<typeof DataMigrationPolicySchema>

export const DataMigrationInspectionSummarySchema = z.object({
  inspectionId: DataMigrationIdSchema,
  packagePath: z.string().min(1),
  packageId: DataMigrationIdSchema,
  sourcePlatform: DataMigrationSourcePlatformSchema,
  sourceArch: z.string().min(1),
  sourceAppVersion: z.string().min(1),
  createdAt: z.string().min(1),
  encrypted: z.boolean(),
  expandedBytes: z.number().int().nonnegative(),
  compressedBytes: z.number().int().nonnegative(),
  categories: z.array(DataMigrationCategorySchema),
  workspaces: z.array(DataMigrationWorkspaceCatalogEntrySchema),
  threads: z.array(DataMigrationThreadCatalogEntrySchema),
  counts: DataMigrationManifestV1Schema.shape.counts,
  warnings: z.array(z.string())
}).strict()

export type DataMigrationInspectionSummary = z.infer<typeof DataMigrationInspectionSummarySchema>

export const DataMigrationOperationStatusSchema = z.object({
  featureEnabled: z.boolean(),
  activeOperationId: DataMigrationIdSchema.optional(),
  activeKind: DataMigrationOperationKindSchema.optional(),
  progress: DataMigrationProgressSchema.optional(),
  recoverable: z.array(z.object({
    operationId: DataMigrationIdSchema,
    packageId: DataMigrationIdSchema,
    phase: DataMigrationOperationPhaseSchema,
    updatedAt: z.string().min(1),
    destinationEffect: z.enum(['untouched', 'staged-only', 'partially-committed']),
    error: DataMigrationErrorSchema.optional(),
    warnings: z.array(z.string()).default([]),
    manualRecoverySteps: z.array(z.string()).default([]),
    reportPath: z.string().min(1).optional()
  }).strict()),
  recentReports: z.array(DataMigrationReportSchema)
}).strict()

export type DataMigrationOperationStatus = z.infer<typeof DataMigrationOperationStatusSchema>

export type DataMigrationPathPickResult = { canceled: boolean; path: string | null }

export type DataMigrationExportOptions = {
  operationId: string
  outputPath: string
  selectedWorkspaceIds: string[]
  selectedThreadIds: string[]
  categories: DataMigrationCategory[]
  preset: DataMigrationPreset
  sensitiveContentAcknowledged: boolean
  unencryptedPackageAcknowledged: boolean
  passphrase?: string
  runningThreadPolicy: 'wait' | 'interrupt' | 'omit'
}

export type DataMigrationImportOptions = {
  operationId: string
  inspectionId: string
  packagePath: string
  passphrase?: string
  plan: DataMigrationImportPlan
}

export type DataMigrationRendererRequest = {
  requestId: string
  action: 'capture-state' | 'replace-state' | 'capture-trust' | 'apply-trust' | 'refresh'
  payload?: unknown
}

export type DataMigrationRendererResponse = {
  requestId: string
  ok: boolean
  value?: unknown
  error?: string
}

export type ImportedWorkspaceTrustReset = {
  workspaceRoot: string
  trusted: false
  disabledCapabilities: Array<
    'hooks' | 'commands' | 'extensions' | 'schedules' | 'workflows' | 'connect-channels' | 'external-actions'
  >
}

export type RestoredRendererState = {
  schemaVersion: 1
  design: unknown[]
  write: unknown[]
  plans: unknown[]
  sdd: unknown[]
  forks: unknown[]
  threads: unknown[]
  composer: Record<string, unknown>
  workspaces: unknown[]
  unresolvedReferences: Array<{ pointer: string; originalValue: string }>
}
