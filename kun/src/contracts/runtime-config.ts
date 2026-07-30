import { z } from 'zod'
import {
  ContextCompactionConfigSchema,
  GraphRuntimeConfigSchema,
  KunServeConfigSchema,
  ModelConfigSchema,
  QualityConfigSchema,
  RolesConfigSchema,
  RuntimeTuningConfigSchema,
  TokenEconomyConfigSchema
} from '../config/kun-config.js'
import { KunCapabilitiesConfig } from './capabilities.js'
import { HooksConfigSchema } from '../hooks/hook-config.js'

const RuntimeConfigApplyServeConfig = KunServeConfigSchema.omit({
  host: true,
  port: true,
  dataDir: true,
  runtimeToken: true,
  insecure: true,
  storage: true
}).extend({
  tokenEconomy: TokenEconomyConfigSchema.optional()
})

export const RuntimeConfigModelSelection = z.object({
  providerId: z.string().min(1).max(128),
  accountId: z.string().min(1).max(128).optional(),
  model: z.string().min(1).max(512)
}).strict()

export const RuntimeConfigApplyRequest = z
  .object({
    serve: RuntimeConfigApplyServeConfig.optional(),
    models: ModelConfigSchema.optional(),
    modelSelection: RuntimeConfigModelSelection.optional(),
    contextCompaction: ContextCompactionConfigSchema.optional(),
    runtime: RuntimeTuningConfigSchema.optional(),
    graph: GraphRuntimeConfigSchema.optional(),
    roles: RolesConfigSchema.optional(),
    capabilities: KunCapabilitiesConfig.optional(),
    hooks: HooksConfigSchema.optional(),
    quality: QualityConfigSchema.optional()
  })
  .strict()

export const RuntimeConfigApplyResponse = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(['restart_required', 'invalid_config']),
      message: z.string()
    })
    .strict()
])

export type RuntimeConfigApplyRequest = z.infer<typeof RuntimeConfigApplyRequest>
export type RuntimeConfigApplyResponse = z.infer<typeof RuntimeConfigApplyResponse>
