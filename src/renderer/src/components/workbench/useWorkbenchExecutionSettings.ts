import { useCallback, useEffect, useState } from 'react'
import type {
  ApprovalPolicy,
  ApprovalReviewer,
  SandboxMode
} from '@shared/app-settings'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import type { ComposerExecutionSettings } from '../chat/FloatingComposer'

type UseWorkbenchExecutionSettingsInput = {
  setError: (message: string | null) => void
  onSettingsUpdated: () => void
}

export function useWorkbenchExecutionSettings({
  setError,
  onSettingsUpdated
}: UseWorkbenchExecutionSettingsInput) {
  const [composerExecutionSettings, setComposerExecutionSettings] =
    useState<ComposerExecutionSettings | null>(null)
  const [composerExecutionApplying, setComposerExecutionApplying] = useState(false)

  useEffect(() => {
    let cancelled = false
    void rendererRuntimeClient.getSettings()
      .then((settings) => {
        if (cancelled) return
        setComposerExecutionSettings({
          approvalPolicy: settings.agents.kun.approvalPolicy,
          sandboxMode: settings.agents.kun.sandboxMode,
          approvalReviewer: settings.agents.kun.approvalReviewer
        })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const updateComposerExecutionSettings = useCallback((patch: Partial<ComposerExecutionSettings>): void => {
    if (!composerExecutionSettings || composerExecutionApplying) return
    const previous = composerExecutionSettings
    const next = { ...previous, ...patch }
    setComposerExecutionSettings(next)
    setComposerExecutionApplying(true)
    void rendererRuntimeClient.setSettings({
      agents: {
        kun: {
          ...(patch.approvalPolicy ? { approvalPolicy: patch.approvalPolicy as ApprovalPolicy } : {}),
          ...(patch.sandboxMode ? { sandboxMode: patch.sandboxMode as SandboxMode } : {}),
          ...(patch.approvalReviewer
            ? { approvalReviewer: patch.approvalReviewer as ApprovalReviewer }
            : {})
        }
      }
    }).then((settings) => {
      setComposerExecutionSettings({
        approvalPolicy: settings.agents.kun.approvalPolicy,
        sandboxMode: settings.agents.kun.sandboxMode,
        approvalReviewer: settings.agents.kun.approvalReviewer
      })
      onSettingsUpdated()
    }).catch((error: unknown) => {
      setComposerExecutionSettings(previous)
      setError(error instanceof Error ? error.message : String(error))
    }).finally(() => setComposerExecutionApplying(false))
  }, [composerExecutionApplying, composerExecutionSettings, onSettingsUpdated, setError])

  return {
    composerExecutionSettings,
    composerExecutionApplying,
    updateComposerExecutionSettings
  }
}
