import {
  MAX_MODEL_CONTEXT_WINDOW_TOKENS,
  MAX_MODEL_OUTPUT_TOKENS,
  type AppSettingsV1
} from '@shared/app-settings'

export type SettingsSaveIssue = {
  kind: 'provider-model-limit'
  rawMessage: string
  providerId: string
  providerName: string
  modelId: string
  field: 'contextWindowTokens' | 'maxOutputTokens'
  actualValue: number
  maxAllowed: number
}

type Translate = (key: string, params?: Record<string, unknown>) => string

export function settingsSaveIssueMessage(issue: SettingsSaveIssue, t: Translate): string {
  return t('providerModelSaveLimitError', {
    provider: issue.providerName,
    model: issue.modelId,
    field: t(issue.field === 'maxOutputTokens'
      ? 'providerModelFieldMaxOutput'
      : 'providerModelFieldContextWindow'),
    value: issue.actualValue.toLocaleString(),
    max: issue.maxAllowed.toLocaleString()
  })
}

export function parseSettingsSaveIssue(
  message: string,
  snapshot: AppSettingsV1
): SettingsSaveIssue | null {
  const match = message.match(
    /provider\.providers\.(\d+)\.modelProfiles\.(.+?)\.(contextWindowTokens|maxOutputTokens):[^\n]*?(?:<=|less than or equal to\s*)(\d+)/iu
  )
  if (!match) return null
  const provider = snapshot.provider.providers[Number(match[1])]
  const modelId = match[2]?.trim()
  const field = match[3] as SettingsSaveIssue['field'] | undefined
  if (!provider || !modelId || !field) return null
  const profile = provider.modelProfiles[modelId] ??
    provider.modelProfiles[modelId.toLowerCase()]
  const actualValue = profile?.[field]
  if (typeof actualValue !== 'number') return null
  const parsedMaximum = Number(match[4])
  const maxAllowed = Number.isSafeInteger(parsedMaximum)
    ? parsedMaximum
    : field === 'maxOutputTokens'
      ? MAX_MODEL_OUTPUT_TOKENS
      : MAX_MODEL_CONTEXT_WINDOW_TOKENS
  return {
    kind: 'provider-model-limit',
    rawMessage: message,
    providerId: provider.id,
    providerName: provider.name,
    modelId,
    field,
    actualValue,
    maxAllowed
  }
}
