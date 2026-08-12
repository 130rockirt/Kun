import { useEffect, useRef, useState } from 'react'
import type { WorkspaceFileTarget } from '@shared/workspace-file'
import type { WorkspaceOfficePreviewResult } from '@shared/office-document'
import { workspaceFileTargetKey } from '../lib/workspace-file-target-key'
import {
  startWorkspaceOfficePreviewController
} from '../lib/workspace-office-preview-controller'

type UseWorkspaceOfficePreviewOptions = {
  target: WorkspaceFileTarget | null
  workspaceRoot: string
  enabled: boolean
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
    }

    return startWorkspaceOfficePreviewController({
      api: window.kunGui,
      path: readTarget.path,
      workspaceRoot: readTarget.workspaceRoot,
      callbacks: {
        onLoading: setLoading,
        onAgentEditing: setAgentEditing,
        onPreview: (next) => {
          officeResultRef.current = next
          setOfficeResult(next)
        },
        onFailure: (failure) => {
          if (officeResultRef.current?.ok) return
          officeResultRef.current = failure
          setOfficeResult(failure)
        },
        onRefreshError: (message) => {
          if (message && !officeResultRef.current?.ok) {
            const failure = { ok: false as const, message }
            officeResultRef.current = failure
            setOfficeResult(failure)
          }
          setRefreshError(message)
        }
      }
    })
  }, [enabled, target, workspaceRoot])

  return {
    officeResult,
    officeLoading: loading,
    officeAgentEditing: agentEditing,
    officeRefreshError: refreshError
  }
}
