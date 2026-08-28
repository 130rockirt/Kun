import {
  Suspense,
  type CSSProperties,
  type Dispatch,
  type MutableRefObject,
  type ReactElement,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  type UIEvent as ReactUIEvent
} from 'react'
import { FileCode2, Loader2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  WorkspaceFileReadResult,
  WorkspaceFileTarget,
  WorkspaceImageReadResult,
  WorkspacePdfReadResult,
  WorkspacePreviewLeaseResult
} from '@shared/workspace-file'
import type { OfficeSessionDescriptor, WorkspaceOfficePreviewResult } from '@shared/office-document'
import { workspaceFilePreviewKind } from '../lib/workspace-text-preview'
import {
  ResolvedPreviewImage,
  WorkspacePdfViewer,
  markdownRehypePlugins,
  type CachedTextDraft
} from './workspace-file-preview-support'
import { WorkspaceOfficePreview } from './WorkspaceOfficePreview'
import type { WpsOfficeSdkBridge } from './WpsOfficeEditor'
import { attachWorkspaceDocumentQuote } from '../lib/attach-workspace-document-quote'

type Translate = (key: string, values?: Record<string, unknown>) => string
type PreviewKind = ReturnType<typeof workspaceFilePreviewKind>

type WorkspaceFilePreviewBodyProps = {
  t: Translate
  target: WorkspaceFileTarget | null
  loading: boolean
  imageResult: WorkspaceImageReadResult | null
  pdfResult: WorkspacePdfReadResult | null
  officeResult: WorkspaceOfficePreviewResult | null
  officeAgentEditing: boolean
  officeRefreshError: string | null
  officeProviderMode?: 'local' | 'wps'
  wpsOfficeSession?: OfficeSessionDescriptor | null
  wpsOfficeSdk?: WpsOfficeSdkBridge
  previewLease: WorkspacePreviewLeaseResult | null
  previewKind: PreviewKind
  currentFileName: string
  workspaceRoot: string
  scrollRef: RefObject<HTMLDivElement | null>
  handlePreviewScroll: (event: ReactUIEvent<HTMLDivElement>) => void
  result: WorkspaceFileReadResult | null
  textSaveError: string | null
  setTextSaveError: Dispatch<SetStateAction<string | null>>
  diskConflict: boolean
  reloadText: () => Promise<unknown>
  saveText: (force?: boolean) => Promise<unknown>
  setDiskConflict: Dispatch<SetStateAction<boolean>>
  editingText: boolean
  textDraft: string
  setTextDraft: Dispatch<SetStateAction<string>>
  textDraftsRef: MutableRefObject<Map<string, CachedTextDraft>>
  activeTargetKey: string
  setDirtyTargetKeys: Dispatch<SetStateAction<Set<string>>>
  isHtmlFile: boolean
  htmlRendered: boolean
  isSvgFile: boolean
  svgRendered: boolean
  svgDataUrl: string
  isMarkdownFile: boolean
  markdownRendered: boolean
  codeSurfaceStyle?: CSSProperties
  activeLine: number | null
  lines: string[]
  highlightHtml: string
}

export function WorkspaceFilePreviewBody(props: WorkspaceFilePreviewBodyProps): ReactElement {
  const {
    t,
    target,
    loading,
    imageResult,
    pdfResult,
    officeResult,
    officeAgentEditing,
    officeRefreshError,
    officeProviderMode = 'local',
    wpsOfficeSession,
    wpsOfficeSdk,
    previewLease,
    previewKind,
    currentFileName,
    workspaceRoot,
    scrollRef,
    handlePreviewScroll,
    result,
    textSaveError,
    setTextSaveError,
    diskConflict,
    reloadText,
    saveText,
    setDiskConflict,
    editingText,
    textDraft,
    setTextDraft,
    textDraftsRef,
    activeTargetKey,
    setDirtyTargetKeys,
    isHtmlFile,
    htmlRendered,
    isSvgFile,
    svgRendered,
    svgDataUrl,
    isMarkdownFile,
    markdownRendered,
    codeSurfaceStyle,
    activeLine,
    lines,
    highlightHtml
  } = props
  return (
      <div className="flex min-h-0 flex-1 flex-col">
        {!target ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] leading-6 text-ds-muted">
            <div className="flex flex-col items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-ds-border-muted text-ds-faint">
                <FileCode2 className="h-5 w-5" strokeWidth={1.7} />
              </div>
              {t('filePreviewEmpty')}
            </div>
          </div>
        ) : loading && !officeResult?.ok ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-[12px] text-ds-muted">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.8} />
            {t('filePreviewLoading')}
          </div>
        ) : imageResult?.ok ? (
          <div
            ref={scrollRef}
            onScroll={handlePreviewScroll}
            className="ds-file-preview-image min-h-0 flex-1 overflow-auto p-5"
          >
            <img
              src={imageResult.dataUrl}
              alt={currentFileName}
              className="block h-full min-h-[120px] w-full object-contain"
            />
          </div>
        ) : pdfResult?.ok ? (
          <div className="min-h-0 flex-1 overflow-hidden">
            <Suspense
              fallback={(
                <div className="flex h-full items-center justify-center gap-2 text-[12px] text-ds-muted">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('filePreviewLoading')}
                </div>
              )}
            >
              <WorkspacePdfViewer
                filePath={pdfResult.path}
                dataBase64={pdfResult.dataBase64}
                size={pdfResult.size}
                mtimeMs={pdfResult.mtimeMs}
                workspaceRoot={target.workspaceRoot ?? workspaceRoot}
                onSelectionChange={() => undefined}
              />
            </Suspense>
          </div>
        ) : officeResult?.ok ? (
          <WorkspaceOfficePreview
            result={officeResult}
            loading={loading || officeAgentEditing}
            refreshError={officeRefreshError}
            providerMode={officeProviderMode}
            wpsSession={wpsOfficeSession}
            wpsSdk={wpsOfficeSdk}
            onQuoteSelection={(draft) => attachWorkspaceDocumentQuote({
              workspaceRoot: target.workspaceRoot ?? workspaceRoot,
              draft
            })}
          />
        ) : previewLease?.ok && previewKind === 'audio' ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <div className="w-full max-w-xl rounded-xl border border-ds-border-muted bg-ds-card p-5 shadow-sm">
              <div className="mb-4 text-[13px] font-semibold text-ds-ink">{currentFileName}</div>
              <audio className="w-full" controls preload="metadata" src={previewLease.url}>
                {t('filePreviewMediaUnsupported', { defaultValue: 'This media codec is not supported.' })}
              </audio>
            </div>
          </div>
        ) : previewLease?.ok && previewKind === 'video' ? (
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/90 p-4">
            <video
              className="max-h-full max-w-full rounded-lg"
              controls
              preload="metadata"
              src={previewLease.url}
            >
              {t('filePreviewMediaUnsupported', { defaultValue: 'This media codec is not supported.' })}
            </video>
          </div>
        ) : result?.ok ? (
          <div className="relative flex min-h-0 flex-1 flex-col">
            {result.truncated ? (
              <div className="shrink-0 border-b border-ds-border-muted/70 px-4 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                {t('filePreviewTruncated')}
              </div>
            ) : null}
            {textSaveError ? (
              <div className="shrink-0 border-b border-red-200/70 px-4 py-1.5 text-[11px] text-red-700 dark:border-red-900/60 dark:text-red-300">
                {textSaveError}
              </div>
            ) : null}
            {diskConflict ? (
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-300/60 bg-amber-50/80 px-4 py-2 text-[11px] text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-100">
                <span className="mr-auto">
                  {t('filePreviewDiskConflict', {
                    defaultValue: 'This file changed on disk after it was opened.'
                  })}
                </span>
                <button type="button" className="rounded-md px-2 py-1 hover:bg-black/5 dark:hover:bg-white/10" onClick={() => void reloadText()}>
                  {t('filePreviewReloadDisk', { defaultValue: 'Reload' })}
                </button>
                <button type="button" className="rounded-md px-2 py-1 font-semibold hover:bg-black/5 dark:hover:bg-white/10" onClick={() => void saveText(true)}>
                  {t('filePreviewOverwriteDisk', { defaultValue: 'Overwrite' })}
                </button>
                <button type="button" className="rounded-md px-2 py-1 hover:bg-black/5 dark:hover:bg-white/10" onClick={() => setDiskConflict(false)}>
                  {t('cancel')}
                </button>
              </div>
            ) : null}
            {editingText ? (
              <textarea
                value={textDraft}
                readOnly={result.truncated}
                spellCheck={false}
                aria-label={t('filePreviewEditText', { defaultValue: 'Edit file' })}
                className="min-h-0 flex-1 resize-none border-0 bg-transparent p-4 font-mono text-[12px] leading-[22px] text-ds-ink outline-none"
                onChange={(event) => {
                  const content = event.target.value
                  setTextDraft(content)
                  if (content === result.content) {
                    textDraftsRef.current.delete(activeTargetKey)
                    setDirtyTargetKeys((current) => {
                      const updated = new Set(current)
                      updated.delete(activeTargetKey)
                      return updated
                    })
                  } else {
                    textDraftsRef.current.set(activeTargetKey, {
                      content,
                      baseContent: result.content,
                      mtimeMs: result.mtimeMs
                    })
                    setDirtyTargetKeys((current) => new Set(current).add(activeTargetKey))
                  }
                  setTextSaveError(null)
                  setDiskConflict(false)
                }}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                    event.preventDefault()
                    void saveText()
                  }
                }}
              />
            ) : isHtmlFile && htmlRendered && previewLease?.ok && !result.truncated ? (
              <iframe
                title={currentFileName}
                src={previewLease.url}
                sandbox=""
                referrerPolicy="no-referrer"
                className="min-h-0 flex-1 border-0 bg-white"
              />
            ) : isSvgFile && svgRendered && !result.truncated ? (
              <div
                ref={scrollRef}
                onScroll={handlePreviewScroll}
                className="ds-file-preview-svg min-h-0 flex-1 overflow-auto p-5"
              >
                <img
                  src={svgDataUrl}
                  alt={currentFileName}
                  className="block h-full min-h-[120px] w-full object-contain"
                />
              </div>
            ) : isMarkdownFile && markdownRendered ? (
              <div
                ref={scrollRef}
                onScroll={handlePreviewScroll}
                className="ds-file-preview-markdown min-h-0 flex-1 overflow-auto px-5 py-4"
              >
                <div className="ds-markdown min-h-full text-ds-ink">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={markdownRehypePlugins}
                    components={{
                      a: ({ href, children, ...props }): ReactNode => (
                        <a
                          {...props}
                          href={href}
                          onClick={(event) => {
                            if (!href) return
                            event.preventDefault()
                            void window.kunGui?.openExternal?.(href)?.catch(() => undefined)
                          }}
                        >
                          {children}
                        </a>
                      ),
                      img: ({ src, alt, ...props }): ReactNode => (
                        <ResolvedPreviewImage
                          {...props}
                          src={src}
                          alt={alt}
                          filePath={result.path}
                        />
                      )
                    }}
                  >
                    {result.content}
                  </ReactMarkdown>
                </div>
              </div>
            ) : (
              <div
                ref={scrollRef}
                onScroll={handlePreviewScroll}
                className="ds-file-preview-scroll min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-[22px] text-ds-ink"
              >
                <div
                  className="ds-file-preview-code-surface"
                  style={codeSurfaceStyle}
                >
                  {activeLine ? (
                    <div className="ds-file-preview-active-line" aria-hidden="true" />
                  ) : null}
                  <div className="ds-file-preview-gutter">
                    {lines.map((_, index) => {
                      const lineNo = index + 1
                      return (
                        <div
                          key={lineNo}
                          data-line={lineNo}
                          className={`ds-file-preview-line-number ${activeLine === lineNo ? 'is-active' : ''}`}
                        >
                          {lineNo}
                        </div>
                      )
                    })}
                  </div>
                  <div
                    className="ds-file-preview-code-html"
                    dangerouslySetInnerHTML={{ __html: highlightHtml }}
                  />
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] leading-6 text-red-700 dark:text-red-300">
            {imageResult?.message ??
              pdfResult?.message ??
              officeResult?.message ??
              (previewLease && !previewLease.ok ? previewLease.message : undefined) ??
              result?.message ??
              t('filePreviewFailed')}
          </div>
        )}
      </div>
  )
}
