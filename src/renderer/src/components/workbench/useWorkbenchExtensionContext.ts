import { useEffect, useMemo } from 'react'
import { workspaceRootScopeKey } from '../../lib/workspace-path'
import { resolveActiveExtensionWorkspaceRoot } from '../../extensions/active-extension-workspace'
import {
  useCommittedExtensionContributionLoadContext
} from '../../extensions/use-contributions'
import type { ExtensionContributionLoadContext } from '../../extensions/contribution-load-coordinator'
import type { useWorkbenchChatStoreState } from './useWorkbenchChatStoreState'

type WorkbenchState = ReturnType<typeof useWorkbenchChatStoreState>

type Params = {
  activeThreadId: string | null
  threads: WorkbenchState['threads']
  workspaceRoot: string
  route: WorkbenchState['route']
  language: string
  extensionComposerContexts: WorkbenchState['extensionComposerContexts']
  attachExtensionComposerContext: WorkbenchState['attachExtensionComposerContext']
}

export function useWorkbenchExtensionContext({
  activeThreadId,
  threads,
  workspaceRoot,
  route,
  language,
  extensionComposerContexts,
  attachExtensionComposerContext
}: Params) {
  const extensionWorkspaceRoot = useMemo(
    () => resolveActiveExtensionWorkspaceRoot(activeThreadId, threads, workspaceRoot),
    [activeThreadId, threads, workspaceRoot]
  )

  useEffect(() => {
    if (typeof window.kunGui?.onExtensionComposerContext !== 'function') return
    return window.kunGui.onExtensionComposerContext(attachExtensionComposerContext)
  }, [attachExtensionComposerContext])

  const activeComposerContextEvents = useMemo(() => {
    if (route !== 'chat') return []
    const workspace = workspaceRootScopeKey(extensionWorkspaceRoot)
    return extensionComposerContexts.filter((event) =>
      workspaceRootScopeKey(event.workspaceRoot) === workspace &&
      (!event.threadId || event.threadId === activeThreadId)
    )
  }, [activeThreadId, extensionComposerContexts, extensionWorkspaceRoot, route])

  const extensionComposerContextChips = useMemo(() => activeComposerContextEvents.map((event) => ({
    id: event.attachment.attachmentId,
    kind: ('source' in event.attachment.provenance && event.attachment.provenance.source === 'dev-preview'
      ? event.attachment.reference.kind === 'issue'
        ? 'dev-preview-issue'
        : 'dev-preview-element'
      : 'extension-context') as 'extension-context' | 'dev-preview-element' | 'dev-preview-issue',
    label: event.attachment.title,
    detail: event.attachment.summary,
    removable: true
  })), [activeComposerContextEvents])

  const selectedPreviewElementCount = useMemo(() => activeComposerContextEvents.filter((event) =>
    'source' in event.attachment.provenance &&
    event.attachment.provenance.source === 'dev-preview' &&
    event.attachment.reference.kind === 'element'
  ).length, [activeComposerContextEvents])

  const extensionContributionLoadContext = useMemo<ExtensionContributionLoadContext>(() => ({
    workspaceRoot: extensionWorkspaceRoot,
    locale: language
  }), [extensionWorkspaceRoot, language])
  const extensionContributionLoadContextRef =
    useCommittedExtensionContributionLoadContext(extensionContributionLoadContext)

  return {
    activeComposerContextEvents,
    extensionComposerContextChips,
    extensionContributionLoadContext,
    extensionContributionLoadContextRef,
    extensionWorkspaceRoot,
    selectedPreviewElementCount
  }
}
