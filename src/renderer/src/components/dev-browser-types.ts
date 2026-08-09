import type { JsonObject } from '@kun/extension-api'
import type { ChatBlock } from '../agent/types'
import type { DevPreviewElementContext } from '@shared/dev-preview-context'
import type { DevPreviewCaptureResult } from '@shared/dev-preview-capture'

export type DevWebviewTag = HTMLElement & {
  canGoBack(): boolean
  canGoForward(): boolean
  executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>
  getURL(): string
  getWebContentsId(): number
  goBack(): void
  goForward(): void
  reloadIgnoringCache(): void
}

export type WebviewNavigateEvent = Event & { url: string }
export type WebviewFailLoadEvent = Event & {
  errorCode: number
  errorDescription: string
  isMainFrame: boolean
  validatedURL?: string
}
export type WebviewTitleEvent = Event & { title: string }
export type WebviewConsoleEvent = Event & {
  level: number | string
  message: string
  sourceId?: string
  line?: number
}

export type LoadOptions = { keepAutoFollow?: boolean }

export type DevPreviewContextDraft = {
  kind: 'element' | 'issue'
  title: string
  summary: string
  reference: JsonObject
  screenshot?: DevPreviewCaptureResult
}

export type DevBrowserPanelProps = {
  blocks: ChatBlock[]
  preferredUrl?: string | null
  workspaceRoot?: string
  activeThreadId?: string | null
  selectedElementCount?: number
  supportsImageCapture?: boolean
  className?: string
  onCollapse: () => void
  embedded?: boolean
  onTitleChange?: (title: string) => void
  onAttachContext?: (draft: DevPreviewContextDraft) => void | Promise<void>
  onDocumentChange?: () => void
}
