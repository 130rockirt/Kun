import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { ClipboardCopy, LoaderCircle, X } from 'lucide-react'

type Props = {
  daemonName: string
  daemonId: string
  logPath: string
  onClose: () => void
}

const POLL_INTERVAL_MS = 2_000

/**
 * Right-side drawer that tails a daemon's log file. Polls only while open and
 * requests incremental pages via `readDaemonLogs(id, { cursor })`.
 */
export function DaemonLogDrawer({ daemonName, daemonId, logPath, onClose }: Props): ReactElement {
  const { t } = useTranslation('common')
  const [lines, setLines] = useState<string[]>([])
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [eof, setEof] = useState(true)
  const [loading, setLoading] = useState(true)
  const cursorRef = useRef<string | undefined>(undefined)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    const poll = async (): Promise<void> => {
      if (typeof window.kunGui?.readDaemonLogs !== 'function') return
      try {
        const page = await window.kunGui.readDaemonLogs({
          id: daemonId,
          cursor: cursorRef.current,
          limit: 200
        })
        if (cancelled) return
        setLines((current) =>
          cursorRef.current ? [...current, ...page.lines] : page.lines
        )
        setCursor(page.nextCursor)
        setEof(page.eof)
        cursorRef.current = page.nextCursor
        setLoading(false)
        const body = bodyRef.current
        if (body) body.scrollTop = body.scrollHeight
      } catch {
        if (!cancelled) setLoading(false)
      }
    }
    void poll()
    const id = window.setInterval(() => void poll(), POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [daemonId])

  const copyLogs = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <aside
      role="dialog"
      aria-label={t('daemonLogTitle', { name: daemonName })}
      className="fixed right-0 top-0 z-[120] flex h-full w-[min(460px,100vw)] flex-col bg-[#181818] text-white shadow-[-18px_0_52px_rgba(0,0,0,0.24)] dark:border-l dark:border-white/10"
    >
      <div className="flex h-[58px] shrink-0 items-center justify-between border-b border-white/10 px-5">
        <strong className="min-w-0 truncate text-[13px] font-semibold">
          {t('daemonLogTitle', { name: daemonName })}
        </strong>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#c7c7c7] transition hover:bg-white/10 hover:text-white"
          aria-label={t('close')}
          title={t('close')}
        >
          <X className="h-4 w-4" strokeWidth={1.7} />
        </button>
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.08] px-5 py-2.5 text-[11px] text-[#858585]">
        <span className="min-w-0 truncate" title={logPath}>{logPath}</span>
        <span className="shrink-0">{t('daemonLogHint')}</span>
      </div>
      <div
        ref={bodyRef}
        className="min-h-0 flex-1 overflow-auto px-5 py-4 font-mono text-[11.5px] leading-[20px] whitespace-pre-wrap text-[#c7c7c7]"
      >
        {loading ? (
          <div className="flex items-center gap-2 text-[#858585]">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} />
            {t('loading')}
          </div>
        ) : lines.length === 0 ? (
          <div className="text-[#858585]">{t('daemonLogEmpty')}</div>
        ) : (
          lines.map((line, index) => <div key={`${cursor ?? 'head'}-${index}`}>{line}</div>)
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-white/[0.08] px-5 py-3 text-[11px] text-[#858585]">
        <span>{eof ? t('daemonLogReadonly') : t('daemonLogLive')}</span>
        <button
          type="button"
          onClick={() => void copyLogs()}
          disabled={lines.length === 0}
          className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[11.5px] font-medium text-[#c7c7c7] transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
        >
          <ClipboardCopy className="h-3.5 w-3.5" strokeWidth={1.8} />
          {t('copy')}
        </button>
      </div>
    </aside>
  )
}
