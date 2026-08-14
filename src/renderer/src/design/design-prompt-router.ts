import type { AttachmentReference } from '../agent/types'
import { shouldRouteDesignPromptToMultiPage } from './design-pages-gate'
import type { DesignWorkspaceState } from './design-workspace-store-types'

type RouterDesignState = Pick<
  DesignWorkspaceState,
  | 'workspaceRoot'
  | 'artifacts'
  | 'activeArtifactId'
  | 'designIntentMode'
  | 'multiPageMode'
  | 'pagesRun'
>

export type DesignPromptRouterOptions = {
  value: string
  displayText?: string
  attachments: AttachmentReference[]
  attachmentUploadEnabled: boolean
  designState: RouterDesignState
  fallbackWorkspaceRoot?: string | null
  selectedCount: number
  imageOnlyDisplay: string
  imageOnlyPrompt: string
  allowMultiPage?: boolean
}

export type DesignPromptRoute =
  | { kind: 'ignore' }
  | { kind: 'attachment-unsupported' }
  | { kind: 'missing-workspace' }
  | { kind: 'multi-page'; brief: string; workspaceRoot: string }
  | {
      kind: 'single-turn'
      text: string
      promptText: string
      displayText: string
      workspaceRoot: string
      attachments: AttachmentReference[]
      attachmentIds: string[]
      shouldClearInput: boolean
    }

export function routeDesignPrompt(options: DesignPromptRouterOptions): DesignPromptRoute {
  const text = options.value.trim()
  const attachments = options.attachments
  const attachmentIds = attachments.map((attachment) => attachment.id)
  if (!text && attachmentIds.length === 0) return { kind: 'ignore' }
  if (attachmentIds.length > 0 && !options.attachmentUploadEnabled) {
    return { kind: 'attachment-unsupported' }
  }
  const workspaceRoot = options.designState.workspaceRoot || options.fallbackWorkspaceRoot?.trim() || ''
  if (!workspaceRoot) return { kind: 'missing-workspace' }

  const multiPageGate = shouldRouteDesignPromptToMultiPage({
    text,
    artifacts: options.designState.artifacts,
    activeArtifactId: options.designState.activeArtifactId,
    designIntentMode: options.designState.designIntentMode,
    multiPageMode: options.designState.multiPageMode,
    selectedCount: options.selectedCount,
    attachmentCount: attachmentIds.length,
    pagesRunActive: Boolean(options.designState.pagesRun)
  })
  if (options.allowMultiPage !== false && multiPageGate.route === 'multi-page') {
    return { kind: 'multi-page', brief: text, workspaceRoot }
  }

  return {
    kind: 'single-turn',
    text,
    promptText: text || options.imageOnlyPrompt,
    displayText: options.displayText?.trim() || text || options.imageOnlyDisplay,
    workspaceRoot,
    attachments,
    attachmentIds,
    shouldClearInput: !options.displayText
  }
}
