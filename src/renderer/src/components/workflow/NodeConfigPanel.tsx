import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Braces, FlaskConical, Loader2, Star, Trash2, X } from 'lucide-react'
import { ModelPicker } from './ModelPicker'
import { TriggerNodeEditor } from './node-editors/TriggerNodeEditor'
import { AiNodeEditor } from './node-editors/AiNodeEditor'
import { LogicAndHttpNodeEditor } from './node-editors/LogicAndHttpNodeEditor'
import { CodeNodeEditor } from './node-editors/CodeNodeEditor'
import { NestedNodeEditor } from './node-editors/NestedNodeEditor'
import { isTransformNode, TransformNodeEditor } from './node-editors/TransformNodeEditor'
import { ExtractionNodeEditor } from './node-editors/ExtractionNodeEditor'
import { ApprovalNodeEditor } from './node-editors/ApprovalNodeEditor'
import {
  CustomNodeEditor as CustomNodeForm,
  InputFieldsEditor,
  NODE_INPUT_CLASS as INPUT_CLASS,
  NodeEditorField as Field
} from './node-editors/NodeEditorPrimitives'
import {
  SCHEDULE_REASONING_EFFORT_IDS,
  type AppSettingsV1,
  type WorkflowCodeCheckResult,
  type WorkflowNodeErrorMode,
  type WorkflowNodeRunResultV1,
  type WorkflowNodeV1
} from '@shared/app-settings'
import { getModelProviderSettings } from '@shared/app-settings-provider-core'

/** A reachable upstream node, carrying the full node so the picker can derive its typed outputs. */
import {
  InputBindingsEditor,
  VariablePicker,
  collectDanglingRefs,
  type UpstreamNode
} from './WorkflowInputBindingsEditor'

type Props = {
  node: WorkflowNodeV1 | null
  settings: AppSettingsV1
  lastResult?: WorkflowNodeRunResultV1 | null
  onChange: (node: WorkflowNodeV1) => void
  onDelete: (nodeId: string) => void
  /** Save the current node as a reusable palette preset. */
  onSavePreset?: (node: WorkflowNodeV1, label: string) => void
  /** Current workflow name, used to render the local HTTP invocation example on the trigger. */
  workflowName?: string
  /** Upstream nodes reachable from this one, for the {{$nodes.*}} variable picker. */
  upstreamNodes?: UpstreamNode[]
  /** Id of the workflow this node belongs to, for single-node testing. */
  workflowId?: string
  /** Persist the graph before a single-node test (so the test sees the latest config). */
  onBeforeTest?: () => Promise<void>
}


export function NodeConfigPanel({
  node,
  settings,
  lastResult,
  onChange,
  onDelete,
  onSavePreset,
  workflowName,
  upstreamNodes = [],
  workflowId,
  onBeforeTest
}: Props): ReactElement {
  const { t } = useTranslation('common')

  const [presetLabel, setPresetLabel] = useState('')
  const [presetSaved, setPresetSaved] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [testOpen, setTestOpen] = useState(false)
  // Tracks the most recently focused text field so the variable picker can splice a token at its caret.
  const lastFocused = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  // Drop the focus target when the selected node changes (the panel instance is reused).
  useEffect(() => {
    lastFocused.current = null
  }, [node?.id])

  const insertToken = (token: string): void => {
    setPickerOpen(false)
    // Prefer the last-focused field; otherwise fall back to the node's primary text
    // field (the first textarea, else the first text input) so a pick is never a no-op.
    let el = lastFocused.current
    if (!el || !el.isConnected) {
      el =
        panelRef.current?.querySelector<HTMLTextAreaElement>('textarea') ??
        panelRef.current?.querySelector<HTMLInputElement>('input[type="text"]') ??
        null
    }
    if (!el) return
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? el.value.length
    const next = `${el.value.slice(0, start)}${token}${el.value.slice(end)}`
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    setter?.call(el, next)
    // Fire a native input event so the field's React onChange writes it back into config.
    el.dispatchEvent(new Event('input', { bubbles: true }))
    const caret = start + token.length
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(caret, caret)
    })
  }
  // Debounced editor-time syntax check for the Code node (runs in the main process).
  const [codeCheck, setCodeCheck] = useState<WorkflowCodeCheckResult | null>(null)
  const codeValue = node && node.type === 'code' ? node.config.code : ''
  const codeLanguage = node && node.type === 'code' ? node.config.language : 'javascript'
  useEffect(() => {
    if (node?.type !== 'code' || !codeValue.trim()) {
      setCodeCheck(null)
      return
    }
    let cancelled = false
    const handle = setTimeout(() => {
      window.kunGui
        .checkWorkflowCode(codeLanguage, codeValue)
        .then((result) => {
          if (!cancelled) setCodeCheck(result)
        })
        .catch(() => {
          if (!cancelled) setCodeCheck(null)
        })
    }, 500)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [node?.type, codeValue, codeLanguage])

  if (!node) {
    return (
      <div className="workflow-node-config-empty flex h-full items-center justify-center px-6 text-center text-[13px] text-ds-faint">
        {t('workflowNoSelection')}
      </div>
    )
  }

  const providers = getModelProviderSettings(settings).providers
  const danglingRefs = collectDanglingRefs(node, upstreamNodes)

  return (
    <div ref={panelRef} className="workflow-node-config-panel flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-ds-border px-4 py-3">
        <h2 className="text-[13px] font-semibold text-ds-ink">
          {t(`workflowNode_${node.type}`)}
        </h2>
        <div className="flex items-center gap-1.5">
          {!node.type.endsWith('-trigger') && workflowId ? (
            <button
              type="button"
              onClick={() => setTestOpen(true)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-ds-border text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
              title={t('workflowTestNode')}
              aria-label={t('workflowTestNode')}
            >
              <FlaskConical className="h-4 w-4" strokeWidth={1.8} />
            </button>
          ) : null}
          {!node.type.endsWith('-trigger') ? (
            <div className="relative">
              <button
                type="button"
                onClick={() => setPickerOpen((open) => !open)}
                className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition ${
                  pickerOpen
                    ? 'border-accent/40 bg-accent/10 text-accent'
                    : 'border-ds-border text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
                }`}
                title={t('workflowVarPicker')}
                aria-label={t('workflowVarPicker')}
              >
                <Braces className="h-4 w-4" strokeWidth={1.8} />
              </button>
              {pickerOpen ? (
                <VariablePicker upstreamNodes={upstreamNodes} onInsert={insertToken} onClose={() => setPickerOpen(false)} />
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => onDelete(node.id)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-ds-border text-ds-muted transition hover:bg-red-500/10 hover:text-red-600"
            title={t('workflowDeleteNode')}
            aria-label={t('workflowDeleteNode')}
          >
            <Trash2 className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>
      </div>

      <div
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4"
        onFocusCapture={(event) => {
          const target = event.target
          if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
            lastFocused.current = target
          }
        }}
      >
        <Field label={t('workflowNodeName')}>
          <input
            className={INPUT_CLASS}
            value={node.name}
            placeholder={t(`workflowNode_${node.type}`)}
            onChange={(event) => onChange({ ...node, name: event.target.value })}
          />
        </Field>

        {danglingRefs.length > 0 ? (
          <div className="flex flex-col gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2">
            <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-amber-600">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
              {t('workflowDanglingTitle')}
            </div>
            {danglingRefs.map((ref, index) => (
              <div key={index} className="flex items-center justify-between gap-2 text-[11px]">
                <code className="min-w-0 truncate font-mono text-amber-700/90 dark:text-amber-300/90">{ref.token}</code>
                <span className="shrink-0 text-ds-faint">
                  {t(ref.reason === 'node' ? 'workflowDanglingNode' : 'workflowDanglingField')}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {!node.type.endsWith('-trigger') ? (
          <InputBindingsEditor key={node.id} node={node} upstreamNodes={upstreamNodes} onChange={onChange} />
        ) : null}

        {node.type === 'manual-trigger' || node.type === 'schedule-trigger' || node.type === 'webhook-trigger' ? (
          <TriggerNodeEditor
            node={node}
            settings={settings}
            workflowName={workflowName}
            inputSchemaEditor={node.type === 'manual-trigger' ? (
              <div className="flex flex-col gap-2 border-t border-ds-border pt-3">
                <InputFieldsEditor
                  fields={node.config.inputSchema ?? []}
                  onChange={(next) => onChange({ ...node, config: { ...node.config, inputSchema: next } })}
                />
              </div>
            ) : undefined}
            onChange={onChange}
          />
        ) : null}

        {node.type === 'ai-agent' || node.type === 'generate-image' ? (
          <AiNodeEditor node={node} settings={settings} onChange={onChange} />
        ) : null}

        {node.type === 'condition' ? (
          <LogicAndHttpNodeEditor node={node} onChange={onChange} />
        ) : null}

        {node.type === 'set-fields' ? (
          <LogicAndHttpNodeEditor node={node} onChange={onChange} />
        ) : null}

        {node.type === 'http-request' ? (
          <LogicAndHttpNodeEditor node={node} onChange={onChange} />
        ) : null}

        {node.type === 'switch' ? (
          <LogicAndHttpNodeEditor node={node} onChange={onChange} />
        ) : null}

        {node.type === 'code' ? (
          <CodeNodeEditor node={node} codeCheck={codeCheck} onChange={onChange} />
        ) : null}

        {node.type === 'subworkflow' ? (
          <NestedNodeEditor node={node} settings={settings} onChange={onChange} />
        ) : null}

        {node.type === 'loop' ? (
          <NestedNodeEditor node={node} settings={settings} onChange={onChange} />
        ) : null}

        {isTransformNode(node) ? (
          <TransformNodeEditor node={node} onChange={onChange} />
        ) : null}









        {node.type === 'parameter-extractor' ? (
          <ExtractionNodeEditor node={node} providers={providers} onChange={onChange} />
        ) : null}

        {node.type === 'question-classifier' ? (
          <ExtractionNodeEditor node={node} providers={providers} onChange={onChange} />
        ) : null}

        {node.type === 'human-approval' ? (
          <ApprovalNodeEditor node={node} onChange={onChange} />
        ) : null}

        {node.type === 'custom' ? <CustomNodeForm node={node} settings={settings} onChange={onChange} /> : null}

        {!node.type.endsWith('-trigger') ? (
          <div className="flex flex-col gap-2.5 border-t border-ds-border pt-3">
            <span className="text-[12px] font-medium text-ds-muted">{t('workflowErrorHandling')}</span>
            <Field label={t('workflowOnError')}>
              <select
                className={INPUT_CLASS}
                value={node.onError ?? 'fail'}
                onChange={(event) =>
                  onChange({ ...node, onError: event.target.value as WorkflowNodeErrorMode })
                }
              >
                {(['fail', 'continue', 'fallback'] as const).map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`workflowOnError_${mode}`)}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex items-center gap-2">
              <Field label={t('workflowRetries')}>
                <input
                  type="number"
                  min={0}
                  max={10}
                  className={INPUT_CLASS}
                  value={node.retries ?? 0}
                  onChange={(event) =>
                    onChange({ ...node, retries: Math.max(0, Math.min(10, Math.round(Number(event.target.value) || 0))) })
                  }
                />
              </Field>
              <Field label={t('workflowRetryDelay')}>
                <input
                  type="number"
                  min={0}
                  className={INPUT_CLASS}
                  value={node.retryDelayMs ?? 0}
                  onChange={(event) =>
                    onChange({ ...node, retryDelayMs: Math.max(0, Math.round(Number(event.target.value) || 0)) })
                  }
                />
              </Field>
            </div>
            {node.onError === 'fallback' ? (
              <Field label={t('workflowFallbackJson')} hint={t('workflowFallbackJsonHint')}>
                <textarea
                  className={`${INPUT_CLASS} min-h-[60px] resize-y font-mono text-[12px]`}
                  value={node.fallbackJson ?? ''}
                  placeholder='{ "ok": false }'
                  onChange={(event) => onChange({ ...node, fallbackJson: event.target.value })}
                />
              </Field>
            ) : null}
          </div>
        ) : null}

        <label className="mt-2 flex items-center gap-2 text-[13px] text-ds-muted">
          <input
            type="checkbox"
            checked={node.disabled}
            onChange={(event) => onChange({ ...node, disabled: event.target.checked })}
          />
          {t('workflowNodeDisabled')}
        </label>

        {onSavePreset ? (
          <div className="flex flex-col gap-1.5 border-t border-ds-border pt-3">
            <span className="text-[12px] font-medium text-ds-muted">{t('workflowSaveAsPreset')}</span>
            <div className="flex items-center gap-2">
              <input
                className={INPUT_CLASS}
                value={presetLabel}
                placeholder={node.name.trim() || t(`workflowNode_${node.type}`)}
                onChange={(event) => setPresetLabel(event.target.value)}
              />
              <button
                type="button"
                onClick={() => {
                  onSavePreset(node, presetLabel)
                  setPresetLabel('')
                  setPresetSaved(true)
                  window.setTimeout(() => setPresetSaved(false), 1500)
                }}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-ds-border px-3 text-[12.5px] font-medium text-ds-ink transition hover:bg-ds-hover"
              >
                <Star className="h-3.5 w-3.5" strokeWidth={1.8} />
                {t('workflowSaveAsPresetButton')}
              </button>
            </div>
            {presetSaved ? (
              <span className="text-[11.5px] text-emerald-600">{t('workflowPresetSaved')}</span>
            ) : (
              <span className="text-[11px] leading-4 text-ds-faint">{t('workflowSaveAsPresetHint')}</span>
            )}
          </div>
        ) : null}

        {lastResult && (lastResult.message || lastResult.error || lastResult.outputJson) ? (
          <div className="flex flex-col gap-1.5 border-t border-ds-border pt-3">
            <span className="text-[12px] font-medium text-ds-muted">{t('workflowLastOutput')}</span>
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-ds-subtle px-3 py-2 text-[11.5px] leading-5 text-ds-muted">
              {lastResult.error || lastResult.message || lastResult.outputJson}
            </pre>
          </div>
        ) : null}
      </div>

      {testOpen && workflowId ? (
        <TestNodeDialog
          workflowId={workflowId}
          node={node}
          initialMock={lastResult?.inputJson || '{}'}
          onBeforeTest={onBeforeTest}
          onClose={() => setTestOpen(false)}
        />
      ) : null}
    </div>
  )
}

/** Run one node in isolation against a mock upstream payload and show its result. */
function TestNodeDialog({
  workflowId,
  node,
  initialMock,
  onBeforeTest,
  onClose
}: {
  workflowId: string
  node: WorkflowNodeV1
  initialMock: string
  onBeforeTest?: () => Promise<void>
  onClose: () => void
}): ReactElement {
  const { t } = useTranslation('common')
  const [mock, setMock] = useState(initialMock)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<WorkflowNodeRunResultV1 | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (): Promise<void> => {
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      await onBeforeTest?.()
      const response = await window.kunGui.testWorkflowNode(workflowId, node.id, mock)
      if (response.ok) setResult(response.result)
      else setError(response.message)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[520px] flex-col overflow-hidden rounded-2xl border border-ds-border bg-ds-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-ds-border px-5 py-3.5">
          <div className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-ds-muted" strokeWidth={1.8} />
            <span className="text-[14px] font-semibold text-ds-ink">{t('workflowTestNode')}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-ds-muted">{t('workflowTestMock')}</span>
            <span className="text-[11px] text-ds-faint">{t('workflowTestMockHint')}</span>
            <textarea
              className={`${INPUT_CLASS} min-h-[120px] resize-y font-mono text-[12px]`}
              value={mock}
              onChange={(event) => setMock(event.target.value)}
              spellCheck={false}
            />
          </label>
          <button
            type="button"
            onClick={() => void run()}
            disabled={running}
            className="inline-flex items-center justify-center gap-2 self-start rounded-xl bg-ds-userbubble px-4 py-2 text-[13px] font-semibold text-ds-userbubbleFg shadow-sm transition hover:opacity-90 disabled:opacity-60"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} /> : <FlaskConical className="h-4 w-4" strokeWidth={1.9} />}
            {t('workflowTestRun')}
          </button>
          {error ? (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-red-500/10 px-3 py-2 text-[11.5px] leading-5 text-red-600">
              {error}
            </pre>
          ) : null}
          {result ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-[12px]">
                <span
                  className={`h-2 w-2 rounded-full ${result.status === 'error' ? 'bg-red-500' : 'bg-emerald-500'}`}
                />
                <span className="font-medium text-ds-ink">
                  {result.status === 'error' ? t('workflowRunStatus_error') : t('workflowRunStatus_success')}
                </span>
                {result.message ? <span className="truncate text-ds-faint">{result.message}</span> : null}
              </div>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-ds-subtle px-3 py-2 font-mono text-[11.5px] leading-5 text-ds-muted">
                {result.error || result.outputJson || result.message || '—'}
              </pre>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
