export const PROVIDER_QUOTA_STATUSES = [
  'available',
  'unsupported',
  'missing_credentials',
  'error'
] as const

export type ProviderQuotaStatus = (typeof PROVIDER_QUOTA_STATUSES)[number]

export type ProviderQuotaMetric = {
  id: string
  label: string
  unit: string
  used?: number
  limit?: number
  remaining?: number
  usedPercent?: number
  resetsAt?: string
}

export type ProviderQuotaEntry = {
  providerId: string
  providerName: string
  presetId?: string
  status: ProviderQuotaStatus
  source?: string
  dashboardUrl?: string
  summary?: string
  metrics: ProviderQuotaMetric[]
  updatedAt?: string
  message?: string
}

export type ProviderQuotaListResult = {
  entries: ProviderQuotaEntry[]
  refreshedAt: string
}
