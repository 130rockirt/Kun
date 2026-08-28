import { AlertTriangle, Cloud, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import type {
  OfficeSessionDescriptor,
  WorkspaceOfficePreviewSuccess,
  WorkspaceOfficeSelection
} from '@shared/office-document'

export type WpsOfficeSdkInstance = {
  destroy: () => Promise<void> | void
}

export type WpsOfficeSdkBridge = {
  mount: (input: {
    mount: HTMLElement
    session: OfficeSessionDescriptor
    readOnly: boolean
    onSelectionChange?: (selection: WorkspaceOfficeSelection) => void
  }) => Promise<WpsOfficeSdkInstance>
}

type Props = {
  result: WorkspaceOfficePreviewSuccess
  session?: OfficeSessionDescriptor | null
  sdk?: WpsOfficeSdkBridge
  readOnly?: boolean
  loading?: boolean
  error?: string | null
  onSelectionChange?: (selection: WorkspaceOfficeSelection) => void
}

/**
 * The only GUI boundary for WPS Word, Sheet, and Slide.
 *
 * The SDK bridge is injected only after a fixed, reviewed WebOfficeSDK package
 * is bundled. Until both that bridge and a short-lived session exist, this
 * component fails closed instead of rendering Office bytes with a local engine.
 */
export function WpsOfficeEditor({
  result,
  session,
  sdk,
  readOnly = true,
  loading = false,
  error,
  onSelectionChange
}: Props): ReactElement {
  const mountRef = useRef<HTMLDivElement>(null)
  const [mountError, setMountError] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  const expiresAtMs = session ? Date.parse(session.expiresAt) : Number.NaN
  const initiallyExpired = Boolean(session) && (
    !Number.isFinite(expiresAtMs) || expiresAtMs - Date.now() <= 30_000
  )
  const [expired, setExpired] = useState(initiallyExpired)

  useEffect(() => {
    if (!session) {
      setExpired(false)
      return
    }
    const expiresAt = expiresAtMs
    const delay = expiresAt - Date.now() - 30_000
    if (!Number.isFinite(expiresAt) || delay <= 0) {
      setExpired(true)
      return
    }
    setExpired(false)
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined
    const scheduleExpiryCheck = (): void => {
      const remaining = expiresAt - Date.now() - 30_000
      if (remaining <= 0) {
        setExpired(true)
        return
      }
      timer = globalThis.setTimeout(scheduleExpiryCheck, Math.min(remaining, 2_147_483_647))
    }
    scheduleExpiryCheck()
    return () => {
      if (timer !== undefined) globalThis.clearTimeout(timer)
    }
  }, [expiresAtMs, session])

  const activeSession = error || expired || initiallyExpired ? null : session

  useEffect(() => {
    const mount = mountRef.current
    if (!mount || !activeSession || !sdk) {
      setMounted(false)
      return
    }
    let disposed = false
    let instance: WpsOfficeSdkInstance | undefined
    setMountError(null)
    void sdk.mount({ mount, session: activeSession, readOnly, onSelectionChange })
      .then((created) => {
        if (disposed) {
          void safelyDestroy(created)
          return
        }
        instance = created
        setMounted(true)
      })
      .catch(() => {
        if (!disposed) setMountError('WPS WebOffice SDK could not be opened.')
      })
    return () => {
      disposed = true
      setMounted(false)
      void safelyDestroy(instance)
      mount.replaceChildren()
    }
  }, [activeSession, onSelectionChange, readOnly, sdk])

  const unavailable = error || mountError || (expired || initiallyExpired
    ? 'The WPS Office session expired before it could be refreshed.'
    : !session
    ? 'WPS cloud Office is not configured for this workspace.'
    : !sdk
      ? 'The reviewed WPS WebOffice SDK package is not installed.'
      : null)

  return (
    <section
      className="relative flex min-h-0 flex-1 flex-col bg-ds-surface-subtle"
      aria-label={`WPS Office: ${result.name}`}
      data-office-provider="wps"
      data-office-viewer={result.viewer}
    >
      <header className="flex min-h-10 shrink-0 items-center gap-2 border-b border-ds-border-muted bg-ds-card px-3 text-[12px] text-ds-muted">
        <Cloud className="h-4 w-4 text-accent" aria-hidden="true" />
        <span className="min-w-0 truncate font-medium text-ds-ink">{result.name}</span>
        <span className="ml-auto rounded-full border border-ds-border-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
          WPS {readOnly ? 'View' : 'Edit'}
        </span>
      </header>
      <div ref={mountRef} className="min-h-0 flex-1" hidden={!mounted} />
      {!mounted ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="max-w-md text-center">
            {loading && !unavailable ? (
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-accent motion-reduce:animate-none" aria-hidden="true" />
            ) : (
              <AlertTriangle className="mx-auto h-6 w-6 text-amber-600 dark:text-amber-300" aria-hidden="true" />
            )}
            <h2 className="mt-3 text-[15px] font-semibold leading-6 text-ds-ink">
              {loading && !unavailable ? 'Opening in WPS Office' : 'WPS Office unavailable'}
            </h2>
            <p className="mt-1 text-[12.5px] leading-5 text-ds-muted">
              {unavailable || 'Uploading the document and creating a short-lived WPS session…'}
            </p>
            <p className="mt-3 text-[11px] leading-5 text-ds-faint">
              This file is not rendered by a local Office engine and no local fallback is used.
            </p>
          </div>
        </div>
      ) : null}
    </section>
  )
}

async function safelyDestroy(instance: WpsOfficeSdkInstance | undefined): Promise<void> {
  try {
    await instance?.destroy()
  } catch {
    // Teardown is best-effort; never surface SDK internals or session tokens.
  }
}
