import {
  buildDesignHtmlQualityRepairPrompt,
  mergeDesignHtmlQualityFindings,
  type DesignHtmlQualityFinding,
  type DesignRuntimeQualityPayload
} from './design-html-quality'
import { findDesignBoardArtifact } from './design-board'
import { useCanvasSelectionStore } from './canvas/canvas-selection-store'
import { useDesignWorkspaceStore } from './design-workspace-store'
import { designAutoRepairArtifactKey } from './design-turn-prompt/target'

export type DesignPromptSource = 'user' | 'auto-quality-repair' | 'manual-quality-repair'

export type DesignQualityRepairMode = 'auto' | 'manual'

type RefLike<T> = { current: T }

export type DesignQualityRepairRuntimeState = {
  route: string
  runtimeConnection: string
  busy: boolean
  pagesRunActive: boolean
}

export type DesignQualityRepairTimerApi = {
  setTimeout?: (callback: () => void, delayMs: number) => number
  clearTimeout?: (timer: number) => void
  now?: () => number
  retryDelayMs?: number
  sendDelayMs?: number
  maxAttempts?: number
}

export type DesignQualityRepairDispatchOptions = {
  payload: DesignRuntimeQualityPayload
  findings: DesignHtmlQualityFinding[]
  mode: DesignQualityRepairMode
  autoRepairSentRef: RefLike<Set<string>>
  pendingTimersRef: RefLike<Map<string, number>>
  manualLastSentRef: RefLike<Map<string, number>>
  runtimeState: () => DesignQualityRepairRuntimeState
  sendDesignPrompt: (
    prompt: string,
    options: { displayText: string; source: DesignPromptSource }
  ) => void
  timerApi?: DesignQualityRepairTimerApi
  getDesignState?: typeof useDesignWorkspaceStore.getState
  selectCanvasShapes?: (ids: string[]) => void
}

export function designAutoRepairPayloadKey(payload: DesignRuntimeQualityPayload): string {
  const artifactKey = designAutoRepairArtifactKey(payload.artifactId)
  if (artifactKey) return artifactKey
  const path = payload.artifactRelativePath.trim().replaceAll('\\', '/')
  if (path) return `path:${path}`
  const shapeId = payload.shapeId?.trim()
  return shapeId ? `shape:${shapeId}` : ''
}

function isRepairRuntimeReady(state: DesignQualityRepairRuntimeState): boolean {
  return (
    (state.route === 'design' || state.route === 'chat') &&
    state.runtimeConnection === 'ready' &&
    !state.busy &&
    !state.pagesRunActive
  )
}

function activateRepairTarget(options: DesignQualityRepairDispatchOptions): void {
  const getDesignState = options.getDesignState ?? useDesignWorkspaceStore.getState
  const selectCanvasShapes =
    options.selectCanvasShapes ?? ((ids: string[]) => useCanvasSelectionStore.getState().select(ids))
  const store = getDesignState()
  const board = findDesignBoardArtifact(store.artifacts)
  if (board) store.setActiveArtifact(board.id)
  if (options.payload.shapeId) {
    selectCanvasShapes([options.payload.shapeId])
  } else {
    store.setActiveArtifact(options.payload.artifactId)
  }
  store.setDesignIntentMode('modify')
}

export function requestDesignQualityRepairDispatch(
  options: DesignQualityRepairDispatchOptions
): void {
  const repairFindings = mergeDesignHtmlQualityFindings(options.findings)
  if (repairFindings.length === 0) return
  if (options.mode === 'auto') return
  const codes = repairFindings.map((finding) => finding.code).sort()
  const autoScopeKey = designAutoRepairPayloadKey(options.payload)
  const key = `manual:${autoScopeKey || 'unknown'}|${codes.join(',')}`
  if (!key) return

  const now = options.timerApi?.now ?? Date.now
  const lastSentAt = options.manualLastSentRef.current.get(key) ?? 0
  if (now() - lastSentAt < 3000) return

  const setTimer =
    options.timerApi?.setTimeout ?? ((callback: () => void, delayMs: number) => window.setTimeout(callback, delayMs))
  const clearTimer =
    options.timerApi?.clearTimeout ?? ((timer: number) => window.clearTimeout(timer))
  const retryDelayMs = options.timerApi?.retryDelayMs ?? 1500
  const sendDelayMs = options.timerApi?.sendDelayMs ?? 120
  const maxAttempts = options.timerApi?.maxAttempts ?? 24

  const trigger = (attempt: number): void => {
    if (!isRepairRuntimeReady(options.runtimeState())) {
      if (attempt >= maxAttempts || options.pendingTimersRef.current.has(key)) return
      const timer = setTimer(() => {
        options.pendingTimersRef.current.delete(key)
        trigger(attempt + 1)
      }, retryDelayMs)
      options.pendingTimersRef.current.set(key, timer)
      return
    }

    options.manualLastSentRef.current.set(key, now())
    if (autoScopeKey) {
      options.autoRepairSentRef.current.add(autoScopeKey)
      const autoPending = options.pendingTimersRef.current.get(autoScopeKey)
      if (autoPending) {
        clearTimer(autoPending)
        options.pendingTimersRef.current.delete(autoScopeKey)
      }
    }
    const pending = options.pendingTimersRef.current.get(key)
    if (pending) {
      clearTimer(pending)
      options.pendingTimersRef.current.delete(key)
    }

    const store = (options.getDesignState ?? useDesignWorkspaceStore.getState)()
    activateRepairTarget(options)
    const prompt = buildDesignHtmlQualityRepairPrompt(repairFindings, 'manual', store.designContext)
    const displayText = `Repair design quality: ${codes.join(', ')}`
    setTimer(() => {
      options.sendDesignPrompt(prompt, {
        displayText,
        source: 'manual-quality-repair'
      })
    }, sendDelayMs)
  }

  trigger(0)
}
