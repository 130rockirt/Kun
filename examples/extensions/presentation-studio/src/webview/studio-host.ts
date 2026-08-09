import { type HostMessage, type JsonObject, type JsonValue, type Theme } from '@kun/extension-api'
import {
  decidePresentationChange,
  latestPresentationPath,
  presentationPathsFromWorkspaceEntries
} from '../shared/presentation-sync.js'
import {
  client,
  errorMessage,
  executeCommand,
  setActivePanel,
  setConflict,
  setSaveStatus,
  state,
  ui,
  type CommandResponse,
  type PresentationChangedPayload
} from './studio-runtime.js'
import { flushPending } from './studio-editing.js'
import { commitProject } from './studio-visual.js'

export async function loadDeck(path: string, preferredSlideId?: string): Promise<void> {
  if (state.pendingOperations.length > 0) await flushPending('before-load')
  setSaveStatus('Loading presentation…', 'saving')
  const response = await executeCommand<CommandResponse>('presentation-load', { path })
  commitProject(response.project, response.path, preferredSlideId)
}

export async function createDeck(path: string): Promise<void> {
  if (state.pendingOperations.length > 0) await flushPending('before-create')
  setSaveStatus('Creating presentation…', 'saving')
  const response = await executeCommand<CommandResponse>('presentation-create', {
    path,
    title: path.replace(/\.kun-ppt\.html$/u, '').replaceAll('-', ' ')
  })
  commitProject(response.project, response.path)
}

export async function latestWorkspaceDeckPath(): Promise<string | undefined> {
  const entries = await client.workspace.list('.')
  const paths = presentationPathsFromWorkspaceEntries(entries)
  const candidates = await Promise.all(paths.map(async (path) => {
    try {
      const info = await client.workspace.stat(path)
      return {
        path,
        modifiedAt: typeof info.modifiedAt === 'string' ? info.modifiedAt : ''
      }
    } catch {
      return null
    }
  }))
  return latestPresentationPath(candidates.filter((candidate) => candidate !== null))
}

export function isChangedPayload(value: JsonValue): value is JsonObject & PresentationChangedPayload {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return false
  return typeof value.path === 'string' &&
    typeof value.revision === 'number' &&
    (value.source === 'command' || value.source === 'tool') &&
    Array.isArray(value.changedIds)
}

export async function handleHostMessage(message: HostMessage): Promise<void> {
  if (message.channel !== 'presentation.changed' || !isChangedPayload(message.payload)) return
  const change = message.payload
  if (change.source === 'command' && state.ownSaveTargetRevision === change.revision) return
  const action = decidePresentationChange({
    hasProject: state.project !== null,
    activePath: state.activePath,
    currentRevision: state.project?.revision ?? 0,
    changePath: change.path,
    changeRevision: change.revision,
    source: change.source
  })
  if (action === 'ignore') return
  if (action === 'refresh-current' && (state.pendingOperations.length > 0 || state.savePromise)) {
    setConflict(`Revision ${change.revision} arrived while local edits were pending.`)
    return
  }
  try {
    const path = action === 'follow-tool' ? change.path : state.activePath
    const slideId = action === 'refresh-current' ? state.selectedSlideId ?? undefined : undefined
    await loadDeck(path, slideId)
    setActivePanel('canvas')
    setSaveStatus(
      action === 'follow-tool'
        ? `Showing Agent presentation · revision ${change.revision}`
        : `Refreshed after ${change.source} change · revision ${change.revision}`,
      'saved'
    )
  } catch (error) {
    setConflict(`Could not refresh revision ${change.revision}: ${errorMessage(error)}`)
  }
}

export function applyTheme(theme: Theme): void {
  ui.studio.dataset.theme = theme.kind
  document.documentElement.dataset.reducedMotion = String(theme.reducedMotion)
}
