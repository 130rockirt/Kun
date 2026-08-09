import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Play, X } from 'lucide-react'
import type { WorkflowInputFieldV1, WorkflowV1 } from '@shared/app-settings'

export function WorkflowToggle({
  on,
  onClick,
  label,
  title,
  icon,
  disabled = false
}: {
  on: boolean
  onClick: () => void
  label: string
  title?: string
  icon: ReactElement
  disabled?: boolean
}): ReactElement {
  const active = on && !disabled
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={`inline-flex items-center gap-2 rounded-lg px-2 py-1 transition ${
        disabled ? 'cursor-not-allowed opacity-45' : 'hover:bg-ds-hover'
      }`}
    >
      <span
        className={`flex h-[18px] w-8 shrink-0 items-center rounded-full p-0.5 transition-colors ${
          active ? 'bg-accent' : 'bg-ds-border'
        }`}
      >
        <span
          className={`h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-transform ${
            on ? 'translate-x-[14px]' : 'translate-x-0'
          }`}
        />
      </span>
      <span className={`flex items-center gap-1 text-[12.5px] font-medium ${active ? 'text-ds-ink' : 'text-ds-muted'}`}>
        {icon}
        {label}
      </span>
    </button>
  )
}

const RUN_INPUT_FIELD =
  'w-full rounded-lg border border-ds-border bg-ds-card px-3 py-2 text-[13px] text-ds-ink outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/25'

/** Generated form that collects a manual trigger's typed inputs before a one-off run. */
export function RunInputDialog({
  workflow,
  onRun,
  onClose
}: {
  workflow: WorkflowV1
  onRun: (input: Record<string, unknown>) => void
  onClose: () => void
}): ReactElement {
  const { t } = useTranslation('common')
  const trigger = workflow.nodes.find((node) => node.type === 'manual-trigger')
  const schema: WorkflowInputFieldV1[] = trigger && trigger.type === 'manual-trigger' ? trigger.config.inputSchema ?? [] : []
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {}
    for (const field of schema) initial[field.key] = field.type === 'boolean' ? field.defaultValue === 'true' : field.defaultValue
    return initial
  })
  const set = (key: string, value: unknown): void => setValues((prev) => ({ ...prev, [key]: value }))
  const missing = schema.some((field) => {
    if (!field.required) return false
    const value = values[field.key]
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
  })

  return (
    <div className="ds-no-drag fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[460px] flex-col overflow-hidden rounded-2xl border border-ds-border bg-ds-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-ds-border px-5 py-3.5">
          <span className="text-[14px] font-semibold text-ds-ink">{t('workflowRunWithInputs')}</span>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
          {schema.map((field) => (
            <label key={field.key} className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-ds-muted">
                {field.label.trim() || field.key}
                {field.required ? <span className="ml-1 text-red-500">*</span> : null}
              </span>
              {field.description ? <span className="text-[11px] text-ds-faint">{field.description}</span> : null}
              {field.type === 'boolean' ? (
                <input
                  type="checkbox"
                  className="h-4 w-4 self-start"
                  checked={Boolean(values[field.key])}
                  onChange={(event) => set(field.key, event.target.checked)}
                />
              ) : field.type === 'paragraph' || field.type === 'json' ? (
                <textarea
                  className={`${RUN_INPUT_FIELD} min-h-[80px] resize-y ${field.type === 'json' ? 'font-mono text-[12px]' : ''}`}
                  value={String(values[field.key] ?? '')}
                  onChange={(event) => set(field.key, event.target.value)}
                />
              ) : field.type === 'select' ? (
                <select
                  className={RUN_INPUT_FIELD}
                  value={String(values[field.key] ?? '')}
                  onChange={(event) => set(field.key, event.target.value)}
                >
                  <option value="" />
                  {field.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={field.type === 'number' ? 'number' : 'text'}
                  className={RUN_INPUT_FIELD}
                  value={String(values[field.key] ?? '')}
                  onChange={(event) => set(field.key, event.target.value)}
                />
              )}
            </label>
          ))}
        </div>
        <footer className="flex justify-end gap-2 border-t border-ds-border px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center rounded-xl border border-ds-border bg-ds-card px-4 py-2 text-[13px] font-medium text-ds-muted transition hover:bg-ds-hover"
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            disabled={missing}
            onClick={() => onRun(values)}
            className="inline-flex items-center gap-2 rounded-xl bg-ds-userbubble px-4 py-2 text-[13px] font-semibold text-ds-userbubbleFg shadow-sm transition hover:opacity-90 disabled:opacity-50"
          >
            <Play className="h-4 w-4" strokeWidth={2} />
            {t('workflowRunNow')}
          </button>
        </footer>
      </div>
    </div>
  )
}
