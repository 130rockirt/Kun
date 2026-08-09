import type {
  AppSettingsV1,
  WorkflowCustomModuleV1,
  WorkflowEnvVarV1,
  WorkflowNodePresetV1,
  WorkflowNodeRunResultV1,
  WorkflowNodeRunStatus,
  WorkflowNodeV1,
  WorkflowV1
} from '@shared/app-settings'
import { flowToWorkflowGraph } from './workflow-types'

export type ConnectMenuState = {
  x: number
  y: number
  flowPos: { x: number; y: number }
  sourceId: string
  sourceHandle: string
}

export const DND_MIME = 'application/x-workflow-node'
export const PRESET_DND_MIME = 'application/x-workflow-preset'
export const MODULE_DND_MIME = 'application/x-workflow-module'

export const WORKFLOW_EDITOR_HEADER_CLASS =
  'workflow-editor-header ds-drag flex shrink-0 items-center gap-3 border-b border-ds-border px-4'
export const WORKFLOW_EDITOR_HEADER_SIDEBAR_COLLAPSED_CLASS =
  'workflow-editor-header-sidebar-collapsed'
export const WORKFLOW_EDITOR_SIDEBAR_CLASS =
  'workflow-editor-sidebar ds-sidebar-surface ds-drag flex w-[184px] shrink-0 flex-col border-r border-ds-border'
export const WORKFLOW_EDITOR_BACK_BUTTON_CLASS =
  'workflow-editor-back-button ds-no-drag flex h-9 items-center gap-2 rounded-xl px-2 text-[13px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink'

export type WorkflowConnectionsArg = ReturnType<typeof flowToWorkflowGraph>['connections']

export type Props = {
  workflow: WorkflowV1
  settings: AppSettingsV1
  runStatus: Record<string, WorkflowNodeRunStatus>
  lastResults: Record<string, WorkflowNodeRunResultV1>
  /** Live per-node results during a run (input/output/timing) for the run-log panel. */
  liveResults: Record<string, WorkflowNodeRunResultV1>
  running: boolean
  onPersist: (patch: {
    name: string
    enabled: boolean
    env: WorkflowEnvVarV1[]
    nodes: WorkflowNodeV1[]
    connections: WorkflowConnectionsArg
  }) => Promise<void>
  onRun: () => Promise<void> | void
  onRunNode: (nodeId: string) => Promise<void> | void
  onStop: () => Promise<void> | void
  onBack: () => void
  presets: WorkflowNodePresetV1[]
  onSavePreset: (preset: WorkflowNodePresetV1) => void | Promise<void>
  onDeletePreset: (presetId: string) => void | Promise<void>
  modules: WorkflowCustomModuleV1[]
  onSaveModules: (modules: WorkflowCustomModuleV1[]) => void | Promise<void>
}
