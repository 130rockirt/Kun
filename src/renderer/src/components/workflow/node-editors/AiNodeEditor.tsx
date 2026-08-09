import type { ReactElement, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  SCHEDULE_REASONING_EFFORT_IDS,
  type AppSettingsV1,
  type WorkflowNodeV1
} from '@shared/app-settings'
import { getModelProviderSettings } from '@shared/app-settings-provider-core'
import { ModelPicker } from '../ModelPicker'

const INPUT_CLASS = 'w-full rounded-lg border border-ds-border bg-ds-card px-3 py-2 text-[13px] text-ds-ink outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/25'
type AiNode = Extract<WorkflowNodeV1, { type: 'ai-agent' | 'generate-image' }>
function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return <label className="flex flex-col gap-1.5"><span className="text-[12px] font-medium text-ds-muted">{label}</span>{children}</label>
}

export function AiNodeEditor({ node, settings, onChange }: {
  node: AiNode
  settings: AppSettingsV1
  onChange: (node: WorkflowNodeV1) => void
}): ReactElement {
  const { t } = useTranslation('common')
  const providers = getModelProviderSettings(settings).providers
  if (node.type === 'ai-agent') return <>
    <Field label={t('workflowPrompt')}><textarea className={`${INPUT_CLASS} min-h-[120px] resize-y`} value={node.config.prompt}
      placeholder={t('workflowPromptPlaceholder', { token: '{{text}}' })}
      onChange={(event) => onChange({ ...node, config: { ...node.config, prompt: event.target.value } })} />
      <span className="mt-1 text-[11px] leading-4 text-ds-faint">{t('workflowPromptUpstreamHint')}</span></Field>
    <ModelPicker providers={providers} providerId={node.config.providerId} model={node.config.model}
      onChange={({ providerId, model }) => onChange({ ...node, config: { ...node.config, providerId, model } })}
      emptyHint={t('workflowModelEmptyHint')} />
    <Field label={t('scheduleReasoning')}><select className={INPUT_CLASS} value={node.config.reasoningEffort}
      onChange={(event) => onChange({ ...node, config: { ...node.config, reasoningEffort: event.target.value as typeof node.config.reasoningEffort } })}>
      {SCHEDULE_REASONING_EFFORT_IDS.map((effort) => <option key={effort} value={effort}>{t(`scheduleReasoning_${effort}`)}</option>)}
    </select></Field>
  </>
  return <>
    <Field label={t('workflowImagePrompt')}><textarea className={`${INPUT_CLASS} min-h-[100px] resize-y`} value={node.config.prompt}
      placeholder={t('workflowImagePromptPlaceholder', { token: '{{text}}' })}
      onChange={(event) => onChange({ ...node, config: { ...node.config, prompt: event.target.value } })} /></Field>
    <ModelPicker providers={providers} providerId={node.config.providerId} model={node.config.model}
      onChange={({ providerId, model }) => onChange({ ...node, config: { ...node.config, providerId, model } })}
      providerFilter={(provider) => Boolean(provider.image)} modelsOf={(provider) => provider.image?.models ?? []}
      modelLabel={t('workflowImageModel')} />
    <Field label={t('workflowImageSize')}><input className={INPUT_CLASS} value={node.config.size} placeholder="1024x1024"
      onChange={(event) => onChange({ ...node, config: { ...node.config, size: event.target.value } })} /></Field>
    <Field label={t('workflowImageOutputDir')}><input className={INPUT_CLASS} value={node.config.outputDir}
      placeholder={t('workflowImageOutputDirPlaceholder')}
      onChange={(event) => onChange({ ...node, config: { ...node.config, outputDir: event.target.value } })} /></Field>
    <p className="text-[11.5px] leading-5 text-ds-faint">{t('workflowImageHint')}</p>
  </>
}
