import type {
  WorkspaceOfficePreviewResult,
  WorkspaceOfficePreviewSuccess
} from '@shared/office-document'
import {
  LIVE_OFFICE_PREVIEW_EVENT,
  latestLiveOfficePreview,
  normalizeLiveOfficePreviewPath,
  type LiveOfficePreviewDetail
} from './live-office-preview'

const OFFICE_REFRESH_DEBOUNCE_MS = 250

export type WorkspaceOfficePreviewControllerApi = Pick<
  Window['kunGui'],
  | 'readWorkspaceOfficePreview'
  | 'watchWorkspaceFile'
  | 'unwatchWorkspaceFile'
  | 'onWorkspaceFileChanged'
>

export type WorkspaceOfficePreviewControllerCallbacks = {
  onLoading: (loading: boolean) => void
  onAgentEditing: (editing: boolean) => void
  onRefreshError: (message: string | null) => void
  onPreview: (preview: WorkspaceOfficePreviewSuccess) => void
  onFailure?: (failure: Extract<WorkspaceOfficePreviewResult, { ok: false }>) => void
}

export function startWorkspaceOfficePreviewController(options: {
  api: WorkspaceOfficePreviewControllerApi
  path: string
  workspaceRoot: string
  callbacks: WorkspaceOfficePreviewControllerCallbacks
  loadImmediately?: boolean
}): () => void {
  let disposed = false
  let watchId = ''
  let requestId = 0
  let refreshTimer: number | undefined
  let latestExpectedSha = ''

  const clearTimer = (): void => {
    if (refreshTimer === undefined) return
    window.clearTimeout(refreshTimer)
    refreshTimer = undefined
  }
  const scheduleRefresh = (expectedSha = ''): void => {
    if (expectedSha) latestExpectedSha = expectedSha
    clearTimer()
    refreshTimer = window.setTimeout(() => {
      refreshTimer = undefined
      void renderLatest(latestExpectedSha)
    }, OFFICE_REFRESH_DEBOUNCE_MS)
  }
  const renderLatest = async (expectedSha = ''): Promise<void> => {
    const currentRequest = ++requestId
    options.callbacks.onLoading(true)
    try {
      const result = await options.api.readWorkspaceOfficePreview({
        path: options.path,
        workspaceRoot: options.workspaceRoot,
        ...(expectedSha ? { expectedSha256: expectedSha } : {})
      })
      if (disposed || currentRequest !== requestId) return
      if (!result.ok) {
        options.callbacks.onFailure?.(result)
        options.callbacks.onRefreshError(result.message)
        if (result.code === 'source_changed' && expectedSha) {
          latestExpectedSha = ''
          scheduleRefresh()
        }
        return
      }
      if (expectedSha && result.sourceSha256 !== expectedSha) {
        latestExpectedSha = ''
        scheduleRefresh()
        return
      }
      latestExpectedSha = ''
      options.callbacks.onPreview(result)
      options.callbacks.onRefreshError(null)
    } catch (error) {
      if (!disposed && currentRequest === requestId) {
        options.callbacks.onRefreshError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (!disposed && currentRequest === requestId) options.callbacks.onLoading(false)
    }
  }

  const onLivePreview = (rawEvent: Event): void => {
    const detail = (rawEvent as CustomEvent<LiveOfficePreviewDetail>).detail
    if (!detail || !officePreviewTargetsMatch(options.path, options.workspaceRoot, detail)) return
    if (detail.phase === 'editing') {
      options.callbacks.onAgentEditing(true)
      return
    }
    options.callbacks.onAgentEditing(false)
    if (detail.phase === 'committed') scheduleRefresh(detail.expectedSha256)
  }
  const removeWatchListener = options.api.onWorkspaceFileChanged((event) => {
    if (!watchId || event.watchId !== watchId) return
    if (event.ok) scheduleRefresh()
    else options.callbacks.onRefreshError(event.message)
  })
  window.addEventListener(LIVE_OFFICE_PREVIEW_EVENT, onLivePreview)
  if (options.loadImmediately !== false) void renderLatest()
  void options.api.watchWorkspaceFile({
    path: options.path,
    workspaceRoot: options.workspaceRoot,
    mode: 'signal'
  }).then((watch) => {
    if (disposed) {
      if (watch.ok) void options.api.unwatchWorkspaceFile(watch.watchId)
      return
    }
    if (!watch.ok) {
      options.callbacks.onRefreshError(watch.message)
      return
    }
    watchId = watch.watchId
    scheduleRefresh()
  }).catch((error) => {
    if (!disposed) options.callbacks.onRefreshError(error instanceof Error ? error.message : String(error))
  })

  const latest = latestLiveOfficePreview(options.path, options.workspaceRoot)
  if (latest && officePreviewTargetsMatch(options.path, options.workspaceRoot, latest)) {
    if (latest.phase === 'editing') options.callbacks.onAgentEditing(true)
    else if (latest.phase === 'committed') scheduleRefresh(latest.expectedSha256)
  }

  return () => {
    disposed = true
    requestId += 1
    clearTimer()
    removeWatchListener()
    window.removeEventListener(LIVE_OFFICE_PREVIEW_EVENT, onLivePreview)
    if (watchId) void options.api.unwatchWorkspaceFile(watchId)
  }
}

export function officePreviewTargetsMatch(
  path: string,
  workspaceRoot: string,
  detail: Pick<LiveOfficePreviewDetail, 'path' | 'workspaceRoot'>
): boolean {
  const left = normalizeLiveOfficePreviewPath(path, workspaceRoot)
  const right = normalizeLiveOfficePreviewPath(detail.path, detail.workspaceRoot || workspaceRoot)
  return Boolean(left && right && left === right)
}
