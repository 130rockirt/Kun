import { useEffect, useMemo, useState, type ReactElement } from 'react'
import {
  highlightCodeHtml,
  languageFromFilePath,
  renderFallbackCodeHtml
} from '../lib/code-highlighting'

type WorkspaceCodePreviewProps = {
  content: string
  path: string
  className?: string
  limitMessage?: string
}

export const WORKSPACE_CODE_PREVIEW_MAX_CHARS = 300_000
export const WORKSPACE_CODE_PREVIEW_MAX_LINES = 20_000

type CodePreviewSlice = {
  content: string
  lineCount: number
  limited: boolean
}

export function sliceWorkspaceCodePreview(content: string): CodePreviewSlice {
  let end = Math.min(content.length, WORKSPACE_CODE_PREVIEW_MAX_CHARS)
  let lineCount = 1
  for (let index = 0; index < end; index += 1) {
    if (content.charCodeAt(index) !== 10) continue
    lineCount += 1
    if (lineCount <= WORKSPACE_CODE_PREVIEW_MAX_LINES) continue
    end = index
    lineCount = WORKSPACE_CODE_PREVIEW_MAX_LINES
    break
  }
  return {
    content: content.slice(0, end),
    lineCount,
    limited: end < content.length
  }
}

export function WorkspaceCodePreview({
  content,
  path,
  className,
  limitMessage
}: WorkspaceCodePreviewProps): ReactElement {
  const language = useMemo(() => languageFromFilePath(path), [path])
  const preview = useMemo(() => sliceWorkspaceCodePreview(content), [content])
  const lineNumbers = useMemo(
    () => Array.from({ length: preview.lineCount }, (_, index) => index + 1).join('\n'),
    [preview.lineCount]
  )
  const [highlightHtml, setHighlightHtml] = useState(
    () => renderFallbackCodeHtml(preview.content)
  )

  useEffect(() => {
    let cancelled = false
    setHighlightHtml(renderFallbackCodeHtml(preview.content))

    void highlightCodeHtml(preview.content, language).then((html) => {
      if (!cancelled) setHighlightHtml(html)
    })

    return () => {
      cancelled = true
    }
  }, [language, preview.content])

  return (
    <div
      data-workspace-code-preview
      data-language={language || 'text'}
      data-preview-limited={preview.limited || undefined}
      className={`ds-file-preview-scroll min-h-0 min-w-0 overflow-auto font-mono text-[12px] leading-[22px] text-ds-ink ${className ?? ''}`}
    >
      {preview.limited && limitMessage ? (
        <div
          data-workspace-code-preview-limit
          className="sticky top-0 z-10 border-b border-amber-200/80 bg-amber-50/95 px-5 py-2.5 font-sans text-[12.5px] leading-5 text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/95 dark:text-amber-100"
        >
          {limitMessage}
        </div>
      ) : null}
      <div className="ds-file-preview-code-surface">
        <div className="ds-file-preview-gutter" aria-hidden="true">
          <pre className="ds-file-preview-line-numbers">{lineNumbers}</pre>
        </div>
        <div
          className="ds-file-preview-code-html"
          dangerouslySetInnerHTML={{ __html: highlightHtml }}
        />
      </div>
    </div>
  )
}
