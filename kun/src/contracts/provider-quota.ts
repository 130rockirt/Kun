import { z } from 'zod'

export const ProviderQuotaStatusSchema = z.enum([
  'available',
  'unsupported',
  'missing_credentials',
  'error'
])

export const ProviderQuotaMetricSchema = z.object({
  id: z.string().min(1).max(256),
  label: z.string().min(1).max(512),
  unit: z.string().min(1).max(64),
  used: z.number().finite().optional(),
  limit: z.number().finite().optional(),
  remaining: z.number().finite().optional(),
  usedPercent: z.number().finite().min(0).max(100).optional(),
  resetsAt: z.string().datetime().optional()
}).strict()

export const ProviderQuotaEntrySchema = z.object({
  providerId: z.string().min(1).max(128),
  providerName: z.string().min(1).max(120),
  presetId: z.string().min(1).max(128).optional(),
  status: ProviderQuotaStatusSchema,
  source: z.string().min(1).max(256).optional(),
  dashboardUrl: z.string().url().max(2_048).optional(),
  summary: z.string().min(1).max(512).optional(),
  metrics: z.array(ProviderQuotaMetricSchema).max(500),
  updatedAt: z.string().datetime().optional(),
  message: z.string().min(1).max(4_096).optional()
}).strict()

export const ProviderQuotaListResponseSchema = z.object({
  entries: z.array(ProviderQuotaEntrySchema).max(500),
  refreshedAt: z.string().datetime()
}).strict()

export type ProviderQuotaStatus = z.infer<typeof ProviderQuotaStatusSchema>
export type ProviderQuotaMetric = z.infer<typeof ProviderQuotaMetricSchema>
export type ProviderQuotaEntry = z.infer<typeof ProviderQuotaEntrySchema>
export type ProviderQuotaListResponse = z.infer<typeof ProviderQuotaListResponseSchema>
