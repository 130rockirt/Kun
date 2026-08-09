import { z } from 'zod'
import { containsAsciiControlCharacters, MediaHandleIdSchema } from './media-core.js'


/**
 * Host-owned local visual analysis. The public surface exposes a verified
 * model/algorithm identity plus bounded vectors; frame bytes, executable
 * arguments, model locations, paths, and reusable media URLs never cross the
 * broker boundary.
 */
export const MediaVisualModelFileSchema = z.strictObject({
  name: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  sha256: z.string().length(64).regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
})
export type MediaVisualModelFile = z.infer<typeof MediaVisualModelFileSchema>

export const MediaVisualModelDescriptorSchema = z.strictObject({
  adapterId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  adapterVersion: z.string().min(1).max(64).regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/),
  modelId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  modelVersion: z.string().min(1).max(64).regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/),
  packageId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  manifestSha256: z.string().length(64).regex(/^[a-f0-9]{64}$/),
  files: z.array(MediaVisualModelFileSchema).min(1).max(128),
  embeddingDimensions: z.number().int().min(1).max(4_096),
  execution: z.literal('local'),
  querySemantics: z.literal('bounded-visual-features-v1')
}).superRefine((value, context) => {
  const names = value.files.map(({ name }) => name)
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: 'custom', path: ['files'], message: 'Visual model file names must be unique' })
  }
})
export type MediaVisualModelDescriptor = z.infer<typeof MediaVisualModelDescriptorSchema>

export const MediaVisualModelInstallReceiptSchema = z.strictObject({
  broker: z.literal('kun-model-broker'),
  packageSource: z.enum(['bundled', 'downloaded']),
  packageId: z.string().min(1).max(128),
  modelId: z.string().min(1).max(128),
  modelVersion: z.string().min(1).max(64),
  manifestSha256: z.string().length(64).regex(/^[a-f0-9]{64}$/),
  files: z.array(MediaVisualModelFileSchema).min(1).max(128),
  /** True only when bytes actually came from a download and were verified. */
  downloadVerified: z.boolean(),
  /** True when the selected bundled/downloaded package source was verified. */
  sourceVerified: z.literal(true),
  installVerified: z.literal(true),
  signatureVerified: z.literal(true),
  installedAt: z.string().datetime()
}).superRefine((value, context) => {
  if (value.packageSource === 'downloaded' && !value.downloadVerified) {
    context.addIssue({
      code: 'custom',
      path: ['downloadVerified'],
      message: 'Downloaded visual model packages must have a verified download'
    })
  }
  if (value.packageSource === 'bundled' && value.downloadVerified) {
    context.addIssue({
      code: 'custom',
      path: ['downloadVerified'],
      message: 'Bundled visual model packages must not claim a download occurred'
    })
  }
})
export type MediaVisualModelInstallReceipt = z.infer<typeof MediaVisualModelInstallReceiptSchema>

export const MediaVisualModelStatusSchema = z.strictObject({
  schemaVersion: z.literal(1),
  state: z.enum(['missing', 'installed', 'failed']),
  descriptor: MediaVisualModelDescriptorSchema,
  receipt: MediaVisualModelInstallReceiptSchema.optional(),
  installSupported: z.boolean(),
  checkedAt: z.string().datetime(),
  remediation: z.string().min(1).max(1_024),
  local: z.literal(true),
  networkUsedForInference: z.literal(false),
  rawPathsExposed: z.literal(false),
  urlsAccepted: z.literal(false)
}).superRefine((value, context) => {
  if (value.state === 'installed' && !value.receipt) {
    context.addIssue({ code: 'custom', path: ['receipt'], message: 'Installed visual model status requires a receipt' })
  }
  if (value.receipt && (
    value.receipt.packageId !== value.descriptor.packageId ||
    value.receipt.modelId !== value.descriptor.modelId ||
    value.receipt.modelVersion !== value.descriptor.modelVersion ||
    value.receipt.manifestSha256 !== value.descriptor.manifestSha256
  )) {
    context.addIssue({ code: 'custom', path: ['receipt'], message: 'Visual model receipt identity must match its descriptor' })
  }
})
export type MediaVisualModelStatus = z.infer<typeof MediaVisualModelStatusSchema>

export const MediaInstallVisualModelRequestSchema = z.strictObject({})
export type MediaInstallVisualModelRequest = z.infer<typeof MediaInstallVisualModelRequestSchema>

export const MediaVisualAdapterBindingSchema = z.strictObject({
  id: z.string().min(1).max(128),
  version: z.string().min(1).max(64),
  modelId: z.string().min(1).max(128),
  modelVersion: z.string().min(1).max(64),
  packageId: z.string().min(1).max(128),
  manifestSha256: z.string().length(64).regex(/^[a-f0-9]{64}$/),
  embeddingDimensions: z.number().int().min(1).max(4_096),
  execution: z.literal('local')
})
export type MediaVisualAdapterBinding = z.infer<typeof MediaVisualAdapterBindingSchema>

export const MediaVisualFrameSampleSchema = z.strictObject({
  sampleId: z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  startMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  endMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  representativeMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
}).superRefine((value, context) => {
  if (value.endMicros <= value.startMicros) {
    context.addIssue({ code: 'custom', path: ['endMicros'], message: 'Visual sample end must be after start' })
  }
  if (value.representativeMicros < value.startMicros || value.representativeMicros >= value.endMicros) {
    context.addIssue({
      code: 'custom',
      path: ['representativeMicros'],
      message: 'Visual sample representative time must be inside its half-open range'
    })
  }
})
export type MediaVisualFrameSample = z.infer<typeof MediaVisualFrameSampleSchema>

export const MediaVisualUnavailableCodeSchema = z.enum([
  'VISUAL_EXECUTABLE_UNAVAILABLE',
  'VISUAL_MODEL_MISSING',
  'VISUAL_MODEL_UNVERIFIED',
  'VISUAL_MODEL_MISMATCH',
  'VISUAL_MEDIA_UNSUPPORTED',
  'VISUAL_QUERY_UNSUPPORTED'
])
export type MediaVisualUnavailableCode = z.infer<typeof MediaVisualUnavailableCodeSchema>

const MediaVisualUnavailableResultSchema = z.strictObject({
  outcome: z.literal('unavailable'),
  code: MediaVisualUnavailableCodeSchema,
  remediation: z.string().min(1).max(1_024),
  retryable: z.boolean(),
  local: z.literal(true),
  networkUsed: z.literal(false)
})

export const MediaAnalyzeVisualFramesRequestSchema = z.strictObject({
  inputHandleId: MediaHandleIdSchema,
  samples: z.array(MediaVisualFrameSampleSchema).min(1).max(16),
  adapter: MediaVisualAdapterBindingSchema
}).superRefine((value, context) => {
  const ids = value.samples.map(({ sampleId }) => sampleId)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['samples'], message: 'Visual sample IDs must be unique' })
  }
})
export type MediaAnalyzeVisualFramesRequest = z.infer<typeof MediaAnalyzeVisualFramesRequestSchema>

const MediaVisualSourceSchema = z.strictObject({
  handleId: MediaHandleIdSchema,
  fingerprint: z.string().length(64).regex(/^[a-f0-9]{64}$/),
  fingerprintAlgorithm: z.literal('sha256-file-identity-v1')
})

export const MediaAnalyzeVisualFramesResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('ready'),
    source: MediaVisualSourceSchema,
    adapter: MediaVisualAdapterBindingSchema,
    embeddings: z.array(z.strictObject({
      sampleId: z.string().min(1).max(512),
      vector: z.array(z.number().finite().min(-1).max(1)).min(1).max(4_096)
    })).min(1).max(16),
    provenance: z.strictObject({
      algorithm: z.literal('kun.rgb-edge-features'),
      algorithmVersion: z.literal('1.0.0'),
      decodedFrameWidth: z.literal(32),
      decodedFrameHeight: z.literal(32),
      local: z.literal(true),
      networkUsed: z.literal(false)
    })
  }).superRefine((value, context) => {
    const ids = value.embeddings.map(({ sampleId }) => sampleId)
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', path: ['embeddings'], message: 'Visual embedding sample IDs must be unique' })
    }
    for (const [index, embedding] of value.embeddings.entries()) {
      if (embedding.vector.length !== value.adapter.embeddingDimensions) {
        context.addIssue({
          code: 'custom',
          path: ['embeddings', index, 'vector'],
          message: 'Visual embedding dimensions must match the verified adapter'
        })
      }
    }
  }),
  MediaVisualUnavailableResultSchema
])
export type MediaAnalyzeVisualFramesResult = z.infer<typeof MediaAnalyzeVisualFramesResultSchema>

export const MediaEmbedVisualQueryRequestSchema = z.strictObject({
  query: z.string().min(1).max(256).refine((value) => !containsAsciiControlCharacters(value), {
    message: 'Visual query must contain printable text'
  }),
  adapter: MediaVisualAdapterBindingSchema
})
export type MediaEmbedVisualQueryRequest = z.infer<typeof MediaEmbedVisualQueryRequestSchema>

export const MediaEmbedVisualQueryResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('ready'),
    adapter: MediaVisualAdapterBindingSchema,
    vector: z.array(z.number().finite().min(-1).max(1)).min(1).max(4_096),
    matchedConcepts: z.array(z.string().min(1).max(64)).min(1).max(32),
    scoreSemantics: z.literal('uncalibrated-cosine'),
    local: z.literal(true),
    networkUsed: z.literal(false)
  }).superRefine((value, context) => {
    if (value.vector.length !== value.adapter.embeddingDimensions) {
      context.addIssue({
        code: 'custom',
        path: ['vector'],
        message: 'Visual query dimensions must match the verified adapter'
      })
    }
  }),
  MediaVisualUnavailableResultSchema
])
export type MediaEmbedVisualQueryResult = z.infer<typeof MediaEmbedVisualQueryResultSchema>
