import {
  AccountSessionSchema
} from '@kun/extension-api'
import type {
  ExtensionRuntimeRequestResult
} from '../../shared/extension-ipc'
import type { RegisterExtensionIpcHandlersOptions } from './extension-ipc-handler-options'
import { isRecord, runtimeFailure, safeJsonParse } from './extension-ipc-common'

export async function presentProtectedAccountAuthorization(
  options: RegisterExtensionIpcHandlersOptions,
  result: ExtensionRuntimeRequestResult,
  extensionId: string,
  providerId: string
): Promise<ExtensionRuntimeRequestResult> {
  if (!result.ok) return result
  const payload = safeJsonParse(result.body)
  if (!isRecord(payload)) return result
  const parsed = AccountSessionSchema.safeParse(payload.session)
  if (!parsed.success || parsed.data.status !== 'pending' || !parsed.data.verificationUrl) {
    return result
  }
  const session = parsed.data
  const verificationUrl = session.verificationUrl!
  try {
    await options.credentialSurface.presentAuthorization(options.getMainWindow(), {
      title: 'Authorize provider account',
      message: `Complete authorization for ${providerId}.`,
      detail: `This protected Kun window is isolated from ${extensionId}, its Webviews, and host content scripts.`,
      verificationUrl,
      ...(session.userCode ? { userCode: session.userCode } : {}),
      ...(session.expiresAt ? { expiresAt: session.expiresAt } : {})
    })
  } catch (error) {
    await options.runtimeRequest(
      `/v1/extensions/accounts/sessions/${encodeURIComponent(session.id)}/cancel`,
      'POST',
      JSON.stringify({ extensionId })
    ).catch(() => undefined)
    options.logError?.('extension-account', 'Protected account authorization surface failed.', {
      extensionId,
      providerId,
      message: error instanceof Error ? error.message : String(error)
    })
    return runtimeFailure(
      'EXTENSION_PROTECTED_SURFACE_FAILED',
      'Kun could not present the protected account authorization window.',
      502
    )
  }
  return redactAccountSessionInteraction(result)
}

export function redactAccountSessionInteraction(
  result: ExtensionRuntimeRequestResult
): ExtensionRuntimeRequestResult {
  if (!result.ok) return result
  const payload = safeJsonParse(result.body)
  if (!isRecord(payload)) return result
  const parsed = AccountSessionSchema.safeParse(payload.session)
  if (!parsed.success) return result
  const {
    verificationUrl: _verificationUrl,
    userCode: _userCode,
    ...redactedSession
  } = parsed.data
  return { ...result, body: JSON.stringify({ ...payload, session: redactedSession }) }
}
