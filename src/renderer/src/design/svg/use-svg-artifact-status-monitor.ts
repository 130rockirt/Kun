import { useEffect, useMemo, useRef } from 'react'
import type { KunGuiApi } from '@shared/kun-gui-api'
import type { DesignArtifact } from '../design-types'
import { useDesignWorkspaceStore } from '../design-workspace-store'
import { svgArtifactStatusForSource } from './svg-artifact-status'
export { svgArtifactStatusForSource } from './svg-artifact-status'

export type SvgArtifactStatusTarget = { id: string; relativePath: string }
type SvgArtifactStatusMonitorApi = Pick<KunGuiApi, 'readWorkspaceFile'> & Partial<
  Pick<KunGuiApi, 'watchWorkspaceFile' | 'unwatchWorkspaceFile' | 'onWorkspaceFileChanged'>
>

export function startSvgArtifactStatusMonitor(
  workspaceRoot: string,
  targets: readonly SvgArtifactStatusTarget[],
  api: SvgArtifactStatusMonitorApi | undefined = typeof window !== 'undefined' ? window.kunGui : undefined
): () => void {
  if (!workspaceRoot || targets.length === 0 || typeof api?.readWorkspaceFile !== 'function') {
    return () => undefined
  }
  let cancelled = false
  const watchTargets = new Map<string, SvgArtifactStatusTarget>()
  const watchIds: string[] = []
  const setStatus = (
    target: SvgArtifactStatusTarget,
    status: NonNullable<DesignArtifact['previewStatus']>
  ): void => {
    if (cancelled) return
    const current = useDesignWorkspaceStore.getState().artifacts.find((artifact) => artifact.id === target.id)
    if (current?.kind !== 'svg' || current.relativePath !== target.relativePath) return
    if (current.previewStatus === status) return
    useDesignWorkspaceStore.getState().setArtifactPreviewStatus(target.id, status)
  }
  const apply = (target: SvgArtifactStatusTarget, content: string): void => {
    setStatus(target, svgArtifactStatusForSource(content))
  }
  const load = async (target: SvgArtifactStatusTarget): Promise<void> => {
    const result = await api.readWorkspaceFile({ path: target.relativePath, workspaceRoot }).catch(() => null)
    if (cancelled) return
    if (!result?.ok || result.truncated) {
      setStatus(target, 'error')
      return
    }
    apply(target, result.content)
  }

  const offChanged = api.onWorkspaceFileChanged?.((payload) => {
    const target = watchTargets.get(payload.watchId)
    if (!target || cancelled) return
    if (payload.ok && !payload.truncated) apply(target, payload.content)
    else void load(target)
  })

  for (const target of targets) {
    if (api.watchWorkspaceFile && api.unwatchWorkspaceFile && api.onWorkspaceFileChanged) {
      void api.watchWorkspaceFile({ path: target.relativePath, workspaceRoot })
        .then((result) => {
          if (!result.ok) {
            void load(target)
            return
          }
          if (cancelled) {
            void api.unwatchWorkspaceFile?.(result.watchId).catch(() => undefined)
            return
          }
          watchIds.push(result.watchId)
          watchTargets.set(result.watchId, target)
          if (result.truncated) setStatus(target, 'error')
          else apply(target, result.content)
        })
        .catch(() => {
          void load(target)
        })
    } else {
      void load(target)
    }
  }

  return () => {
    cancelled = true
    offChanged?.()
    for (const watchId of watchIds) {
      void api.unwatchWorkspaceFile?.(watchId).catch(() => undefined)
    }
  }
}

/**
 * Tracks unfinished SVG artifacts independently from the viewport overlay. An
 * artifact can finish while it is off-screen (or outside the 24-preview mount
 * budget); its durable ready/error state must still advance so the next turn
 * creates a new version instead of reusing v1 in place.
 */
export function useSvgArtifactStatusMonitor(
  workspaceRoot: string,
  artifacts: readonly DesignArtifact[],
  enabled = true
): void {
  const targets = useMemo(
    () => artifacts
      .filter((artifact) => artifact.kind === 'svg' && artifact.previewStatus !== 'ready')
      .map((artifact) => ({ id: artifact.id, relativePath: artifact.relativePath })),
    [artifacts]
  )
  const targetKey = useMemo(
    () => targets.map((target) => `${target.id}:${target.relativePath}`).join('|'),
    [targets]
  )
  const targetsRef = useRef(targets)
  targetsRef.current = targets

  useEffect(
    () => enabled
      ? startSvgArtifactStatusMonitor(workspaceRoot, targetsRef.current)
      : undefined,
    [enabled, targetKey, workspaceRoot]
  )
}
