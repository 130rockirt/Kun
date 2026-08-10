import { useEffect, useRef, useState } from 'react'
import type { WorkspaceFileTarget } from '@shared/workspace-file'
import type { WorkspaceOfficePreviewResult } from '@shared/office-document'
import { workspaceFileTargetKey } from '../lib/workspace-file-target-key'
import {
  LIVE_OFFICE_PREVIEW_EVENT,
  latestLiveOfficePreview,
  normalizeLiveOfficePreviewPath,
  type LiveOfficePreviewDetail
} from '../lib/live-office-preview'

const OFFICE_REFRESH_DEBOUNCE_MS = 250

type UseWorkspaceOfficePreviewOptions = {
  target: WorkspaceFileTarget | null
  workspaceRoot: string
  enabled: boolean
}

function targetMatchesEvent(
  target: WorkspaceFileTarget,
  workspaceRoot: string,
  event: LiveOfficePreviewDetail
): boolean {
  const targetRoot = target.workspaceRoot ?? workspaceRoot
  const targetPath = normalizeLiveOfficePreviewPath(target.path, targetRoot)
  const eventPath = normalizeLiveOfficePreviewPath(event.path, targetRoot)
  return Boolean(targetPath && eventPath && targetPath === eventPath)
}

function resultError(result: WorkspaceOfficePreviewResult): string {
  return result.ok ? '' : result.message
}

export function useWorkspaceOfficePreview({
  target,
  workspaceRoot,
  enabled
}: UseWorkspaceOfficePreviewOptions) {
  const [officeResult, setOfficeResult] = useState<WorkspaceOfficePreviewResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [agentEditing, setAgentEditing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [sheetIndex, setSheetIndex] = useState(0)
  const requestIdRef = useRef(0)
  const previousTargetKeyRef = useRef('')
  const officeResultRef = useRef<WorkspaceOfficePreviewResult | null>(null)

  useEffect(() => {
    const targetKey = workspaceFileTargetKey(target)
    if (!enabled || !target || !targetKey) {
      previousTargetKeyRef.current = ''
      officeResultRef.current = null
      setOfficeResult(null)
      setLoading(false)
      setAgentEditing(false)
      setRefreshError(null)
      return
    }

    const readTarget = {
      ...target,
      workspaceRoot: target.workspaceRoot ?? workspaceRoot
    }
    const targetChanged = previousTargetKeyRef.current !== targetKey
    previousTargetKeyRef.current = targetKey
    if (targetChanged) {
      officeResultRef.current = null
      setOfficeResult(null)
      setRefreshError(null)
      setAgentEditing(false)
      setPage(1)
      setSheetIndex(0)
    }

    let disposed = false
    let watchId = ''
    let refreshTimer: number | undefined
    let latestExpectedSha = ''
    const clearRefreshTimer = (): void => {
      if (refreshTimer === undefined) return
      window.clearTimeout(refreshTimer)
      refreshTimer = undefined
    }
    const renderLatest = async (expectedSha = ''): Promise<void> => {
      const requestId = ++requestIdRef.current
      setLoading(true)
      try {
        const next = await window.kunGui.readWorkspaceOfficePreview({
          path: readTarget.path,
          workspaceRoot: readTarget.workspaceRoot,
          page,
          sheetIndex,
          ...(expectedSha ? { expectedSha256: expectedSha } : {})
        })
        if (disposed || requestId !== requestIdRef.current) return
        if (!next.ok) {
          if (!officeResultRef.current?.ok) {
            officeResultRef.current = next
            setOfficeResult(next)
          }
          setRefreshError(resultError(next))
          if (next.code === 'source_changed' && expectedSha) {
            latestExpectedSha = ''
            scheduleRefresh()
          }
          return
        }
        if (expectedSha && next.sourceSha256 !== expectedSha) {
          latestExpectedSha = ''
          scheduleRefresh()
          return
        }
        latestExpectedSha = ''
        officeResultRef.current = next
        setOfficeResult(next)
        setRefreshError(null)
      } catch (error) {
        if (!disposed && requestId === requestIdRef.current) {
          const message = error instanceof Error ? error.message : String(error)
          if (!officeResultRef.current?.ok) {
            const failed = { ok: false as const, message }
            officeResultRef.current = failed
            setOfficeResult(failed)
          }
          setRefreshError(message)
        }
      } finally {
        if (!disposed && requestId === requestIdRef.current) setLoading(false)
      }
    }
    const scheduleRefresh = (expectedSha = ''): void => {
      if (expectedSha) latestExpectedSha = expectedSha
      clearRefreshTimer()
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined
        void renderLatest(latestExpectedSha)
      }, OFFICE_REFRESH_DEBOUNCE_MS)
    }
    const onOfficePreview = (rawEvent: Event): void => {
      const event = rawEvent as CustomEvent<LiveOfficePreviewDetail>
      const detail = event.detail
      if (!detail || !targetMatchesEvent(readTarget, workspaceRoot, detail)) return
      if (detail.phase === 'editing') {
        setAgentEditing(true)
        return
      }
      setAgentEditing(false)
      if (detail.phase === 'committed') scheduleRefresh(detail.expectedSha256)
    }
    const removeLiveOfficeListener = (): void => {
      window.removeEventListener(LIVE_OFFICE_PREVIEW_EVENT, onOfficePreview)
    }
    const removeWatchListener = window.kunGui.onWorkspaceFileChanged((event) => {
      if (!watchId || event.watchId !== watchId) return
      if (!event.ok) {
        setRefreshError(event.message)
        return
      }
      scheduleRefresh()
    })
    window.addEventListener(LIVE_OFFICE_PREVIEW_EVENT, onOfficePreview)
    void renderLatest()
    void window.kunGui.watchWorkspaceFile({
      path: readTarget.path,
      workspaceRoot: readTarget.workspaceRoot,
      mode: 'signal'
    }).then((watch) => {
      if (disposed) {
        if (watch.ok) void window.kunGui.unwatchWorkspaceFile(watch.watchId)
        return
      }
      if (!watch.ok) {
        setRefreshError(watch.message)
        return
      }
      watchId = watch.watchId
      // The file can be atomically replaced between the initial render and the
      // watcher registration. Queue one trailing refresh to close that gap.
      scheduleRefresh()
    }).catch((error) => {
      if (!disposed) setRefreshError(error instanceof Error ? error.message : String(error))
    })

    const latest = latestLiveOfficePreview(readTarget.path, readTarget.workspaceRoot)
    if (latest && targetMatchesEvent(readTarget, workspaceRoot, latest)) {
      if (latest.phase === 'editing') setAgentEditing(true)
      else if (latest.phase === 'committed') scheduleRefresh(latest.expectedSha256)
    }

    return () => {
      disposed = true
      requestIdRef.current += 1
      clearRefreshTimer()
      removeLiveOfficeListener()
      removeWatchListener()
      if (watchId) void window.kunGui.unwatchWorkspaceFile(watchId)
    }
  }, [enabled, page, sheetIndex, target, workspaceRoot])

  useEffect(() => {
    if (!officeResult?.ok || !officeResult.pageCount) return
    setPage((current) => Math.min(current, officeResult.pageCount ?? current))
    if (officeResult.sheetNames?.length) {
      setSheetIndex((current) => Math.min(current, officeResult.sheetNames?.length ?? current))
    }
  }, [officeResult])

  return {
    officeResult,
    officeLoading: loading,
    officeAgentEditing: agentEditing,
    officeRefreshError: refreshError,
    officeNavigation: { page, sheetIndex },
    setOfficePreviewPage: (nextPage: number) => setPage(Math.max(1, Math.floor(nextPage))),
    setOfficePreviewSheet: (nextSheetIndex: number) => setSheetIndex(Math.max(0, Math.floor(nextSheetIndex)))
  }
}
