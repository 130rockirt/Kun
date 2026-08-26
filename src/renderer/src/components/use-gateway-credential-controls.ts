import type { ModelProviderSettingsV1 } from '@shared/app-settings'
import type { GatewayCredentialStatus } from '@shared/kun-gui-api'
import { useEffect, useState } from 'react'

export function useGatewayCredentialControls(
  settings: ModelProviderSettingsV1,
  onChange: (next: ModelProviderSettingsV1) => void,
  onError: (message: string) => void
): {
  credential: GatewayCredentialStatus
  pending: boolean
  update(action: 'ensure' | 'copy' | 'rotate' | 'revoke'): Promise<void>
  setEnabled(enabled: boolean): Promise<void>
} {
  const [credential, setCredential] = useState<GatewayCredentialStatus>({ configured: false })
  const [pending, setPending] = useState(false)

  const update = async (action: 'ensure' | 'copy' | 'rotate' | 'revoke'): Promise<void> => {
    setPending(true)
    onError('')
    try {
      const result = await window.kunGui.gatewayCredential(action)
      if (!result.ok) throw new Error(`Gateway credential ${action} failed (${result.status})`)
      setCredential(result.credential)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }

  const setEnabled = async (enabled: boolean): Promise<void> => {
    if (enabled && !credential.configured) {
      setPending(true)
      try {
        const result = await window.kunGui.gatewayCredential('ensure')
        if (!result.ok) throw new Error(`Gateway credential ensure failed (${result.status})`)
        setCredential(result.credential)
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error))
        return
      } finally {
        setPending(false)
      }
    }
    onChange({ ...settings, localGateway: { ...settings.localGateway, enabled } })
  }

  useEffect(() => {
    let mounted = true
    void window.kunGui.gatewayCredential('status').then((result) => {
      if (mounted && result.ok) setCredential(result.credential)
    }).catch(() => undefined)
    return () => { mounted = false }
  }, [])

  return { credential, pending, update, setEnabled }
}
