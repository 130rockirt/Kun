import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react'
import {
  describeNodeOutput,
  extractNodeRefs,
  varTypeToInputType
} from '@shared/workflow-output-descriptors'
import {
  WORKFLOW_NODE_INPUT_TYPES,
  type WorkflowNodeInputType,
  type WorkflowNodeInputV1,
  type WorkflowNodeV1,
  type WorkflowOutputVar,
  type WorkflowVarType
} from '@shared/app-settings'
import { NODE_INPUT_CLASS as INPUT_CLASS } from './node-editors/NodeEditorPrimitives'

export type UpstreamNode = { id: string; name: string; type: WorkflowNodeV1['type']; node: WorkflowNodeV1 }

/** The {{$nodes…}} token that resolves an upstream node's described field (json.<path>) or its raw text. */
function nodeFieldToken(nodeId: string, key: string): string {
  return key === 'text' ? `{{$nodes.${nodeId}.text}}` : `{{$nodes.${nodeId}.json.${key}}}`
}

/** Short, capitalized badge label for a var type (e.g. "String", "Number", "JSON"). */
function varTypeLabel(type: WorkflowVarType): string {
  if (type === 'json') return 'JSON'
  return type.charAt(0).toUpperCase() + type.slice(1)
}


type InputSourceOption = {
  value: string
  label: string
  source: string
  /** Set for a typed field option — drives auto-typing + key suggestion on pick. */
  varType?: WorkflowVarType
  /** Suggested binding key (last path segment) when the user hasn't named one. */
  keySuggestion?: string
}

/**
 * Source options for an input binding, derived from the reachable upstream nodes.
 * Each described output field becomes a typed option (so picking it auto-sets the
 * binding's type); every node also keeps coarse .text / whole-.json escape hatches.
 */
function buildInputSourceOptions(
  upstreamNodes: UpstreamNode[],
  t: (key: string, opts?: Record<string, unknown>) => string
): InputSourceOption[] {
  const options: InputSourceOption[] = [
    { value: 'text', label: t('workflowInputSourceText'), source: '{{text}}' },
    { value: 'json', label: t('workflowInputSourceJson'), source: '{{json}}' }
  ]
  for (const upstream of upstreamNodes) {
    const name = upstream.name.trim() || t(`workflowNode_${upstream.type}`)
    for (const output of describeNodeOutput(upstream.node)) {
      options.push({
        value: `node:${upstream.id}:field:${output.key}`,
        label: `${name} · ${output.label || output.key}`,
        source: nodeFieldToken(upstream.id, output.key),
        varType: output.type,
        keySuggestion: output.key.split('.').pop() || output.key
      })
    }
    options.push({
      value: `node:${upstream.id}:text`,
      label: t('workflowInputSourceNodeText', { name }),
      source: `{{$nodes.${upstream.id}.text}}`
    })
    options.push({
      value: `node:${upstream.id}:json`,
      label: t('workflowInputSourceNodeJson', { name }),
      source: `{{$nodes.${upstream.id}.json}}`
    })
  }
  return options
}

/** A binding key derived from a suggestion, de-duplicated against keys already in use. */
function dedupeKey(suggestion: string, taken: string[]): string {
  const base = suggestion.trim() || 'field'
  if (!taken.includes(base)) return base
  let n = 2
  while (taken.includes(`${base}_${n}`)) n += 1
  return `${base}_${n}`
}

type DanglingRef = { token: string; reason: 'node' | 'field' }

/**
 * {{$nodes.<id>…}} references in this node's config/inputs whose target no longer
 * resolves — the node id isn't a reachable upstream node ('node'), or the field
 * isn't in that node's typed output ('field', only checked against a known
 * descriptor; opaque .json/.text drilling is never flagged). Renderer-only;
 * never alters the stored value. This is the safety net for refs that silently
 * break when a node is renamed/reconnected/deleted.
 */
export function collectDanglingRefs(node: WorkflowNodeV1, upstreamNodes: UpstreamNode[]): DanglingRef[] {
  const refs = extractNodeRefs(JSON.stringify({ config: node.config, inputs: node.inputs ?? [] }))
  if (refs.length === 0) return []
  const byId = new Map(upstreamNodes.map((upstream) => [upstream.id, upstream]))
  const out: DanglingRef[] = []
  const seen = new Set<string>()
  for (const ref of refs) {
    const upstream = byId.get(ref.nodeId)
    let reason: DanglingRef['reason'] | null = null
    if (!upstream) {
      reason = 'node'
    } else if (ref.firstField) {
      const fields = describeNodeOutput(upstream.node)
      if (fields.length > 0 && !fields.some((field) => field.key.split('.')[0] === ref.firstField)) {
        reason = 'field'
      }
    }
    if (!reason) continue
    const dedup = `${ref.token}|${reason}`
    if (seen.has(dedup)) continue
    seen.add(dedup)
    out.push({ token: ref.token, reason })
  }
  return out
}

/**
 * Optional, per-node typed inputs bound to upstream output (dify-style). Each
 * binding names an upstream value so the node can reference it precisely as
 * {{$input.key}}. Collapsed by default — most nodes just consume upstream output
 * automatically and never need this. The source is picked from a dropdown of
 * upstream fields, with a "custom expression" escape hatch for power users.
 */
export function InputBindingsEditor({
  node,
  upstreamNodes,
  onChange
}: {
  node: WorkflowNodeV1
  upstreamNodes: UpstreamNode[]
  onChange: (node: WorkflowNodeV1) => void
}): ReactElement {
  const { t } = useTranslation('common')
  const inputs = node.inputs ?? []
  const [expanded, setExpanded] = useState(inputs.length > 0)
  const sourceOptions = buildInputSourceOptions(upstreamNodes, t)
  const setInputs = (next: WorkflowNodeInputV1[]): void =>
    onChange({ ...node, inputs: next.length > 0 ? next : undefined })
  const defaultSource = upstreamNodes[0] ? `{{$nodes.${upstreamNodes[0].id}.text}}` : '{{text}}'
  const addInput = (): void => {
    setInputs([...inputs, { key: `field${inputs.length + 1}`, type: 'text', source: defaultSource }])
    setExpanded(true)
  }
  return (
    <div className="flex flex-col gap-2 border-t border-ds-border pt-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          className="-ml-1 inline-flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-left text-[12px] font-medium text-ds-muted transition hover:text-ds-ink"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ds-faint" strokeWidth={2} />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ds-faint" strokeWidth={2} />
          )}
          <span className="truncate">{t('workflowNodeInputs')}</span>
          <span className="shrink-0 rounded-full bg-ds-subtle px-1.5 py-0.5 text-[10px] font-normal text-ds-faint">
            {inputs.length > 0 ? inputs.length : t('workflowOptional')}
          </span>
        </button>
        <button
          type="button"
          onClick={addInput}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium text-accent transition hover:bg-accent/10"
        >
          <Plus className="h-3 w-3" strokeWidth={2} />
          {t('workflowNodeInputAdd')}
        </button>
      </div>
      {expanded ? (
        <>
          <p className="text-[11px] leading-4 text-ds-faint">{t('workflowNodeInputsHint')}</p>
          {inputs.map((input, index) => {
            const update = (patch: Partial<WorkflowNodeInputV1>): void =>
              setInputs(inputs.map((item, i) => (i === index ? { ...item, ...patch } : item)))
            const matched = sourceOptions.find((option) => option.source === input.source.trim())
            const selectValue = matched ? matched.value : 'custom'
            const key = input.key.trim()
            const otherKeys = inputs.filter((_, i) => i !== index).map((item) => item.key.trim()).filter(Boolean)
            return (
              <div key={index} className="flex flex-col gap-2 rounded-lg border border-ds-border p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <label className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-[11px] font-medium text-ds-faint">{t('workflowInputSourceLabel')}</span>
                    <select
                      className={INPUT_CLASS}
                      value={selectValue}
                      onChange={(event) => {
                        const next = event.target.value
                        if (next === 'custom') {
                          // Entering custom mode: clear the preset so the box starts empty for typing.
                          if (matched) update({ source: '' })
                          return
                        }
                        const option = sourceOptions.find((item) => item.value === next)
                        if (!option) return
                        const patch: Partial<WorkflowNodeInputV1> = { source: option.source }
                        // Picking a typed field auto-sets the binding's type so it won't mis-coerce at runtime…
                        if (option.varType) patch.type = varTypeToInputType(option.varType)
                        // …and names the binding from the field when the user hasn't named one yet (Dify's guard).
                        if (!key && option.keySuggestion) patch.key = dedupeKey(option.keySuggestion, otherKeys)
                        update(patch)
                      }}
                    >
                      {sourceOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                      <option value="custom">{t('workflowInputSourceCustom')}</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => setInputs(inputs.filter((_, i) => i !== index))}
                    className="mt-[22px] inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ds-faint transition hover:bg-red-500/10 hover:text-red-600"
                    aria-label={t('workflowNodeInputRemove')}
                  >
                    <X className="h-3.5 w-3.5" strokeWidth={2} />
                  </button>
                </div>
                {selectValue === 'custom' ? (
                  <input
                    className={`${INPUT_CLASS} font-mono text-[12px]`}
                    value={input.source}
                    placeholder={t('workflowInputSourceCustomPlaceholder')}
                    onChange={(event) => update({ source: event.target.value })}
                  />
                ) : null}
                <div className="flex items-end gap-2">
                  <label className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-[11px] font-medium text-ds-faint">{t('workflowInputNameLabel')}</span>
                    <input
                      className={INPUT_CLASS}
                      value={input.key}
                      placeholder={t('workflowInputNamePlaceholder')}
                      onChange={(event) => update({ key: event.target.value })}
                    />
                  </label>
                  <label className="flex w-24 shrink-0 flex-col gap-1">
                    <span className="text-[11px] font-medium text-ds-faint">{t('workflowInputTypeLabel')}</span>
                    <select
                      className={INPUT_CLASS}
                      value={input.type}
                      onChange={(event) => update({ type: event.target.value as WorkflowNodeInputType })}
                    >
                      {WORKFLOW_NODE_INPUT_TYPES.map((inputType) => (
                        <option key={inputType} value={inputType}>
                          {t(`workflowInputType_${inputType}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="text-[11px] leading-4 text-ds-faint">
                  {t('workflowInputRefPreview')}{' '}
                  <code className="select-all font-mono text-accent">{`{{$input.${key || 'key'}}}`}</code>
                </p>
              </div>
            )
          })}
        </>
      ) : null}
    </div>
  )
}

/** Reusable typed-field editor — shared by the manual trigger's input schema and the Parameter Extractor. */
/** Small capitalized type pill for a picker row (e.g. String / Number / JSON). */
function TypeBadge({ type }: { type: WorkflowVarType }): ReactElement {
  return (
    <span className="shrink-0 rounded bg-ds-subtle px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wide text-ds-faint">
      {varTypeLabel(type)}
    </span>
  )
}

/** Does a var (or any descendant) match the search query? */
function varMatchesQuery(output: WorkflowOutputVar, query: string): boolean {
  if (output.key.toLowerCase().includes(query) || (output.label ?? '').toLowerCase().includes(query)) return true
  return (output.children ?? []).some((child) => varMatchesQuery(child, query))
}

const PICKER_ROW =
  'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-ds-ink transition hover:bg-ds-hover'

/** One described output field; recurses for object children (indented). Leaves insert a complete token. */
function VarRow({
  nodeId,
  output,
  prefix,
  depth,
  onInsert
}: {
  nodeId: string
  output: WorkflowOutputVar
  prefix: string
  depth: number
  onInsert: (token: string) => void
}): ReactElement {
  const path = prefix ? `${prefix}.${output.key}` : output.key
  const pad = { paddingLeft: `${8 + depth * 12}px` }
  if (output.children?.length) {
    return (
      <>
        <div className="flex items-center justify-between gap-2 px-2 py-1 text-[12px] text-ds-muted" style={pad}>
          <span className="min-w-0 truncate">{output.label || output.key}</span>
          <TypeBadge type={output.type} />
        </div>
        {output.children.map((child) => (
          <VarRow key={child.key} nodeId={nodeId} output={child} prefix={path} depth={depth + 1} onInsert={onInsert} />
        ))}
      </>
    )
  }
  return (
    <button
      type="button"
      className={PICKER_ROW}
      style={pad}
      onClick={() => onInsert(nodeFieldToken(nodeId, path))}
      title={nodeFieldToken(nodeId, path)}
    >
      <span className="min-w-0 truncate">{output.label || output.key}</span>
      <TypeBadge type={output.type} />
    </button>
  )
}

/**
 * Cascading, typed variable picker (dify-style). Lists the common scopes plus each
 * reachable upstream node's described output fields (with type badges), so authors
 * pick a field by click instead of hand-typing a {{$nodes.id.json.path}} expression.
 * Opaque nodes keep the whole-.json / .text escape hatches. Inserts today's token
 * grammar verbatim, so picked references are byte-identical to hand-typed ones.
 */
export function VariablePicker({
  upstreamNodes,
  onInsert,
  onClose
}: {
  upstreamNodes: UpstreamNode[]
  onInsert: (token: string) => void
  onClose: () => void
}): ReactElement {
  const { t } = useTranslation('common')
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()

  const common = [
    { token: '{{text}}', label: '{{text}}' },
    { token: '{{json.}}', label: '{{json.…}}' },
    { token: '{{$input.}}', label: '{{$input.…}}' },
    { token: '{{$env.}}', label: '{{$env.…}}' },
    { token: '{{$run.}}', label: '{{$run.…}}' }
  ].filter((item) => !q || item.label.toLowerCase().includes(q))

  const groups = upstreamNodes
    .map((upstream) => ({
      upstream,
      name: upstream.name.trim() || t(`workflowNode_${upstream.type}`),
      vars: describeNodeOutput(upstream.node)
    }))
    .filter((group) => !q || group.name.toLowerCase().includes(q) || group.vars.some((v) => varMatchesQuery(v, q)))

  const header = 'px-2 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-ds-faint'
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute right-0 top-9 z-50 flex max-h-[60vh] w-[280px] flex-col overflow-y-auto rounded-xl border border-ds-border bg-ds-elevated p-1.5 shadow-[0_24px_70px_rgba(44,55,78,0.22)] backdrop-blur-xl dark:shadow-[0_30px_80px_rgba(0,0,0,0.5)]">
        <input
          autoFocus
          className={`${INPUT_CLASS} mb-1 py-1.5 text-[12px]`}
          placeholder={t('workflowVarSearch')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {common.length > 0 ? (
          <>
            <p className={header}>{t('workflowVarCommon')}</p>
            {common.map((item) => (
              <button key={item.token} type="button" className={PICKER_ROW} onClick={() => onInsert(item.token)}>
                <span className="font-mono text-accent">{item.label}</span>
              </button>
            ))}
          </>
        ) : null}
        {groups.length > 0 ? (
          <>
            <p className={header}>{t('workflowVarUpstream')}</p>
            {groups.map((group) => (
              <div key={group.upstream.id} className="mb-0.5">
                <p className="truncate px-2 pb-0.5 pt-1 text-[11px] font-medium text-ds-muted">{group.name}</p>
                {group.vars.map((output) => (
                  <VarRow
                    key={output.key}
                    nodeId={group.upstream.id}
                    output={output}
                    prefix=""
                    depth={0}
                    onInsert={onInsert}
                  />
                ))}
                <div className="flex items-stretch gap-1 pl-2">
                  <button
                    type="button"
                    className="flex-1 rounded-md px-2 py-1 text-left text-[10.5px] font-mono text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
                    onClick={() => onInsert(`{{$nodes.${group.upstream.id}.json.}}`)}
                    title={`{{$nodes.${group.upstream.id}.json.…}}`}
                  >
                    .json…
                  </button>
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-[10.5px] font-mono text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
                    onClick={() => onInsert(`{{$nodes.${group.upstream.id}.text}}`)}
                    title={`{{$nodes.${group.upstream.id}.text}}`}
                  >
                    .text
                  </button>
                </div>
              </div>
            ))}
          </>
        ) : null}
        {common.length === 0 && groups.length === 0 ? (
          <p className="px-2 py-3 text-center text-[11.5px] text-ds-faint">{t('workflowVarNoMatch')}</p>
        ) : null}
      </div>
    </>
  )
}
