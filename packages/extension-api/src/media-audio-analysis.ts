import { z } from 'zod'
import { JsonObjectSchema } from './common.js'
import { JobReferenceSchema } from './jobs.js'
import { MediaHandleIdSchema } from './media-core.js'

/**
 * Host-owned local audio analysis. Extensions select a bounded algorithm and
 * opaque media handles; they never provide commands, filters, paths, or native
 * executable arguments.
 */
export const MediaAudioAnalysisKindSchema = z.enum([
  'silence',
  'beat-grid',
  'sync-features'
])
export type MediaAudioAnalysisKind = z.infer<typeof MediaAudioAnalysisKindSchema>

export const MediaAudioAnalysisUnavailableCodeSchema = z.enum([
  'AUDIO_ANALYSIS_EXECUTABLE_UNAVAILABLE',
  'AUDIO_ANALYSIS_ALGORITHM_UNAVAILABLE'
])
export type MediaAudioAnalysisUnavailableCode = z.infer<
  typeof MediaAudioAnalysisUnavailableCodeSchema
>

export const MediaAudioAnalysisCapabilitySchema = z.discriminatedUnion('available', [
  z.strictObject({
    analysis: MediaAudioAnalysisKindSchema,
    available: z.literal(true),
    algorithm: z.string().min(1).max(128),
    algorithmVersion: z.string().min(1).max(64),
    local: z.literal(true),
    networkUsed: z.literal(false)
  }),
  z.strictObject({
    analysis: MediaAudioAnalysisKindSchema,
    available: z.literal(false),
    code: MediaAudioAnalysisUnavailableCodeSchema,
    remediation: z.string().min(1).max(1024),
    retryable: z.boolean(),
    local: z.literal(true),
    networkUsed: z.literal(false)
  })
])
export type MediaAudioAnalysisCapability = z.infer<typeof MediaAudioAnalysisCapabilitySchema>

export const MediaAudioAnalysisCapabilitiesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  probedAt: z.string().datetime(),
  analyses: z.array(MediaAudioAnalysisCapabilitySchema).length(3)
}).superRefine((value, context) => {
  const kinds = value.analyses.map(({ analysis }) => analysis)
  if (new Set(kinds).size !== kinds.length) {
    context.addIssue({
      code: 'custom',
      path: ['analyses'],
      message: 'Audio analysis capabilities must contain unique analysis kinds'
    })
  }
  for (const required of MediaAudioAnalysisKindSchema.options) {
    if (!kinds.includes(required)) {
      context.addIssue({
        code: 'custom',
        path: ['analyses'],
        message: `Audio analysis capability is missing ${required}`
      })
    }
  }
})
export type MediaAudioAnalysisCapabilities = z.infer<
  typeof MediaAudioAnalysisCapabilitiesSchema
>

const AudioAnalysisIdempotencyKeySchema = z.string().min(1).max(256).optional()

export const MediaStartSilenceAnalysisJobRequestSchema = z.strictObject({
  analysis: z.literal('silence'),
  inputHandleId: MediaHandleIdSchema,
  noiseThresholdDb: z.number().finite().min(-100).max(-1).default(-35),
  minimumSilenceMicros: z.number().int().min(20_000).max(60_000_000).default(300_000),
  maxIntervals: z.number().int().min(1).max(2_048).default(1_000),
  idempotencyKey: AudioAnalysisIdempotencyKeySchema,
  metadata: JsonObjectSchema.optional()
})
export type MediaStartSilenceAnalysisJobRequest = z.input<
  typeof MediaStartSilenceAnalysisJobRequestSchema
>

export const MediaStartBeatAnalysisJobRequestSchema = z.strictObject({
  analysis: z.literal('beat-grid'),
  inputHandleId: MediaHandleIdSchema,
  maxMarkers: z.number().int().min(1).max(4_096).default(2_000),
  idempotencyKey: AudioAnalysisIdempotencyKeySchema,
  metadata: JsonObjectSchema.optional()
})
export type MediaStartBeatAnalysisJobRequest = z.input<
  typeof MediaStartBeatAnalysisJobRequestSchema
>

export const MediaStartSyncFeaturesAnalysisJobRequestSchema = z.strictObject({
  analysis: z.literal('sync-features'),
  referenceHandleId: MediaHandleIdSchema,
  targetHandleId: MediaHandleIdSchema,
  seed: z.number().int().min(0).max(0x7fffffff),
  samplePeriodMicros: z.number().int().min(20_000).max(1_000_000).default(100_000),
  maximumDurationMicros: z
    .number()
    .int()
    .min(200_000)
    .max(600_000_000)
    .default(600_000_000),
  maxFeaturePoints: z.number().int().min(8).max(4_096).default(4_096),
  idempotencyKey: AudioAnalysisIdempotencyKeySchema,
  metadata: JsonObjectSchema.optional()
}).refine((value) => value.referenceHandleId !== value.targetHandleId, {
  path: ['targetHandleId'],
  message: 'Audio synchronization requires two different media handles'
})
export type MediaStartSyncFeaturesAnalysisJobRequest = z.input<
  typeof MediaStartSyncFeaturesAnalysisJobRequestSchema
>

export const MediaStartAudioAnalysisJobRequestSchema = z.discriminatedUnion('analysis', [
  MediaStartSilenceAnalysisJobRequestSchema,
  MediaStartBeatAnalysisJobRequestSchema,
  MediaStartSyncFeaturesAnalysisJobRequestSchema
])
export type MediaStartAudioAnalysisJobRequest = z.input<
  typeof MediaStartAudioAnalysisJobRequestSchema
>
export type ParsedMediaStartAudioAnalysisJobRequest = z.infer<
  typeof MediaStartAudioAnalysisJobRequestSchema
>

export const MediaStartAudioAnalysisJobResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('started'), job: JobReferenceSchema }),
  z.strictObject({
    outcome: z.literal('unavailable'),
    analysis: MediaAudioAnalysisKindSchema,
    code: MediaAudioAnalysisUnavailableCodeSchema,
    remediation: z.string().min(1).max(1024),
    retryable: z.boolean(),
    local: z.literal(true),
    networkUsed: z.literal(false)
  })
])
export type MediaStartAudioAnalysisJobResult = z.infer<
  typeof MediaStartAudioAnalysisJobResultSchema
>

const AudioAnalysisSourceSchema = z.strictObject({
  handleId: MediaHandleIdSchema,
  fingerprint: z.string().length(64).regex(/^[a-f0-9]{64}$/),
  fingerprintAlgorithm: z.literal('sha256-file-identity-v1')
})

const AudioAnalysisProvenanceSchema = z.strictObject({
  algorithm: z.string().min(1).max(128),
  algorithmVersion: z.string().min(1).max(64),
  local: z.literal(true),
  networkUsed: z.literal(false)
})

export const MediaSilenceAnalysisResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  analysis: z.literal('silence'),
  source: AudioAnalysisSourceSchema,
  provenance: AudioAnalysisProvenanceSchema,
  parameters: z.strictObject({
    noiseThresholdDb: z.number().finite().min(-100).max(-1),
    minimumSilenceMicros: z.number().int().min(20_000).max(60_000_000)
  }),
  intervals: z.array(z.strictObject({
    startMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    endMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    confidence: z.literal(1),
    confidenceSemantics: z.literal('threshold-classification')
  }).refine((interval) => interval.endMicros > interval.startMicros, {
    message: 'Silence interval end must be after start'
  })).max(2_048),
  analyzedDurationMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  truncated: z.boolean()
})
export type MediaSilenceAnalysisResult = z.infer<typeof MediaSilenceAnalysisResultSchema>

export const MediaBeatAnalysisResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  analysis: z.literal('beat-grid'),
  source: AudioAnalysisSourceSchema,
  provenance: AudioAnalysisProvenanceSchema,
  tempoBpm: z.number().finite().min(20).max(400).optional(),
  markers: z.array(z.strictObject({
    timeMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    kind: z.enum(['beat', 'downbeat']),
    confidence: z.number().finite().min(0).max(1),
    strength: z.number().finite().min(0).max(1)
  })).max(4_096),
  analyzedDurationMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  truncated: z.boolean()
})
export type MediaBeatAnalysisResult = z.infer<typeof MediaBeatAnalysisResultSchema>

const SyncFeatureSeriesSchema = z.array(z.number().finite().min(-1).max(1)).min(8).max(4_096)

export const MediaSyncFeaturesAnalysisResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  analysis: z.literal('sync-features'),
  reference: AudioAnalysisSourceSchema,
  target: AudioAnalysisSourceSchema,
  provenance: AudioAnalysisProvenanceSchema,
  seed: z.number().int().min(0).max(0x7fffffff),
  samplePeriodMicros: z.number().int().min(20_000).max(1_000_000),
  referenceFeatures: SyncFeatureSeriesSchema,
  targetFeatures: SyncFeatureSeriesSchema,
  referenceAnalyzedDurationMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  targetAnalyzedDurationMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  truncated: z.boolean()
})
export type MediaSyncFeaturesAnalysisResult = z.infer<
  typeof MediaSyncFeaturesAnalysisResultSchema
>

export const MediaAudioAnalysisResultSchema = z.discriminatedUnion('analysis', [
  MediaSilenceAnalysisResultSchema,
  MediaBeatAnalysisResultSchema,
  MediaSyncFeaturesAnalysisResultSchema
])
export type MediaAudioAnalysisResult = z.infer<typeof MediaAudioAnalysisResultSchema>
