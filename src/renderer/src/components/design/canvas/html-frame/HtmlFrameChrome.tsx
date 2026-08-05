import { Check, Monitor, PenLine } from 'lucide-react'
import type { DesignRuntimeQualityPayload } from '../../../../design/design-html-quality'
import { HtmlFrameQualityControl } from './HtmlFrameQualityControl'
import type { DesignHtmlQualityFinding } from '../../../../design/design-html-quality'

type HtmlFrameChromeProps = {
  active: boolean
  artifactId?: string
  artifactRelativePath?: string
  chromeOffset: number
  drawingActive: boolean
  editing: boolean
  failedMessage: string
  interactive: boolean
  previewWebviewUrl: string
  qualityChecked: boolean
  qualityDetailsOpen: boolean
  qualityFindings: DesignHtmlQualityFinding[]
  screenWidth: number
  shapeId: string
  shapeName: string
  onQualityDetailsOpenChange: React.Dispatch<React.SetStateAction<boolean>>
  onRequestQualityRepair?: (payload: DesignRuntimeQualityPayload) => void
  onToggleModify: (shapeId: string) => void
  readOnly?: boolean
}

export function HtmlFrameChrome({
  active,
  artifactId,
  artifactRelativePath,
  chromeOffset,
  drawingActive,
  editing,
  failedMessage,
  interactive,
  previewWebviewUrl,
  qualityChecked,
  qualityDetailsOpen,
  qualityFindings,
  screenWidth,
  shapeId,
  shapeName,
  readOnly,
  onQualityDetailsOpenChange,
  onRequestQualityRepair,
  onToggleModify
}: HtmlFrameChromeProps): React.JSX.Element {
  return (
    <div
      className="pointer-events-none absolute left-0 right-0 z-20 flex items-center justify-between gap-2 text-[#7b8493] dark:text-[#9aa3b2]"
      style={{
        top: -chromeOffset,
        height: chromeOffset - 4,
        fontSize: Math.min(12, Math.max(10, screenWidth * 0.018))
      }}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Monitor className="h-3.5 w-3.5 shrink-0" strokeWidth={1.7} />
        <span className="min-w-0 truncate font-medium">{shapeName}</span>
      </div>
      {active && !interactive && !drawingActive && !failedMessage ? (
        <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
          <HtmlFrameQualityControl
            available={Boolean(previewWebviewUrl && screenWidth > 220)}
            open={qualityDetailsOpen}
            onOpenChange={onQualityDetailsOpenChange}
            screenWidth={screenWidth}
            artifactId={artifactId}
            artifactRelativePath={artifactRelativePath}
            shapeId={shapeId}
            qualityChecked={qualityChecked}
            qualityFindings={qualityFindings}
            onRequestQualityRepair={onRequestQualityRepair}
          />
          {previewWebviewUrl && screenWidth > 170 && !readOnly ? (
            <>
              {editing ? (
                <span className="rounded-full border border-accent/30 bg-white/88 px-2 py-1 text-[10.5px] font-medium text-accent shadow-sm backdrop-blur-md dark:border-accent/45 dark:bg-[#20252e] dark:text-[#aeb8ff]">
                  点击文字进行修改
                </span>
              ) : null}
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleModify(shapeId)
                }}
                title={editing ? '完成修改' : '修改内容'}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-semibold shadow-[0_10px_30px_rgba(20,47,95,0.12)] backdrop-blur-md transition ${
                  editing
                    ? 'border-accent bg-accent text-white hover:opacity-90'
                    : 'border-ds-border bg-white/90 text-[#273142] hover:bg-white dark:border-white/15 dark:bg-[#20252e] dark:text-white/90 dark:hover:bg-[#2a303b]'
                }`}
              >
                {editing ? (
                  <Check className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                ) : (
                  <PenLine className="h-3.5 w-3.5" strokeWidth={1.9} aria-hidden="true" />
                )}
                {editing ? '完成' : '修改'}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
