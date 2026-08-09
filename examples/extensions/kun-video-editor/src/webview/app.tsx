import { useEffect, useMemo, useRef, useState } from 'react'
import { artifactsForJobs, type EditorController } from './controller.js'
import { formatMessage, messagesFor } from './i18n.js'
import { GenerationPanel } from './generation-panel.js'
import { MediaIntelligencePanel } from './media-intelligence.js'
import { MulticamPanel } from './multicam-panel.js'
import {
  frameToSeconds,
  timelineSourceAtFrame
} from './model.js'
import {
  EmptyState,
  ResultPreviewWorkbench,
  Spinner,
  StatusNotice,
  artifactMatchesPlayback,
  canRender,
  formatTime,
  splitAtPlayhead,
  visibleProjectAssets
} from './app-common.js'
import {
  noticeMessage,
  syncDocumentPresentation,
  themeStyle
} from './app-presentation.js'
import {
  ProjectStatusStrip,
  SequenceNavigator,
  WorkbenchSectionTabs,
  WorkspaceDisclosure,
  multicamPanelMessages,
  useCompactSidebar
} from './app-shell.js'
import {
  DerivedMediaPanel,
  EmptyProject,
  InitializationRecovery,
  MediaLibrary,
  ProjectBar,
  TranscriptPanel
} from './app-project-panels.js'
import {
  AgentSyncPanel,
  CaptionPanel,
  InspectorPanel,
  MediaPlayer,
  PlayerControls,
  RevisionPanel,
  TimelinePanel
} from './app-timeline-panels.js'
import {
  ExportPanel,
  InterchangePanel,
  PreviewPanel,
  ProjectPackagePanel
} from './app-preview-panels.js'

export { noticeMessage, syncDocumentPresentation, themeStyle } from './app-presentation.js'
export { canImportMedia } from './app-common.js'
export { PreviewComparisonViewer } from './app-preview-panels.js'

export type VideoEditorWorkbenchProps = {
  controller: EditorController
}

export function VideoEditorWorkbench({ controller }: VideoEditorWorkbenchProps): React.JSX.Element {
  const { state } = controller
  const messages = useMemo(() => messagesFor(state.locale), [state.locale])
  const alertRef = useRef<HTMLDivElement>(null)
  const compactSidebar = useCompactSidebar()
  const activeSection = state.activeWorkspace
  const project = state.project
  const [previewExpanded, setPreviewExpanded] = useState(() =>
    Boolean(
      project &&
      project.durationFrames > 0 &&
      (!compactSidebar || (typeof window !== 'undefined' && window.innerWidth >= 540))
    )
  )
  const initializationFailed = !project && (
    state.connection === 'offline' ||
    state.notices.some(({ messageKey }) => messageKey === 'editorInitializeFailed')
  )
  const projectJobIds = new Set(
    state.renderTickets.filter(({ projectId }) => projectId === project?.id).map(({ jobId }) => jobId)
  )
  const projectJobs = state.jobs.filter(({ id }) => projectJobIds.has(id))
  const selectedItem = project?.items.find(({ id }) => id === state.selectedItemId)
  const selectedCaption = project?.captions.find(({ id }) => id === state.selectedCaptionId)
  const artifacts = useMemo(() => artifactsForJobs(projectJobs), [projectJobs])
  const activeArtifact = artifacts.find(({ mediaHandleId }) => mediaHandleId === state.activeMediaHandleId)
  const activeAsset = visibleProjectAssets(state).find(({ mediaHandleId }) => mediaHandleId === state.activeMediaHandleId)
  const timelineSource = project ? timelineSourceAtFrame(project, state.playheadFrame) : undefined
  const currentComposedArtifact = project && activeArtifact && artifactMatchesPlayback(
    activeArtifact,
    project,
    state.playheadFrame
  ) ? activeArtifact : undefined
  const sourceFastPath = project?.playback.mode === 'source-fast-path' &&
    project.playback.revision === project.currentRevision &&
    timelineSource?.asset.id === project.playback.sourceAssetId
  const openAsset = controller.openAsset

  useEffect(() => {
    if (state.notices.at(-1)?.severity === 'error') alertRef.current?.focus()
  }, [state.notices])

  useEffect(() => {
    syncDocumentPresentation(document.documentElement, state.theme, state.locale)
    document.title = messages.appName
  }, [messages.appName, state.locale, state.theme])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target.closest('button, input, select, textarea, a[href], summary, [contenteditable="true"], [role="button"], [role="tab"]')
      ) return
      if (event.key === ' ' && project) {
        event.preventDefault()
        controller.togglePlaying()
      } else if (event.key.toLowerCase() === 's' && selectedItem && project) {
        event.preventDefault()
        void splitAtPlayhead(controller, project, selectedItem, messages)
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedItem) {
        event.preventDefault()
        if (window.confirm(messages.deleteItemConfirm)) {
          void controller.applyOperations(
            [{ type: 'delete-item', itemId: selectedItem.id }],
            formatMessage(messages.deleteSummary, { id: selectedItem.id })
          )
        }
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        void (event.shiftKey ? controller.redo() : controller.undo())
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [controller, messages, project, selectedItem])

  useEffect(() => {
    if (
      !currentComposedArtifact &&
      sourceFastPath &&
      timelineSource?.asset.mediaHandleId &&
      timelineSource.asset.mediaHandleId !== state.activeMediaHandleId
    ) {
      void openAsset(timelineSource.asset.id)
    }
  }, [currentComposedArtifact, openAsset, sourceFastPath, state.activeMediaHandleId, timelineSource?.asset.id, timelineSource?.asset.mediaHandleId])

  if (state.resultPreview) {
    return <ResultPreviewWorkbench controller={controller} messages={messages} />
  }

  return (
    <div
      className="editor-app"
      data-theme={state.theme?.kind ?? 'dark'}
      data-reduced-motion={state.theme?.reducedMotion ? 'true' : 'false'}
      dir={state.locale?.direction ?? 'ltr'}
      lang={state.locale?.language ?? 'en'}
      style={themeStyle(state.theme)}
    >
      <a className="skip-link" href="#video-editor-main">{messages.skipEditor}</a>
      <ProjectBar controller={controller} messages={messages} />
      <div className="notice-stack" aria-live="polite" aria-relevant="additions">
        {state.connection === 'reconnecting' && <StatusNotice severity="warning">{messages.reconnecting}</StatusNotice>}
        {state.conflict && <StatusNotice severity="warning">{messages.conflict}</StatusNotice>}
        {state.notices.map((notice, index) => (
          <div
            className={`notice notice-${notice.severity}`}
            key={notice.id}
            role={notice.severity === 'error' ? 'alert' : 'status'}
            tabIndex={notice.severity === 'error' && index === state.notices.length - 1 ? -1 : undefined}
            ref={notice.severity === 'error' && index === state.notices.length - 1 ? alertRef : undefined}
          >
            <span>{noticeMessage(notice, messages)}</span>
            {notice.interactionRequired && <strong>{messages.interactionRequired}</strong>}
            {notice.capabilityDetails && notice.capabilityDetails.length > 0 && (
              <details className="notice-capability-details" open>
                <summary>{formatMessage(messages.renderCapabilityDetails, {
                  count: notice.capabilityDetails.length
                })}</summary>
                <ul>
                  {notice.capabilityDetails.map((detail) => (
                    <li key={`${detail.nodeId}:${detail.capability}`}>
                      <strong>{detail.nodeId}</strong>
                      <span>{messages.renderCapabilityRequired}: <code>{detail.capability}</code></span>
                      {detail.message && <span>{detail.message}</span>}
                      {detail.guidance && <small>{messages.renderCapabilityGuidance}: {detail.guidance}</small>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <button type="button" className="quiet-button" onClick={() => controller.dismissNotice(notice.id)}>
              {messages.dismiss}
            </button>
          </div>
        ))}
      </div>

      {!state.initialized ? (
        <main className="center-state" aria-busy="true"><Spinner /> {messages.loadingEditor}</main>
      ) : !project && initializationFailed ? (
        <InitializationRecovery controller={controller} messages={messages} />
      ) : !project ? (
        <EmptyProject controller={controller} messages={messages} />
      ) : (
        <main id="video-editor-main" className="workbench" data-layout="responsive-sidebar" data-workspace={activeSection} aria-label={messages.appName} aria-busy={state.busy}>
          <details
            className="preview-drawer"
            open={previewExpanded}
            onToggle={(event) => setPreviewExpanded(event.currentTarget.open)}
          >
            <summary>
              <strong>{messages.player}</strong>
              <span className="subtle">{formatTime(frameToSeconds(project, state.playheadFrame))} / {formatTime(frameToSeconds(project, project.durationFrames))}</span>
              <span className="preview-drawer-action">{previewExpanded ? messages.collapsePreview : messages.expandPreview}</span>
            </summary>
            <div className="preview-drawer-body">
              {!currentComposedArtifact && !sourceFastPath ? (
                <div className={`player-stage aspect-${project.canvas.preset.replace(':', '-')}`}>
                  <EmptyState>
                    <p>{messages.composedPreviewRequired}</p>
                    <button
                      type="button"
                      disabled={!canRender(state, 'preview', 'none')}
                      onClick={() => void controller.startRender('preview', 'none')}
                    >{messages.renderComposedPreview}</button>
                  </EmptyState>
                </div>
              ) : (
                <div className="preview-media-shell">
                  <span className="preview-aspect-badge" aria-hidden="true">{project.canvas.preset}</span>
                  <MediaPlayer
                    url={state.activeMediaUrl}
                    kind={currentComposedArtifact?.mediaKind ?? activeAsset?.kind}
                    title={currentComposedArtifact?.displayName ?? activeAsset?.name}
                    project={project}
                    timelineSource={currentComposedArtifact ? undefined : timelineSource}
                    caption={undefined}
                    playheadFrame={state.playheadFrame}
                    playing={state.playing}
                    onSeek={controller.seek}
                    onPlaybackChange={(playing) => playing !== state.playing && controller.togglePlaying()}
                    onResourceError={() => void controller.refreshActiveLease()}
                    messages={messages}
                  />
                  <PlayerControls controller={controller} project={project} messages={messages} />
                </div>
              )}
            </div>
          </details>

          <ProjectStatusStrip state={state} project={project} messages={messages} />

          <WorkbenchSectionTabs activeSection={activeSection} onChange={controller.setActiveWorkspace} messages={messages} />
          <SequenceNavigator controller={controller} messages={messages} />

          <aside
            id="video-editor-pane-clips"
            className="workbench-pane clips-pane"
            data-sidebar-active={activeSection === 'clips'}
            aria-label={messages.sourceMaterial}
            aria-labelledby={compactSidebar ? 'video-editor-tab-clips' : undefined}
            role={compactSidebar ? 'tabpanel' : undefined}
            hidden={compactSidebar && activeSection !== 'clips'}
          >
            <MediaLibrary controller={controller} messages={messages} />
            <WorkspaceDisclosure title={messages.workspaceMediaProcessing}>
              <DerivedMediaPanel controller={controller} messages={messages} />
            </WorkspaceDisclosure>
            <WorkspaceDisclosure title={messages.workspaceMediaIntelligence}>
              <MediaIntelligencePanel controller={controller} messages={messages} />
            </WorkspaceDisclosure>
          </aside>

          <section
            id="video-editor-pane-script"
            className="workbench-pane script-pane"
            data-sidebar-active={activeSection === 'script'}
            aria-label={messages.transcript}
            aria-labelledby={compactSidebar ? 'video-editor-tab-script' : undefined}
            role={compactSidebar ? 'tabpanel' : undefined}
            hidden={compactSidebar && activeSection !== 'script'}
          >
            <TranscriptPanel controller={controller} messages={messages} />
          </section>

          <section
            id="video-editor-pane-timeline"
            className="workbench-pane timeline-pane"
            data-sidebar-active={activeSection === 'timeline'}
            aria-label={messages.timeline}
            aria-labelledby={compactSidebar ? 'video-editor-tab-timeline' : undefined}
            role={compactSidebar ? 'tabpanel' : undefined}
            hidden={compactSidebar && activeSection !== 'timeline'}
          >
            <TimelinePanel controller={controller} messages={messages} />
            <WorkspaceDisclosure title={messages.workspaceCaptions}>
              <CaptionPanel controller={controller} messages={messages} />
            </WorkspaceDisclosure>
            <WorkspaceDisclosure title={messages.workspaceMulticam}>
              <MulticamPanel
              groups={project.multicamGroups.map((group) => ({
                id: group.id,
                sequenceId: group.sequenceId,
                name: group.name,
                durationFrames: group.durationFrames,
                referenceMemberId: group.referenceMemberId,
                members: group.members.map((member) => ({
                  id: member.id,
                  assetId: member.assetId,
                  memberLabel: member.memberLabel,
                  angleLabel: member.angleLabel,
                  sync: {
                    status: member.sync.status,
                    offsetFrames: member.sync.offsetFrames,
                    ...(member.sync.confidence === undefined ? {} : { confidence: member.sync.confidence })
                  },
                  coverage: member.coverage.map(({ startFrame, endFrame }) => ({ startFrame, endFrame }))
                })),
                layouts: group.layouts.map((layout) => ({
                  id: layout.id,
                  label: layout.label,
                  memberIds: layout.slots.map(({ memberId }) => memberId)
                })),
                programFragments: group.programFragments
              }))}
              assets={project.assets.map((asset) => ({
                id: asset.id,
                name: asset.name,
                kind: asset.kind,
                available: (asset.availability ?? 'online') === 'online'
              }))}
              busy={state.busy}
              messages={multicamPanelMessages(messages)}
              onCreate={controller.createMulticam}
              onRenameLabels={controller.renameMulticamLabels}
              onConfirmSync={controller.confirmMulticamSync}
              onSwitch={controller.switchMulticam}
              onMerge={controller.mergeMulticam}
              onApplyLayout={controller.applyMulticamLayout}
              onPreview={controller.previewMulticam}
              />
            </WorkspaceDisclosure>
          </section>

          <aside
            id="video-editor-pane-properties"
            className="workbench-pane properties-pane"
            data-sidebar-active={activeSection === 'properties'}
            aria-label={messages.inspectorAndAgent}
            aria-labelledby={compactSidebar ? 'video-editor-tab-properties' : undefined}
            role={compactSidebar ? 'tabpanel' : undefined}
            hidden={compactSidebar && activeSection !== 'properties'}
          >
            <InspectorPanel controller={controller} item={selectedItem} caption={selectedCaption} messages={messages} />
            <AgentSyncPanel controller={controller} messages={messages} />
          </aside>

          <section
            id="video-editor-pane-output"
            className="workbench-pane output-pane"
            data-sidebar-active={activeSection === 'output'}
            aria-label={messages.projectOutputAndHistory}
            aria-labelledby={compactSidebar ? 'video-editor-tab-output' : undefined}
            role={compactSidebar ? 'tabpanel' : undefined}
            hidden={compactSidebar && activeSection !== 'output'}
          >
            <ExportPanel controller={controller} jobs={projectJobs} messages={messages} />
            <WorkspaceDisclosure title={messages.workspacePreviewProof}>
              <PreviewPanel controller={controller} artifacts={artifacts} messages={messages} />
            </WorkspaceDisclosure>
            <WorkspaceDisclosure title={messages.workspaceRevisionHistory}>
              <RevisionPanel controller={controller} messages={messages} />
            </WorkspaceDisclosure>
            <WorkspaceDisclosure title={messages.workspaceGeneration}>
              <GenerationPanel
              locale={state.locale}
              projectId={project.id}
              projectRevision={project.currentRevision}
              catalog={state.generation.catalog}
              catalogOutcome={state.generation.outcome}
              unavailableMessage={state.generation.unavailableMessage}
              assets={project.assets.map((asset) => ({
                id: asset.id,
                name: asset.name,
                kind: asset.kind === 'audio' ? 'audio' : asset.kind === 'video' ? 'video' : 'image',
                available: (asset.availability ?? 'online') === 'online' && Boolean(asset.mediaHandleId)
              }))}
              records={state.generation.records}
              busy={state.busy}
              onRequest={controller.requestGeneration}
              onRefresh={controller.refreshGeneration}
              onCancel={controller.cancelGeneration}
              onRetry={controller.retryGeneration}
              onInsert={controller.insertGeneratedVariant}
              />
            </WorkspaceDisclosure>
            <WorkspaceDisclosure title={messages.workspaceInterchange}>
              <InterchangePanel controller={controller} messages={messages} />
            </WorkspaceDisclosure>
            <WorkspaceDisclosure title={messages.workspaceProjectPackage}>
              <ProjectPackagePanel controller={controller} messages={messages} />
            </WorkspaceDisclosure>
          </section>
        </main>
      )}

      <footer className="editor-footer">
        <span>{messages.localOnly}</span>
        <span>{messages.keyboardHelp}</span>
      </footer>
    </div>
  )
}
