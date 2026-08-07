import type { ReactElement } from 'react'
import type {
  KunLabSettingsPatchV1,
  KunLabSettingsV1,
  ModelReasoningEffort,
  ModelProviderProfileV1
} from '@shared/app-settings'
import {
  MODEL_REASONING_EFFORTS,
  modelProviderModelProfile
} from '@shared/app-settings'
import {
  InlineNoticeView,
  ModelSelect,
  SettingsCard,
  SettingRow,
  Toggle
} from './settings-controls'
import { composerSupportsCodexFastMode } from './chat/composer-fast-mode'
import { useChatStore } from '../store/chat-store'

type Translate = (key: string) => string

const REASONING_EFFORT_LABEL_KEYS: Record<ModelReasoningEffort, string> = {
  auto: 'graphSettingsReasoningAuto',
  off: 'graphSettingsReasoningOff',
  low: 'graphSettingsReasoningLow',
  medium: 'graphSettingsReasoningMedium',
  high: 'graphSettingsReasoningHigh',
  max: 'graphSettingsReasoningMax'
}

function reasoningEffortsForModel(
  provider: ModelProviderProfileV1 | undefined,
  model: string
): ModelReasoningEffort[] {
  if (!provider) return [...MODEL_REASONING_EFFORTS]
  const supported = modelProviderModelProfile(provider, model)?.reasoning?.supportedEfforts
  return supported && supported.length > 0
    ? supported
    : [...MODEL_REASONING_EFFORTS]
}

function compatibleReasoningEffort(
  provider: ModelProviderProfileV1 | undefined,
  model: string,
  current: ModelReasoningEffort | undefined
): ModelReasoningEffort | undefined {
  if (!current || !provider) return current
  const reasoning = modelProviderModelProfile(provider, model)?.reasoning
  if (!reasoning || reasoning.supportedEfforts.includes(current)) return current
  return reasoning.defaultEffort
}

/**
 * Lab → 探索代理 panel. Configures the first-class `explore_agent` tool:
 * a master switch plus an optional model/provider/reasoning/fast override.
 * Empty model + providerId means "follow the main session model".
 */
export function ExploreAgentSettingsPanel({
  t,
  value,
  modelProviders,
  leadProviderId,
  leadModel,
  selectControlClass,
  onChange
}: {
  t: Translate
  value: KunLabSettingsV1
  modelProviders: ModelProviderProfileV1[]
  leadProviderId: string
  leadModel: string
  selectControlClass: string
  onChange: (patch: KunLabSettingsPatchV1) => void
}): ReactElement {
  const agent = value.exploreAgent
  const fixed = Boolean(agent.model?.trim() && agent.providerId?.trim())
  const providerId = fixed ? agent.providerId : leadProviderId
  const provider = modelProviders.find((candidate) => candidate.id === providerId) ?? modelProviders[0]
  const model = fixed ? agent.model : leadModel
  const reasoningEfforts = reasoningEffortsForModel(provider, model)
  const composerModelGroups = useChatStore((s) => s.composerModelGroups)
  const fastSupported = composerSupportsCodexFastMode(composerModelGroups, model, providerId)

  return (
    <div className="mt-6">
      <SettingsCard title={t('labExploreTitle')}>
        <div className="space-y-3 px-3 py-4">
          <InlineNoticeView notice={{ tone: 'info', message: t('labExploreDescription') }} />
        </div>
        <SettingRow
          title={t('labExploreEnabled')}
          description={t('labExploreEnabledDesc')}
          control={
            <Toggle
              checked={agent.enabled}
              onChange={(enabled) => onChange({ exploreAgent: { enabled } })}
            />
          }
        />
        {agent.enabled ? (
          <>
            <SettingRow
              title={t('labExploreModelMode')}
              description={t('labExploreModelModeDesc')}
              control={
                <select
                  className={selectControlClass}
                  value={fixed ? 'fixed' : 'inherit'}
                  onChange={(event) => {
                    if (event.target.value === 'inherit') {
                      onChange({
                        exploreAgent: {
                          model: '',
                          providerId: '',
                          reasoningEffort: undefined,
                          fast: false
                        }
                      })
                      return
                    }
                    const providerId = provider?.id || leadProviderId
                    const model = (provider?.models ?? []).includes(leadModel)
                      ? leadModel
                      : provider?.models?.[0] ?? leadModel
                    onChange({
                      exploreAgent: {
                        model,
                        providerId,
                        reasoningEffort: undefined,
                        fast: false
                      }
                    })
                  }}
                >
                  <option value="inherit">{t('labExploreModelModeInherit')}</option>
                  <option value="fixed">{t('labExploreModelModeFixed')}</option>
                </select>
              }
            />
            {fixed ? (
              <SettingRow
                title={t('labExploreModel')}
                description={t('labExploreModelDesc')}
                wideControl
                control={
                  <div className="grid gap-3 sm:grid-cols-2">
                    <select
                      aria-label={t('labExploreProvider')}
                      className={selectControlClass}
                      value={provider?.id ?? providerId}
                      onChange={(event) => {
                        const nextProviderId = event.target.value
                        const nextProvider = modelProviders.find((item) => item.id === nextProviderId)
                        const nextModel = nextProvider?.models?.includes(model)
                          ? model
                          : nextProvider?.models?.[0] ?? model
                        onChange({
                          exploreAgent: {
                            model: nextModel,
                            providerId: nextProviderId,
                            reasoningEffort: compatibleReasoningEffort(
                              nextProvider,
                              nextModel,
                              agent.reasoningEffort
                            )
                          }
                        })
                      }}
                    >
                      {modelProviders.map((item) => (
                        <option key={item.id} value={item.id}>{item.name}</option>
                      ))}
                    </select>
                    <ModelSelect
                      value={model}
                      options={provider?.models ?? []}
                      allowCustom
                      customLabel={t('modelSelectCustomOption')}
                      customPlaceholder={t('modelSelectCustomPlaceholder')}
                      selectClassName={selectControlClass}
                      onChange={(nextModel) => {
                        const trimmed = nextModel.trim()
                        onChange({
                          exploreAgent: {
                            model: trimmed || model,
                            providerId: provider?.id ?? providerId,
                            reasoningEffort: compatibleReasoningEffort(
                              provider,
                              trimmed || model,
                              agent.reasoningEffort
                            )
                          }
                        })
                      }}
                    />
                  </div>
                }
              />
            ) : null}
            {fixed ? (
              <SettingRow
                title={t('labExploreReasoning')}
                description={t('labExploreReasoningDesc')}
                control={
                  <select
                    aria-label={t('labExploreReasoning')}
                    className={selectControlClass}
                    value={agent.reasoningEffort ?? ''}
                    onChange={(event) => onChange({
                      exploreAgent: {
                        reasoningEffort: event.target.value
                          ? event.target.value as ModelReasoningEffort
                          : undefined
                      }
                    })}
                  >
                    <option value="">{t('labExploreReasoningInherit')}</option>
                    {reasoningEfforts.map((effort) => (
                      <option key={effort} value={effort}>
                        {t(REASONING_EFFORT_LABEL_KEYS[effort])}
                      </option>
                    ))}
                  </select>
                }
              />
            ) : null}
            {fixed ? (
              <SettingRow
                title={t('labExploreFast')}
                description={t('labExploreFastDesc')}
                control={
                  <Toggle
                    checked={agent.fast === true && fastSupported}
                    disabled={!fastSupported}
                    onChange={(fast) => onChange({ exploreAgent: { fast } })}
                  />
                }
              />
            ) : null}
            {fixed && !fastSupported ? (
              <div className="px-3 pb-3">
                <p className="text-[12px] leading-5 text-ds-faint">
                  {t('labExploreFastUnsupportedHint')}
                </p>
              </div>
            ) : null}
          </>
        ) : null}
      </SettingsCard>
    </div>
  )
}
