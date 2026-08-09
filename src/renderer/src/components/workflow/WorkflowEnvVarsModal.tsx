import { useState, type ReactElement } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { WorkflowEnvVarV1 } from '@shared/app-settings'

const ENV_VAR_TYPES: WorkflowEnvVarV1['type'][] = ['string', 'number', 'boolean', 'secret']

/** Workflow-scoped env vars, referenced from any node via {{$env.key}}. Secrets are redacted from run history. */
export function EnvVarsModal({
  env,
  onChange,
  onClose
}: {
  env: WorkflowEnvVarV1[]
  onChange: (next: WorkflowEnvVarV1[]) => void
  onClose: () => void
}): ReactElement {
  const { t } = useTranslation('common')
  const inputClass =
    'w-full rounded-lg border border-ds-border bg-ds-card px-2.5 py-1.5 text-[13px] text-ds-ink outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/25'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[560px] flex-col overflow-hidden rounded-2xl border border-ds-border bg-ds-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-ds-border px-5 py-3.5">
          <div className="flex flex-col">
            <span className="text-[14px] font-semibold text-ds-ink">{t('workflowEnvVars')}</span>
            <span className="text-[11.5px] text-ds-faint">{t('workflowEnvVarsHint')}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-5 py-4">
          {env.length === 0 ? (
            <p className="py-6 text-center text-[12.5px] text-ds-faint">{t('workflowEnvEmpty')}</p>
          ) : (
            env.map((item, index) => {
              const update = (patch: Partial<WorkflowEnvVarV1>): void =>
                onChange(env.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)))
              return (
                <div key={index} className="flex items-center gap-2">
                  <input
                    className={`${inputClass} w-40 shrink-0 font-mono`}
                    value={item.key}
                    placeholder={t('workflowEnvKey')}
                    onChange={(event) => update({ key: event.target.value })}
                  />
                  <select
                    className={`${inputClass} w-24 shrink-0`}
                    value={item.type}
                    onChange={(event) => update({ type: event.target.value as WorkflowEnvVarV1['type'] })}
                  >
                    {ENV_VAR_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {t(`workflowEnvType_${type}`)}
                      </option>
                    ))}
                  </select>
                  <input
                    className={inputClass}
                    type={item.type === 'secret' ? 'password' : 'text'}
                    value={item.value}
                    placeholder={t('workflowEnvValue')}
                    onChange={(event) => update({ value: event.target.value })}
                  />
                  <button
                    type="button"
                    onClick={() => onChange(env.filter((_, i) => i !== index))}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ds-faint transition hover:bg-red-500/10 hover:text-red-600"
                    aria-label={t('workflowEnvRemove')}
                  >
                    <X className="h-3.5 w-3.5" strokeWidth={2} />
                  </button>
                </div>
              )
            })
          )}
          <button
            type="button"
            onClick={() => onChange([...env, { key: `KEY_${env.length + 1}`, value: '', type: 'string' }])}
            className="mt-1 inline-flex items-center gap-1.5 self-start rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-accent transition hover:bg-accent/10"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} />
            {t('workflowEnvAdd')}
          </button>
        </div>
      </div>
    </div>
  )
}
