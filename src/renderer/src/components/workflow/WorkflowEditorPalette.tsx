import type { DragEvent, ReactElement } from 'react'
import { ArrowLeft, ChevronRight, Plus, Settings2, X } from 'lucide-react'
import type {
  WorkflowCustomModuleV1,
  WorkflowNodeKind,
  WorkflowNodePresetV1
} from '@shared/app-settings'
import { NODE_ICONS } from './WorkflowNodes'
import { WORKFLOW_PALETTE_GROUPS } from './workflow-types'
import {
  WORKFLOW_EDITOR_BACK_BUTTON_CLASS,
  WORKFLOW_EDITOR_SIDEBAR_CLASS
} from './workflow-editor-types'

type Translate = (key: string) => string

type WorkflowEditorPaletteProps = {
  onBack: () => void
  t: Translate
  collapsedGroups: ReadonlySet<string>
  toggleGroup: (groupId: string) => void
  onPaletteDragStart: (event: DragEvent<HTMLButtonElement>, kind: WorkflowNodeKind) => void
  addNode: (kind: WorkflowNodeKind) => void
  setShowModules: (open: boolean) => void
  modules: WorkflowCustomModuleV1[]
  onModuleDragStart: (event: DragEvent<HTMLButtonElement>, moduleId: string) => void
  addModuleNode: (module: WorkflowCustomModuleV1) => void
  presets: WorkflowNodePresetV1[]
  onPresetDragStart: (event: DragEvent<HTMLButtonElement>, presetId: string) => void
  addPresetNode: (preset: WorkflowNodePresetV1) => void
  onDeletePreset: (presetId: string) => void | Promise<void>
}

export function WorkflowEditorPalette(props: WorkflowEditorPaletteProps): ReactElement {
  const {
    onBack,
    t,
    collapsedGroups,
    toggleGroup,
    onPaletteDragStart,
    addNode,
    setShowModules,
    modules,
    onModuleDragStart,
    addModuleNode,
    presets,
    onPresetDragStart,
    addPresetNode,
    onDeletePreset
  } = props
  return (
        <aside className={WORKFLOW_EDITOR_SIDEBAR_CLASS}>
          <div className="workflow-editor-sidebar-header shrink-0 px-2 pb-2 pt-3">
            <div aria-hidden className="ds-titlebar-safe-block" />
            <button type="button" onClick={onBack} className={WORKFLOW_EDITOR_BACK_BUTTON_CLASS}>
              <ArrowLeft className="h-4 w-4" strokeWidth={1.8} />
              {t('workflowBack')}
            </button>
          </div>
          <div className="workflow-editor-palette ds-no-drag flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pb-3">
            <span className="workflow-editor-palette-title px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ds-faint">
              {t('workflowPalette')}
            </span>
            {WORKFLOW_PALETTE_GROUPS.map((group) => {
              const collapsed = collapsedGroups.has(group.id)
              return (
                <div key={group.id} className="workflow-editor-palette-group flex flex-col">
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.id)}
                    className="workflow-editor-palette-group-toggle flex items-center gap-1 px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-ds-faint transition hover:text-ds-muted"
                  >
                    <ChevronRight
                      className={`h-3 w-3 shrink-0 transition-transform ${collapsed ? '' : 'rotate-90'}`}
                      strokeWidth={2}
                    />
                    <span className="min-w-0 flex-1 truncate text-left">{t(`workflowGroup_${group.id}`)}</span>
                  </button>
                  {!collapsed
                    ? group.kinds.map((kind) => {
                        const Icon = NODE_ICONS[kind]
                        return (
                          <button
                            key={kind}
                            type="button"
                            draggable
                            onDragStart={(event) => onPaletteDragStart(event, kind)}
                            onClick={() => addNode(kind)}
                            className="workflow-editor-palette-item flex cursor-grab items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left text-[12.5px] text-ds-ink transition hover:border-ds-border hover:bg-ds-hover active:cursor-grabbing"
                          >
                            <span className="workflow-editor-palette-icon flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
                              <Icon className="h-3.5 w-3.5" strokeWidth={1.9} />
                            </span>
                            <span className="min-w-0 flex-1 truncate">{t(`workflowNode_${kind}`)}</span>
                            <Plus className="h-3.5 w-3.5 shrink-0 text-ds-faint" strokeWidth={1.8} />
                          </button>
                        )
                      })
                    : null}
                </div>
              )
            })}

            <div className="flex flex-col">
              <div className="flex items-center gap-1 pr-1">
                <button
                  type="button"
                  onClick={() => toggleGroup('custom')}
                  className="workflow-editor-palette-group-toggle flex min-w-0 flex-1 items-center gap-1 px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-ds-faint transition hover:text-ds-muted"
                >
                  <ChevronRight
                    className={`h-3 w-3 shrink-0 transition-transform ${collapsedGroups.has('custom') ? '' : 'rotate-90'}`}
                    strokeWidth={2}
                  />
                  <span className="min-w-0 flex-1 truncate text-left">{t('workflowGroup_custom')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowModules(true)}
                  title={t('workflowModulesManage')}
                  aria-label={t('workflowModulesManage')}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
                >
                  <Settings2 className="h-3.5 w-3.5" strokeWidth={1.8} />
                </button>
              </div>
              {!collapsedGroups.has('custom') ? (
                <>
                  {modules.map((module) => {
                    const Icon = NODE_ICONS.custom
                    return (
                      <button
                        key={module.id}
                        type="button"
                        draggable
                        onDragStart={(event) => onModuleDragStart(event, module.id)}
                        onClick={() => addModuleNode(module)}
                        title={module.description || module.name}
                        className="workflow-editor-palette-item flex cursor-grab items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left text-[12.5px] text-ds-ink transition hover:border-ds-border hover:bg-ds-hover active:cursor-grabbing"
                      >
                        <span className="workflow-editor-palette-icon flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
                          <Icon className="h-3.5 w-3.5" strokeWidth={1.9} />
                        </span>
                        <span className="min-w-0 flex-1 truncate">{module.name}</span>
                        <Plus className="h-3.5 w-3.5 shrink-0 text-ds-faint" strokeWidth={1.8} />
                      </button>
                    )
                  })}
                  {presets.map((preset) => {
                    const Icon = NODE_ICONS[preset.nodeType]
                    return (
                      <div key={preset.id} className="group/preset relative flex items-center">
                        <button
                          type="button"
                          draggable
                          onDragStart={(event) => onPresetDragStart(event, preset.id)}
                          onClick={() => addPresetNode(preset)}
                          className="workflow-editor-palette-item flex min-w-0 flex-1 cursor-grab items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 pr-7 text-left text-[12.5px] text-ds-ink transition hover:border-ds-border hover:bg-ds-hover active:cursor-grabbing"
                        >
                          <span className="workflow-editor-palette-icon flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
                            <Icon className="h-3.5 w-3.5" strokeWidth={1.9} />
                          </span>
                          <span className="min-w-0 flex-1 truncate">{preset.label}</span>
                        </button>
                        <button
                          type="button"
                          title={t('workflowPresetDelete')}
                          aria-label={t('workflowPresetDelete')}
                          onClick={() => void onDeletePreset(preset.id)}
                          className="absolute right-1 flex h-5 w-5 items-center justify-center rounded text-ds-faint opacity-0 transition hover:bg-red-500/10 hover:text-red-600 group-hover/preset:opacity-100"
                        >
                          <X className="h-3 w-3" strokeWidth={2} />
                        </button>
                      </div>
                    )
                  })}
                  {modules.length === 0 && presets.length === 0 ? (
                    <p className="px-2 py-1 text-[11px] leading-4 text-ds-faint">{t('workflowPresetEmpty')}</p>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        </aside>
  )
}
