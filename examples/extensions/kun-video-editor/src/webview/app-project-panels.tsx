import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { EditorController } from './controller.js'
import { formatMessage, type Messages } from './i18n.js'
import {
  VIEW_LIMITS,
  activeTranscriptSegment,
  type DerivedMediaKind,
  type DerivedMediaRecordProjection
} from './model.js'
import {
  EmptyState,
  MediaCapabilityStatus,
  Panel,
  StatusNotice,
  VirtualControls,
  assetKindAbbreviation,
  canImportMedia,
  connectionLabel,
  formatBytes,
  formatTime,
  segmentTimelineFrame,
  speakerAttributionLabel,
  transcriptTagLabel,
  visibleProjectAssets
} from './app-common.js'

export function ProjectBar({ controller, messages }: { controller: EditorController; messages: Messages }): React.JSX.Element {
  const { state } = controller
  const [name, setName] = useState(messages.untitledInterview)
  const previousDefaultName = useRef(messages.untitledInterview)
  const [preset, setPreset] = useState<'16:9' | '9:16' | '1:1'>('16:9')
  const [fpsPreset, setFpsPreset] = useState('30/1')
  const [creating, setCreating] = useState(false)
  useEffect(() => {
    setName((current) => current === previousDefaultName.current ? messages.untitledInterview : current)
    previousDefaultName.current = messages.untitledInterview
  }, [messages.untitledInterview])
  useEffect(() => {
    if (state.project) setCreating(false)
  }, [state.project])
  const create = (event: FormEvent): void => {
    event.preventDefault()
    const [numerator, denominator] = fpsPreset.split('/').map(Number)
    void controller.createProject(name, preset, { numerator, denominator })
  }
  return (
    <header className="project-bar">
      <div className="brand-block">
        <span className="brand-mark" aria-hidden="true">K</span>
        <div><strong>{state.project?.name ?? messages.appName}</strong><small>{state.project ? `${messages.activeRevision} r${state.project.currentRevision}` : messages.workbenchSubtitle}</small></div>
      </div>
      {state.project && <nav className="project-controls" aria-label={messages.projects}>
        <div className="project-switcher">
          <label>
            <span>{messages.projects}</span>
            <select
              value={state.project?.id ?? ''}
              onChange={(event) => event.target.value && void controller.openProject(event.target.value)}
              disabled={state.busy}
            >
              <option value="">{messages.selectProject}</option>
              {!state.projects.some(({ id }) => id === state.project?.id) && <option value={state.project.id}>{state.project.name} · r{state.project.currentRevision}</option>}
              {state.projects.map((project) => <option key={project.id} value={project.id}>{project.name} · r{project.currentRevision}</option>)}
            </select>
          </label>
          <button
            type="button"
            className="create-project-toggle"
            aria-expanded={creating}
            aria-controls="video-editor-create-project-form"
            onClick={() => setCreating((current) => !current)}
          >
            <span aria-hidden="true">＋</span><span className="create-project-label">{messages.createProject}</span>
          </button>
        </div>
        <form id="video-editor-create-project-form" className="new-project-form" data-expanded={creating} onSubmit={create}>
          <label><span>{messages.projectName}</span><input value={name} maxLength={160} onChange={(event) => setName(event.target.value)} required /></label>
          <label><span>{messages.canvas}</span><select value={preset} onChange={(event) => setPreset(event.target.value as typeof preset)}>
            <option value="16:9">16:9</option><option value="9:16">9:16</option><option value="1:1">1:1</option>
          </select></label>
          <label><span>{messages.frameRate}</span><select value={fpsPreset} onChange={(event) => setFpsPreset(event.target.value)}>
            <option value="24/1">24 fps</option>
            <option value="25/1">25 fps</option>
            <option value="30000/1001">29.97 fps</option>
            <option value="30/1">30 fps</option>
            <option value="60/1">60 fps</option>
          </select></label>
          <button type="submit" disabled={state.busy}>{messages.createProject}</button>
        </form>
      </nav>}
      <div className="project-actions">
        {state.project ? <>
          <div className="project-health" aria-label={messages.compactProjectStatus}>
            <span className={`connection connection-${state.connection}`}>{connectionLabel(messages, state.connection)}</span>
            <span className="revision-badge">r{state.project.currentRevision}</span>
            <MediaCapabilityStatus state={state} messages={messages} />
          </div>
          <div className="project-action-buttons">
            <button type="button" className="primary-action" onClick={() => void controller.importMedia()} disabled={state.busy || !canImportMedia(state)}>{messages.importMedia}</button>
            <button type="button" className="icon-action" title={messages.undo} aria-label={messages.undo} onClick={() => void controller.undo()} disabled={!(state.project.canUndo ?? state.project.currentRevision > 0) || state.busy}>↶</button>
            <button type="button" className="icon-action" title={messages.redo} aria-label={messages.redo} onClick={() => void controller.redo()} disabled={!(state.project.canRedo ?? state.project.currentRevision > 0) || state.busy}>↷</button>
            <button type="button" className="icon-action quiet-button" title={messages.refresh} aria-label={messages.refresh} onClick={() => void controller.refreshAll()} disabled={state.busy}>↻</button>
          </div>
        </> : <button type="button" className="icon-action quiet-button" title={messages.refresh} aria-label={messages.refresh} onClick={() => void controller.refreshAll()} disabled={state.busy}>↻</button>}
      </div>
    </header>
  )
}

export function EmptyProject({ controller, messages }: { controller: EditorController; messages: Messages }): React.JSX.Element {
  const [name, setName] = useState(messages.untitledInterview)
  const [preset, setPreset] = useState<'16:9' | '9:16' | '1:1'>('16:9')
  const [fpsPreset, setFpsPreset] = useState('30/1')
  const create = (event: FormEvent): void => {
    event.preventDefault()
    const [numerator, denominator] = fpsPreset.split('/').map(Number)
    void controller.createProject(name, preset, { numerator, denominator })
  }
  return (
    <main id="video-editor-main" className="empty-project">
      <section className="onboarding-intro">
        <p className="eyebrow">{messages.localFirstEditing}</p>
        <h1>{messages.onboardingTitle}</h1>
        <p>{messages.onboardingSubtitle}</p>
      </section>

      <form className="onboarding-project-card" onSubmit={create}>
        <div className="onboarding-card-heading">
          <span className="onboarding-card-icon" aria-hidden="true">＋</span>
          <div><strong>{messages.projectSetup}</strong><small>{messages.localOnly}</small></div>
        </div>
        <label className="onboarding-name"><span>{messages.projectName}</span><input value={name} maxLength={160} onChange={(event) => setName(event.target.value)} required autoFocus /></label>
        <fieldset className="onboarding-choice onboarding-aspects"><legend>{messages.canvasRatio}</legend><div>{([
          ['16:9', messages.aspectLandscape, messages.aspectLandscapeHint],
          ['9:16', messages.aspectPortrait, messages.aspectPortraitHint],
          ['1:1', messages.aspectSquare, messages.aspectSquareHint]
        ] as const).map(([value, label, hint]) => <button type="button" key={value} aria-pressed={preset === value} onClick={() => setPreset(value)}><span className="onboarding-aspect-visual" data-aspect={value} aria-hidden="true"><i /></span><span><strong>{value}</strong><small>{label} · {hint}</small></span></button>)}</div></fieldset>
        <fieldset className="onboarding-choice onboarding-fps"><legend>{messages.frameRate}</legend><div>{[['24/1', '24'], ['25/1', '25'], ['30/1', '30'], ['50/1', '50'], ['60/1', '60']].map(([value, label]) => <button type="button" key={value} aria-pressed={fpsPreset === value} onClick={() => setFpsPreset(value!)}><strong>{label}</strong><small>fps</small></button>)}</div></fieldset>
        <button type="submit" className="empty-project-primary" disabled={controller.state.busy}>{messages.createAndStart}<span aria-hidden="true">→</span></button>
      </form>

      <section className="onboarding-recent" aria-labelledby="video-editor-recent-projects">
        <div className="onboarding-section-heading"><h2 id="video-editor-recent-projects">{messages.recentProjects}</h2><span>{controller.state.projects.length}</span></div>
        {controller.state.projects.length === 0 ? <p className="onboarding-empty-recent">{messages.noProject}</p> : <div className="onboarding-recent-list">{controller.state.projects.slice(0, 4).map((project) => (
          <button type="button" key={project.id} onClick={() => void controller.openProject(project.id)}>
            <span className="recent-project-thumb" aria-hidden="true"><i /><i /><i /></span>
            <span><strong>{project.name}</strong><small>r{project.currentRevision}</small></span><b aria-hidden="true">→</b>
          </button>
        ))}</div>}
      </section>

      <section className="onboarding-steps" aria-label={messages.onboardingWorkflow}>
        {[
          [messages.onboardingStepCreate, messages.onboardingStepCreateBody, '01'],
          [messages.onboardingStepImport, messages.onboardingStepImportBody, '02'],
          [messages.onboardingStepEdit, messages.onboardingStepEditBody, '03']
        ].map(([title, body, step]) => <article key={step}><span>{step}</span><div><strong>{title}</strong><p>{body}</p></div></article>)}
      </section>

      <div className="empty-illustration" aria-hidden="true">
        <div className="empty-preview-stage"><span className="empty-aspect">{preset}</span><b>▶</b></div>
        <div className="empty-preview-transport"><span>00:18</span><i /></div>
        <div className="empty-preview-timeline"><i /><i /><i /></div>
      </div>
    </main>
  )
}

export function InitializationRecovery({ controller, messages }: { controller: EditorController; messages: Messages }): React.JSX.Element {
  return (
    <main id="video-editor-main" className="initialization-recovery" aria-labelledby="video-editor-initialization-error">
      <div className="initialization-recovery-card">
        <p className="eyebrow">{messages.appName}</p>
        <h1 id="video-editor-initialization-error">{messages.editorInitializeFailed}</h1>
        <p>{messages.editorInitializeRecovery}</p>
        <button
          type="button"
          className="empty-project-primary"
          disabled={controller.state.connection === 'reconnecting' || controller.state.busy}
          onClick={() => void controller.retryInitialization()}
        >
          {messages.retryInitialization}
        </button>
      </div>
    </main>
  )
}

export function MediaLibrary({ controller, messages }: { controller: EditorController; messages: Messages }): React.JSX.Element {
  const project = controller.state.project!
  const [folderId, setFolderId] = useState('')
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<'all' | 'video' | 'image' | 'audio'>('all')
  const [windowStart, setWindowStart] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const normalizedQuery = query.trim()
  const page = controller.state.mediaLibrary
  const filterMatches = Boolean(
    page &&
    page.projectId === project.id &&
    page.revision === project.currentRevision &&
    (page.folderId ?? '') === folderId &&
    page.query === normalizedQuery
  )
  const pageMatches = filterMatches && page?.offset === windowStart
  const assets = pageMatches
    ? page!.assets
    : windowStart === 0 && !folderId && !normalizedQuery
      ? project.assets.slice(0, VIEW_LIMITS.virtualWindow)
      : []
  const visibleAssets = assets.filter((asset) => kindFilter === 'all' || asset.kind === kindFilter || (kindFilter === 'image' && asset.kind === 'animation'))
  const total = filterMatches ? page!.total : project.assets.length
  const activeFolderNonEmpty = Boolean(folderId && (
    project.assets.some((asset) => asset.folderId === folderId) ||
    project.mediaFolders.some((folder) => folder.parentId === folderId) ||
    (filterMatches && !normalizedQuery && page!.total > 0)
  ))
  useEffect(() => {
    void controller.loadMediaLibraryPage({
      ...(folderId ? { folderId } : {}),
      ...(normalizedQuery ? { query: normalizedQuery } : {}),
      offset: windowStart,
      limit: VIEW_LIMITS.virtualWindow
    })
  }, [controller.loadMediaLibraryPage, folderId, normalizedQuery, project.currentRevision, project.id, windowStart])
  const toggleSelected = (assetId: string): void => {
    setSelected((current) => current.includes(assetId)
      ? current.filter((id) => id !== assetId)
      : [...current, assetId].slice(-64))
  }
  return (
    <Panel title={messages.mediaLibrary} className="media-library-panel" actions={<button type="button" className="primary-action media-import-action" onClick={() => void controller.importMedia({ folderId: folderId || undefined, addToTimeline: false })} disabled={controller.state.busy || !canImportMedia(controller.state)}>{messages.importMedia}</button>}>
      <div className="media-library-toolbar">
        <label><span>{messages.folder}</span><select value={folderId} onChange={(event) => {
          setFolderId(event.target.value)
          setWindowStart(0)
        }}>
          <option value="">{messages.allMedia}</option>
          {project.mediaFolders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
        </select></label>
        <label><span>{messages.search}</span><input type="search" value={query} maxLength={256} placeholder={messages.searchMedia} onChange={(event) => {
          setQuery(event.target.value)
          setWindowStart(0)
        }} /></label>
        <button type="button" onClick={() => {
          const name = window.prompt(messages.newFolderPrompt)
          if (name?.trim()) void controller.createMediaFolder(name, folderId || undefined)
        }}>{messages.newFolder}</button>
        {folderId && <>
          <button type="button" onClick={() => {
            const current = project.mediaFolders.find(({ id }) => id === folderId)
            const name = window.prompt(messages.renameFolderPrompt, current?.name)
            if (name?.trim()) void controller.updateMediaFolder(folderId, { name })
          }}>{messages.rename}</button>
          <button
            type="button"
            className="danger-button"
            disabled={activeFolderNonEmpty}
            title={activeFolderNonEmpty ? messages.emptyFolderBeforeDelete : undefined}
            onClick={() => window.confirm(messages.deleteFolderConfirm) && void controller.deleteMediaFolder(folderId)}
          >{messages.delete}</button>
        </>}
      </div>
      <div className="media-kind-filters" role="group" aria-label={messages.mediaKinds}>
        {([
          ['all', messages.allKinds],
          ['video', messages.videoKind],
          ['image', messages.imageKind],
          ['audio', messages.audioKind]
        ] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={kindFilter === value} onClick={() => setKindFilter(value)}>{label}</button>)}
      </div>
      <div className="media-organize-row" data-active={selected.length > 0 ? 'true' : 'false'}>
        <span>{formatMessage(messages.mediaSelectedCount, { count: selected.length })}</span>
        <select aria-label={messages.moveSelectedToFolder} defaultValue="" onChange={(event) => {
          if (!selected.length) return
          void controller.organizeMedia(selected, event.target.value || undefined)
        }}>
          <option value="">{messages.moveToRoot}</option>
          {project.mediaFolders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
        </select>
        {selected.length > 0 && <button type="button" className="quiet-button" onClick={() => setSelected([])}>{messages.clearSelection}</button>}
      </div>
      {visibleAssets.length === 0 ? <EmptyState>{messages.noMedia}</EmptyState> : (
        <ul className="media-list" aria-label={messages.importedMedia}>
          {visibleAssets.map((asset) => {
            const revoked = asset.availability === 'revoked' || Boolean(asset.mediaHandleId && controller.state.revokedHandles.includes(asset.mediaHandleId))
            const offline = revoked || asset.availability === 'offline' || asset.availability === 'changed'
            return (
              <li key={asset.id} data-kind={asset.kind} data-availability={asset.availability ?? 'online'}>
                <label className="media-select"><input type="checkbox" checked={selected.includes(asset.id)} onChange={() => toggleSelected(asset.id)} /><span className="sr-only">{formatMessage(messages.selectMediaItem, { name: asset.name })}</span></label>
                <button
                  type="button"
                  className={controller.state.selectedAssetId === asset.id ? 'selected media-card' : 'media-card'}
                  onClick={() => void controller.openAsset(asset.id)}
                  aria-pressed={controller.state.selectedAssetId === asset.id}
                >
                  <span className={`media-kind media-kind-${asset.kind}`}>{assetKindAbbreviation(messages, asset.kind)}</span>
                  <span><strong>{asset.name}</strong><small>{formatTime(asset.durationUs / 1_000_000)} · {asset.still ? `${asset.still.width}×${asset.still.height}` : asset.container}</small>{asset.generatedLineage && <em>{messages.generatedAsset}</em>}</span>
                </button>
                {offline && (
                  <button
                    type="button"
                    className="quiet-button reauthorize-button"
                    onClick={() => void controller.recoverMedia(asset.id)}
                  >
                    {messages.reauthorize}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <VirtualControls start={windowStart} total={total} onChange={setWindowStart} messages={messages} />
      {(total > visibleAssets.length || kindFilter !== 'all') && <p className="subtle">{formatMessage(messages.filteredAssets, { visible: visibleAssets.length, total })}</p>}
    </Panel>
  )
}

export function DerivedMediaPanel({ controller, messages }: {
  controller: EditorController
  messages: Messages
}): React.JSX.Element {
  const { state } = controller
  const selectedAsset = visibleProjectAssets(state).find(({ id }) => id === state.selectedAssetId)
  const canGenerate = Boolean(
    selectedAsset?.mediaHandleId &&
    !state.busy &&
    state.mediaCapabilities?.ffmpeg.available !== false
  )
  const usage = state.derivedUsage
  const actions = (
    <button
      type="button"
      className="quiet-button"
      onClick={() => void controller.refreshDerived()}
      disabled={state.busy}
    >
      {messages.derivedRefresh}
    </button>
  )
  return (
    <Panel title={messages.derivedMedia} actions={actions} className="derived-media-panel">
      <p className="boundary-note">{messages.derivedMediaHelp}</p>
      <div className="derived-create-grid" aria-label={messages.derivedMedia}>
        <button type="button" disabled={!canGenerate} onClick={() => void controller.startDerived('waveform')}>
          {messages.generateWaveform}
        </button>
        <button type="button" disabled={!canGenerate} onClick={() => void controller.startDerived('thumbnail')}>
          {messages.generateThumbnail}
        </button>
        <button type="button" disabled={!canGenerate} onClick={() => void controller.startDerived('filmstrip')}>
          {messages.generateFilmstrip}
        </button>
        <button type="button" disabled={!canGenerate} onClick={() => void controller.startDerived('proxy')}>
          {messages.generateProxy}
        </button>
      </div>
      {usage && (
        <p className="derived-usage">
          {formatMessage(messages.derivedStorage, {
            used: formatBytes(usage.usedBytes),
            quota: formatBytes(usage.quotaBytes),
            count: usage.recordCount
          })}
        </p>
      )}
      {state.derivedRecoveryDiagnostics.length > 0 && (
        <StatusNotice severity="warning">{messages.derivedRecoveryWarning}</StatusNotice>
      )}
      {state.derivedRecords.length === 0 ? <EmptyState>{messages.derivedEmpty}</EmptyState> : (
        <ul className="derived-list" aria-label={messages.derivedMedia}>
          {state.derivedRecords.map((record) => (
            <li key={record.id} data-status={record.status}>
              <div className="derived-record-heading">
                <strong>{derivedKindLabel(messages, record.kind)}</strong>
                <span className={`derived-status derived-status-${record.status}`}>
                  {derivedStatusLabel(messages, record.status)}
                </span>
              </div>
              <small>
                {record.assetId ?? state.project?.name} · {formatBytes(record.bytes)} · {formatMessage(messages.attempt, { attempt: record.attempt })}
              </small>
              {record.progress && (
                <progress
                  aria-label={derivedStatusLabel(messages, record.status)}
                  max={record.progress.total}
                  value={record.progress.completed}
                />
              )}
              {record.error?.message && <p className="derived-error">{record.error.message}</p>}
              <div className="button-row derived-record-actions">
                {['queued', 'running', 'partial'].includes(record.status) && (
                  <button
                    type="button"
                    className="quiet-button"
                    disabled={state.busy}
                    onClick={() => void controller.cancelDerived(record.id)}
                  >
                    {messages.derivedCancel}
                  </button>
                )}
                {['failed', 'cancelled', 'interrupted', 'invalid'].includes(record.status) && (
                  <button
                    type="button"
                    className="quiet-button"
                    disabled={state.busy}
                    onClick={() => void controller.retryDerived(record)}
                  >
                    {messages.derivedRetry}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="button-row derived-cleanup-actions">
        <button type="button" className="quiet-button" disabled={state.busy} onClick={() => void controller.cleanupDerived(false)}>
          {messages.derivedCleanupFailures}
        </button>
        <button type="button" className="quiet-button" disabled={state.busy} onClick={() => void controller.cleanupDerived(true)}>
          {messages.derivedClearCache}
        </button>
      </div>
    </Panel>
  )
}

export function derivedKindLabel(messages: Messages, kind: DerivedMediaKind): string {
  const keys: Record<DerivedMediaKind, keyof Messages> = {
    waveform: 'derivedKindWaveform',
    thumbnail: 'derivedKindThumbnail',
    filmstrip: 'derivedKindFilmstrip',
    transcript: 'derivedKindTranscript',
    analysis: 'derivedKindAnalysis',
    embedding: 'derivedKindEmbedding',
    proxy: 'derivedKindProxy',
    proof: 'derivedKindProof',
    preview: 'derivedKindPreview'
  }
  return messages[keys[kind]]
}

export function derivedStatusLabel(messages: Messages, status: DerivedMediaRecordProjection['status']): string {
  const keys: Record<DerivedMediaRecordProjection['status'], keyof Messages> = {
    queued: 'derivedStateQueued',
    running: 'derivedStateRunning',
    partial: 'derivedStatePartial',
    ready: 'derivedStateReady',
    failed: 'derivedStateFailed',
    cancelled: 'derivedStateCancelled',
    interrupted: 'derivedStateInterrupted',
    invalid: 'derivedStateInvalid'
  }
  return messages[keys[status]]
}

export function TranscriptPanel({ controller, messages }: { controller: EditorController; messages: Messages }): React.JSX.Element {
  const { state } = controller
  const project = state.project!
  const [query, setQuery] = useState('')
  const transcripts = state.selectedAssetId
    ? project.transcripts.filter(({ assetId }) => assetId === state.selectedAssetId)
    : project.transcripts
  const allSegments = transcripts.flatMap((transcript) => transcript.segments.map((segment) => ({ ...segment, assetId: transcript.assetId })))
  const normalizedQuery = query.trim().toLocaleLowerCase(state.locale?.language)
  const segments = normalizedQuery
    ? allSegments.filter((segment) => segment.text.toLocaleLowerCase(state.locale?.language).includes(normalizedQuery))
    : allSegments
  const start = Math.min(state.transcriptWindowStart, Math.max(0, segments.length - 1))
  const visible = segments.slice(start, start + VIEW_LIMITS.virtualWindow)
  const active = activeTranscriptSegment(project, state.selectedAssetId, state.playheadFrame)
  return (
    <Panel title={messages.smartScript} className="transcript-panel" actions={<span className="local-ready-status"><i aria-hidden="true" />{messages.localTranscriptReady}</span>}>
      <div className="transcript-toolbar">
        <label className="transcript-search"><span className="sr-only">{messages.searchTranscript}</span><input type="search" value={query} placeholder={messages.searchTranscript} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="transcript-actions">
          <button type="button" className="quiet-button" onClick={() => void controller.importTranscript()}>{messages.importTranscript}</button>
          <button type="button" className="quiet-button" onClick={() => void controller.checkLocalTranscriber()}>{messages.checkLocalTranscriber}</button>
          <button type="button" className="primary-action" disabled={allSegments.length === 0} onClick={() => void controller.generateCaptions()}>{messages.generateCaptions}</button>
        </div>
        <VirtualControls start={start} total={segments.length} onChange={controller.setTranscriptWindow} messages={messages} />
      </div>
      {segments.length === 0 ? <EmptyState>{messages.noTranscript}</EmptyState> : (
        <ol
          className="transcript-list"
          start={start + 1}
          aria-label={messages.timedTranscriptSegments}
          data-scroll-region="transcript"
          data-total={segments.length}
          tabIndex={0}
        >
          {visible.map((segment) => (
            <li key={`${segment.assetId}:${segment.id}`} className="transcript-row">
              <button
                type="button"
                className={active?.id === segment.id ? 'transcript-segment active' : 'transcript-segment'}
                aria-current={active?.id === segment.id ? 'true' : undefined}
                onClick={() => controller.seek(segmentTimelineFrame(project, segment.assetId, segment.startUs))}
              >
                <span className="transcript-identity"><span className="transcript-avatar" aria-hidden="true">✦</span><time>{formatTime(segment.startUs / 1_000_000)}</time></span>
                <span className="transcript-copy">
                  <span>{segment.text}</span>
                  {segment.speakerAttribution && (
                    <small className={`speaker-attribution ${segment.speakerAttribution.status}`}>
                      {speakerAttributionLabel(messages, segment.speakerAttribution)}
                    </small>
                  )}
                </span>
                {segment.tags?.map((tag) => <em key={tag}>{transcriptTagLabel(messages, tag)}</em>)}
              </button>
              <button
                type="button"
                className="quiet-button transcript-cut"
                aria-label={messages.removeTranscriptRange}
                title={messages.removeTranscriptRange}
                onClick={() => void controller.applyScript([{
                  assetId: segment.assetId,
                  startUs: segment.startUs,
                  endUs: segment.endUs,
                  reason: segment.tags?.includes('silence') ? 'silence' : segment.tags?.includes('filler') ? 'filler' : 'selection'
                }])}
              >
                <span aria-hidden="true">•••</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {transcripts.some(({ truncated }) => truncated) && <p className="notice notice-warning">{messages.transcriptTruncated}</p>}
      <p className="boundary-note">{messages.transcriptEvidenceBoundary}</p>
      <ScriptReview controller={controller} messages={messages} />
    </Panel>
  )
}

export function ScriptReview({ controller, messages }: { controller: EditorController; messages: Messages }): React.JSX.Element {
  const script = controller.state.script
  const [ranges, setRanges] = useState('[]')
  const [rangeError, setRangeError] = useState('')
  const apply = (): void => {
    try {
      const parsed: unknown = JSON.parse(ranges)
      if (!Array.isArray(parsed)) throw new Error(messages.rangesRequired)
      setRangeError('')
      void controller.applyScript(parsed as Array<{ assetId: string; startUs: number; endUs: number; reason?: 'filler' | 'silence' | 'selection' }>)
    } catch {
      setRangeError(messages.invalidRanges)
    }
  }
  return (
    <details className="script-review">
      <summary>{messages.readScript}</summary>
      {!script ? (
        <button type="button" onClick={() => void controller.readScript()}>{messages.readScript}</button>
      ) : (
        <div className="field-stack">
          <span className="subtle">{messages.revisionLabel} {script.revision} · {messages.digestLabel} {script.digest.slice(0, 12) || messages.unavailable}</span>
          <label><span>{messages.revisionBoundTimeline}</span><textarea rows={12} value={script.markdown} readOnly /></label>
          <small>{messages.revisionBoundTimelineReadonly}</small>
          <label><span>{messages.explicitSourceRanges} (JSON)</span><textarea rows={4} value={ranges} onChange={(event) => setRanges(event.target.value)} aria-describedby="range-help" /></label>
          <small id="range-help">{messages.example}: [{`{"assetId":"asset-1","startUs":1000000,"endUs":1300000,"reason":"filler"}`}]</small>
          {rangeError && <p className="field-error" role="alert">{rangeError}</p>}
          <div className="button-row"><button type="button" onClick={apply} disabled={controller.state.busy}>{messages.apply}</button><button type="button" className="quiet-button" onClick={() => void controller.readScript()}>{messages.reload}</button></div>
        </div>
      )}
    </details>
  )
}
