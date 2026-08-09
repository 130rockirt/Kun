import type { GeneratedArtifact, JobSnapshot } from '@kun/extension-api'
import { useEffect, useState, type FormEvent } from 'react'
import {
  artifactUsesPlayer,
  type EditorController,
  type PreviewResource
} from './controller.js'
import { formatMessage, type Messages } from './i18n.js'
import {
  frameToSeconds,
  proofIsStale,
  type InterchangeLossManifestProjection,
  type OtioExportTicket,
  type ProjectPackageTicket
} from './model.js'
import {
  EmptyState,
  JobRow,
  Panel,
  canRender,
  formatBytes,
  formatTime,
  formatTimestamp,
  hasMediaFeature,
  jobDetailLabel,
  jobStateLabel,
  mediaKindLabel,
  previewSourceLabel,
  projectPackageResultSummary,
  ticketForArtifact,
  visibleProjectAssets
} from './app-common.js'
import { WorkbenchIcon } from './app-shell.js'

export function PreviewPanel(props: { controller: EditorController; artifacts: GeneratedArtifact[]; messages: Messages }): React.JSX.Element {
  const { controller, artifacts, messages } = props
  const project = controller.state.project!
  const [captionMode, setCaptionMode] = useState<'none' | 'burned'>('none')
  const [sourceKind, setSourceKind] = useState<'asset' | 'timeline' | 'generated'>('timeline')
  const [label, setLabel] = useState('')
  const [leftEntryId, setLeftEntryId] = useState('')
  const [rightEntryId, setRightEntryId] = useState('')
  const [compareMode, setCompareMode] = useState<'wipe' | 'side-by-side'>('wipe')
  const burnedAvailable = hasMediaFeature(controller.state, 'drawtext-filter')
  const history = controller.state.previewHistory
  const visibleAssets = visibleProjectAssets(controller.state)
  const selectedAsset = visibleAssets.find(({ id }) => id === controller.state.selectedAssetId) ?? project.assets[0]
  const generatedAsset = visibleAssets.find(({ generatedLineage }) => generatedLineage && (
    !controller.state.selectedAssetId || controller.state.selectedAssetId === generatedLineage.variantOfAssetId
  )) ?? visibleAssets.find(({ generatedLineage }) => generatedLineage)
  const timelineArtifact = artifacts.find((artifact) => {
    const ticket = ticketForArtifact(controller.state.renderTickets, artifact)
    return ticket?.projectId === project.id && ticket.pinnedRevision === project.currentRevision && artifactUsesPlayer(artifact)
  })
  const activeEntry = history.entries.find(({ id }) => id === history.activeEntryId)
  const comparisonIds = controller.state.previewComparison
    ? [controller.state.previewComparison.leftEntryId, controller.state.previewComparison.rightEntryId]
    : []
  const [comparisonResources, setComparisonResources] = useState<{
    left?: PreviewResource
    right?: PreviewResource
    loading: boolean
  }>({ loading: false })
  const canAddSource = sourceKind === 'timeline' || (sourceKind === 'asset' ? Boolean(selectedAsset) : Boolean(generatedAsset))
  const addSource = (): void => {
    const effectiveLabel = label.trim() || (sourceKind === 'timeline'
      ? messages.timelinePreviewDefaultLabel
      : sourceKind === 'generated'
        ? generatedAsset?.name
        : selectedAsset?.name)
    if (!effectiveLabel) return
    if (sourceKind === 'asset' && selectedAsset) {
      void controller.addPreview({ kind: 'asset', assetId: selectedAsset.id, startUs: 0, endUs: selectedAsset.durationUs }, effectiveLabel)
    } else if (sourceKind === 'generated' && generatedAsset?.generatedLineage) {
      void controller.addPreview({ kind: 'generated', assetId: generatedAsset.id, jobId: generatedAsset.generatedLineage.jobId, variantIndex: 0 }, effectiveLabel)
    } else if (sourceKind === 'timeline') {
      const range = project.selection.range
      void controller.addPreview({
        kind: 'timeline',
        sequenceId: project.activeSequenceId,
        revision: project.currentRevision,
        startFrame: range?.startFrame ?? 0,
        endFrame: range?.endFrame ?? Math.max(1, project.durationFrames),
        ...(timelineArtifact ? { artifactId: timelineArtifact.artifactId } : {})
      }, effectiveLabel)
    }
    setLabel('')
  }
  useEffect(() => {
    if (history.entries.length === 0) {
      setLeftEntryId('')
      setRightEntryId('')
      return
    }
    if (!history.entries.some(({ id }) => id === leftEntryId)) setLeftEntryId(history.entries[0]!.id)
    if (!history.entries.some(({ id }) => id === rightEntryId)) setRightEntryId(history.entries[1]?.id ?? history.entries[0]!.id)
  }, [history.entries, leftEntryId, rightEntryId])
  useEffect(() => {
    const comparison = controller.state.previewComparison
    if (!comparison) {
      setComparisonResources({ loading: false })
      return
    }
    let current = true
    setComparisonResources({ loading: true })
    void Promise.all([
      controller.openPreviewResource(comparison.leftEntryId),
      controller.openPreviewResource(comparison.rightEntryId)
    ]).then(([left, right]) => {
      if (current) setComparisonResources({ ...(left ? { left } : {}), ...(right ? { right } : {}), loading: false })
    }, () => {
      if (current) setComparisonResources({ loading: false })
    })
    return () => { current = false }
  }, [controller.openPreviewResource, controller.state.previewComparison])
  return (
    <Panel title={messages.preview}>
      <div className="button-row">
        <label className="inline-field"><span>{messages.captionsLabel}</span><select value={captionMode} onChange={(event) => setCaptionMode(event.target.value as typeof captionMode)}><option value="none">{messages.captionModeNone}</option><option value="burned" disabled={!burnedAvailable}>{messages.captionModeBurned}</option></select></label>
        <button type="button" disabled={!canRender(controller.state, 'proof-frame', captionMode)} onClick={() => void controller.startRender('proof-frame', captionMode)}>{messages.proofFrame}</button>
        <button type="button" disabled={!canRender(controller.state, 'preview', captionMode)} onClick={() => void controller.startRender('preview', captionMode)}>{messages.previewClip}</button>
      </div>
      {!burnedAvailable && <p className="boundary-note">{messages.burnedCaptionsUnavailable}</p>}
      <section className="preview-history-workbench" aria-label={messages.previewHistory}>
        <div className="preview-source-tabs" role="tablist" aria-label={messages.previewSources}>
          {(['asset', 'timeline', 'generated'] as const).map((kind) => <button
            type="button"
            role="tab"
            key={kind}
            aria-selected={sourceKind === kind}
            onClick={() => setSourceKind(kind)}
          >{kind === 'asset' ? messages.previewSourceAsset : kind === 'timeline' ? messages.previewSourceTimeline : messages.previewSourceGenerated}</button>)}
        </div>
        <div className="preview-source-form">
          <p>{sourceKind === 'asset'
            ? selectedAsset?.name ?? messages.noMedia
            : sourceKind === 'generated'
              ? generatedAsset?.name ?? messages.noGeneratedMedia
              : formatMessage(messages.timelinePreviewRange, {
                start: project.selection.range?.startFrame ?? 0,
                end: project.selection.range?.endFrame ?? project.durationFrames
              })}</p>
          <label><span>{messages.previewLabel}</span><input value={label} maxLength={160} placeholder={messages.previewLabelPlaceholder} onChange={(event) => setLabel(event.target.value)} /></label>
          <button type="button" disabled={!canAddSource || controller.state.busy} onClick={addSource}>{messages.addToPreviewHistory}</button>
        </div>
        {history.entries.length === 0 ? <EmptyState>{messages.emptyPreviewHistory}</EmptyState> : <ul className="preview-history-list">{[...history.entries].reverse().map((entry) => {
          const selected = entry.id === history.activeEntryId
          return <li key={entry.id} data-active={selected ? 'true' : 'false'}>
            <button type="button" className="preview-history-entry" aria-pressed={selected} onClick={() => void controller.selectPreview(entry.id)}>
              <strong>{entry.label}</strong>
              <small>{previewSourceLabel(messages, entry.source.kind)} · {formatTimestamp(entry.createdAt, controller.state.locale?.language)}</small>
            </button>
          </li>
        })}</ul>}
        <div className="preview-history-actions button-row">
          <button type="button" disabled={!activeEntry || !controller.state.selectedItemId || activeEntry.source.kind === 'timeline'} onClick={() => activeEntry && void controller.replaceSelectedFromPreview(activeEntry.id)}>{messages.replaceSelectedClip}</button>
          <button type="button" disabled={!activeEntry && comparisonIds.length === 0} onClick={() => void controller.attachSelection([...new Set([...(activeEntry ? [activeEntry.id] : []), ...comparisonIds])])}>{messages.attachSelectionToAgent}</button>
          <button type="button" onClick={() => void controller.refreshPreviewHistory()}>{messages.refresh}</button>
        </div>
        {history.entries.length >= 2 && <fieldset className="preview-compare"><legend>{messages.comparePreviews}</legend>
          <label><span>{messages.compareLeft}</span><select value={leftEntryId} onChange={(event) => setLeftEntryId(event.target.value)}>{history.entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>
          <label><span>{messages.compareRight}</span><select value={rightEntryId} onChange={(event) => setRightEntryId(event.target.value)}>{history.entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>
          <label><span>{messages.compareMode}</span><select value={compareMode} onChange={(event) => setCompareMode(event.target.value as typeof compareMode)}><option value="wipe">{messages.compareWipe}</option><option value="side-by-side">{messages.compareSideBySide}</option></select></label>
          <button type="button" disabled={!leftEntryId || !rightEntryId || leftEntryId === rightEntryId} onClick={() => void controller.comparePreviews(leftEntryId, rightEntryId, compareMode)}>{messages.compare}</button>
        </fieldset>}
        {controller.state.previewComparison && <p className="preview-comparison-status" role="status">{formatMessage(messages.previewComparisonActive, {
          mode: controller.state.previewComparison.mode === 'wipe' ? messages.compareWipe : messages.compareSideBySide,
          revision: controller.state.previewComparison.sameRevision ? messages.sameRevision : messages.differentRevision
        })}</p>}
        {controller.state.previewComparison && (
          comparisonResources.left && comparisonResources.right
            ? <PreviewComparisonViewer
                left={comparisonResources.left}
                right={comparisonResources.right}
                mode={controller.state.previewComparison.mode}
                messages={messages}
              />
            : <p className="subtle" role="status">
                {comparisonResources.loading ? messages.loadingEditor : messages.previewComparisonUnavailable}
              </p>
        )}
        <p className="boundary-note">{messages.previewContextBoundary}</p>
      </section>
      {artifacts.length === 0 ? <EmptyState>{messages.noProofArtifacts}</EmptyState> : <ul className="artifact-list">{artifacts.map((artifact) => {
        const ticket = ticketForArtifact(controller.state.renderTickets, artifact)
        const stale = ticket ? proofIsStale(ticket, project) : false
        const usesPlayer = artifactUsesPlayer(artifact)
        return <li key={artifact.artifactId}><div><strong>{artifact.displayName}</strong><small>{formatBytes(artifact.byteSize)} · {mediaKindLabel(messages, artifact.mediaKind)}</small></div>{stale && <span className="stale-badge">{messages.staleProof}</span>}<p>{messages.technicallyValidated}</p>{!usesPlayer && <p className="subtle">{messages.hostArtifactAction}</p>}<div className="button-row"><button type="button" disabled={artifact.availability !== 'available'} onClick={() => void controller.openArtifact(artifact)}>{usesPlayer ? messages.previewMedia : messages.openWithSystem}</button><button type="button" disabled={artifact.availability !== 'available'} onClick={() => void controller.revealArtifact(artifact)}>{messages.showInFolder}</button></div></li>
      })}</ul>}
    </Panel>
  )
}

export function PreviewComparisonViewer(props: {
  left: PreviewResource
  right: PreviewResource
  mode: 'wipe' | 'side-by-side'
  messages: Messages
}): React.JSX.Element {
  return <figure className={`preview-comparison-viewer mode-${props.mode}`}>
    <div className="preview-comparison-media comparison-left">
      <PreviewComparisonElement resource={props.left} />
      <figcaption>{props.messages.compareLeft}: {props.left.title}</figcaption>
    </div>
    <div className="preview-comparison-media comparison-right">
      <PreviewComparisonElement resource={props.right} />
      <figcaption>{props.messages.compareRight}: {props.right.title}</figcaption>
    </div>
  </figure>
}

export function PreviewComparisonElement({ resource }: { resource: PreviewResource }): React.JSX.Element {
  if (resource.mediaKind === 'image') return <img src={resource.url} alt={resource.title} />
  if (resource.mediaKind === 'audio') return <audio src={resource.url} controls aria-label={resource.title} />
  return <video src={resource.url} controls muted playsInline aria-label={resource.title} />
}

export function ExportPanel({ controller, jobs, messages }: { controller: EditorController; jobs: JobSnapshot[]; messages: Messages }): React.JSX.Element {
  const [captionMode, setCaptionMode] = useState<'none' | 'burned' | 'sidecar' | 'both'>('none')
  const [subtitleFormat, setSubtitleFormat] = useState<'srt' | 'vtt'>('srt')
  const [outputKind, setOutputKind] = useState<'h264-mp4' | 'audio-aac' | 'subtitles-srt' | 'subtitles-vtt'>('h264-mp4')
  const project = controller.state.project!
  const fps = project.fps.numerator / project.fps.denominator
  const outputOptions = [
    { kind: 'h264-mp4', label: messages.exportVideo, detail: 'MP4 · H.264' },
    { kind: 'audio-aac', label: messages.exportAudio, detail: 'AAC · M4A' },
    { kind: 'subtitles-srt', label: messages.exportSubRip, detail: 'SRT' },
    { kind: 'subtitles-vtt', label: messages.exportWebVtt, detail: 'WebVTT' }
  ] as const
  const canStartExport = outputKind === 'h264-mp4'
    ? canRender(controller.state, 'h264-mp4', captionMode)
    : outputKind === 'audio-aac'
      ? canRender(controller.state, 'audio-aac', 'none')
      : canRender(controller.state, 'subtitles', 'none')
  const startExport = (): void => {
    if (outputKind === 'h264-mp4') void controller.startRender('h264-mp4', captionMode, subtitleFormat)
    else if (outputKind === 'audio-aac') void controller.startRender('audio-aac', 'none')
    else void controller.startRender('subtitles', 'none', outputKind === 'subtitles-srt' ? 'srt' : 'vtt')
  }
  const selectedOutput = outputOptions.find(({ kind }) => kind === outputKind)!
  return (
    <Panel title={messages.export} className="export-panel">
      <section className="delivery-hero">
        <span className="delivery-icon" aria-hidden="true"><WorkbenchIcon name="output" /></span>
        <div><p className="eyebrow">{messages.readyToDeliver}</p><h2>{project.name}</h2><p>{formatMessage(messages.deliverySummary, { revision: project.currentRevision, duration: formatTime(frameToSeconds(project, project.durationFrames)) })}</p></div>
      </section>
      <fieldset className="output-kind-options"><legend>{messages.outputMode}</legend><div>{outputOptions.map((option) => <button type="button" key={option.kind} aria-pressed={outputKind === option.kind} onClick={() => setOutputKind(option.kind)}><span className="output-kind-icon"><WorkbenchIcon name={option.kind === 'h264-mp4' ? 'output' : option.kind === 'audio-aac' ? 'playhead' : 'script'} /></span><span><strong>{option.label}</strong><small>{option.detail}</small></span></button>)}</div></fieldset>
      <div className="export-settings-grid">
        {outputKind === 'h264-mp4' && <label><span>{messages.captionsLabel}</span><select value={captionMode} onChange={(event) => setCaptionMode(event.target.value as typeof captionMode)}><option value="none">{messages.captionModeNone}</option><option value="burned" disabled={!hasMediaFeature(controller.state, 'drawtext-filter')}>{messages.captionModeBurned}</option><option value="sidecar">{messages.captionModeSidecar}</option><option value="both" disabled={!hasMediaFeature(controller.state, 'drawtext-filter')}>{messages.captionModeBoth}</option></select></label>}
        {outputKind === 'h264-mp4' && (captionMode === 'sidecar' || captionMode === 'both') && <label><span>{messages.format}</span><select value={subtitleFormat} onChange={(event) => setSubtitleFormat(event.target.value as typeof subtitleFormat)}><option value="srt">SRT</option><option value="vtt">WebVTT</option></select></label>}
        <dl className="export-facts"><div><dt>{messages.canvas}</dt><dd>{project.canvas.preset}</dd></div><div><dt>{messages.frameRate}</dt><dd>{Number.isInteger(fps) ? fps : fps.toFixed(2)} fps</dd></div><div><dt>{messages.activeRevision}</dt><dd>r{project.currentRevision}</dd></div></dl>
      </div>
      <div className="export-primary-row"><button type="button" className="primary-action export-video-action" disabled={!canStartExport} onClick={startExport}>{selectedOutput.label}<span aria-hidden="true">→</span></button></div>
      {outputKind === 'h264-mp4' && !hasMediaFeature(controller.state, 'drawtext-filter') && <p className="boundary-note">{messages.burnedCaptionsUnavailable}</p>}
      <h3 className="export-jobs-title">{messages.exportQueue}</h3>
      {jobs.length === 0 ? <EmptyState>{messages.emptyJobs}</EmptyState> : <ul className="job-list">{jobs.map((job) => <JobRow key={job.id} job={job} controller={controller} messages={messages} />)}</ul>}
    </Panel>
  )
}

export function InterchangePanel({ controller, messages }: {
  controller: EditorController
  messages: Messages
}): React.JSX.Element {
  const project = controller.state.project!
  const preview = controller.state.otioImportPreview
  const [targetProjectId, setTargetProjectId] = useState('')
  useEffect(() => {
    setTargetProjectId(preview?.suggestedProjectId ?? '')
  }, [preview?.sourceDocumentDigest, preview?.suggestedProjectId])
  const tickets = controller.state.otioExportTickets
    .filter(({ projectId }) => projectId === project.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  const normalizedTarget = targetProjectId.trim()
  const targetValid = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(normalizedTarget) &&
    !controller.state.projects.some(({ id }) => id === normalizedTarget)
  return <Panel title={messages.interchangeTitle}>
    <p className="boundary-note">{messages.interchangeDescription}</p>
    <div className="button-row interchange-primary-actions">
      <button type="button" disabled={controller.state.busy} onClick={() => void controller.startOtioExport()}>
        {messages.interchangeExport}
      </button>
      <button type="button" disabled={controller.state.busy} onClick={() => void controller.previewOtioImport()}>
        {messages.interchangeImportPreview}
      </button>
    </div>

    {preview && <section className="interchange-import-preview" aria-label={messages.interchangeImportPreviewTitle}>
      <div className="interchange-heading">
        <strong>{messages.interchangeImportPreviewTitle}</strong>
        <span className="job-state">{preview.fidelity === 'kun-metadata'
          ? messages.interchangeFidelityKun
          : messages.interchangeFidelityPortable}</span>
      </div>
      <dl className="interchange-metrics">
        <div><dt>{messages.interchangeSourceDocument}</dt><dd>{preview.displayName}</dd></div>
        <div><dt>{messages.interchangeSourceProject}</dt><dd>{preview.sourceProjectId} · r{preview.sourceProjectRevision}</dd></div>
        <div><dt>{messages.interchangeFidelity}</dt><dd>{preview.fidelity === 'kun-metadata'
          ? messages.interchangeFidelityKun
          : messages.interchangeFidelityPortable}</dd></div>
      </dl>
      <p>{formatMessage(messages.interchangeRelinkRequired, {
        count: preview.mediaRelinkRequired.length
      })}</p>
      <p>{formatMessage(messages.interchangeTimecodeMappings, {
        count: preview.timecodeMappings.length + preview.timecodeMappingsTruncated
      })}</p>
      {preview.timecodeMappings.length > 0 && <details className="interchange-timecodes">
        <summary>{messages.interchangeTimecodeMappings.replace('{count}', String(preview.timecodeMappings.length))}</summary>
        <ul>{preview.timecodeMappings.slice(0, 8).map((mapping) => <li key={`${mapping.sequenceId}:${mapping.id}`}>
          <code>{mapping.id}</code><span>{mapping.startTimecode}–{mapping.endTimecode}</span>
        </li>)}</ul>
      </details>}
      <LossManifestView manifest={preview.lossManifest} messages={messages} />
      <label className="interchange-target-field">
        <span>{messages.interchangeTargetProject}</span>
        <input
          value={targetProjectId}
          maxLength={128}
          spellCheck={false}
          aria-invalid={!targetValid}
          onChange={(event) => setTargetProjectId(event.target.value)}
        />
      </label>
      <p className="boundary-note">{messages.interchangeImportCreatesNew}</p>
      <div className="button-row">
        <button
          type="button"
          disabled={controller.state.busy || !targetValid}
          onClick={() => void controller.confirmOtioImport(normalizedTarget)}
        >{messages.interchangeConfirmImport}</button>
        <button
          type="button"
          disabled={controller.state.busy}
          onClick={() => void controller.cancelOtioImportPreview()}
        >{messages.interchangeCancelImport}</button>
      </div>
    </section>}

    {tickets.length === 0
      ? <EmptyState>{messages.interchangeNoExports}</EmptyState>
      : <ul className="interchange-job-list">{tickets.map((ticket) => <InterchangeJobRow
          key={ticket.jobId}
          ticket={ticket}
          job={controller.state.jobs.find(({ id }) => id === ticket.jobId)}
          currentRevision={project.currentRevision}
          controller={controller}
          messages={messages}
        />)}</ul>}
  </Panel>
}

export function InterchangeJobRow(props: {
  ticket: OtioExportTicket
  job?: JobSnapshot
  currentRevision: number
  controller: EditorController
  messages: Messages
}): React.JSX.Element {
  const { ticket, job, controller, messages } = props
  const terminal = job ? ['completed', 'failed', 'cancelled', 'interrupted'].includes(job.state) : false
  const progress = job?.progress?.percentage ?? (
    job?.progress?.completed !== undefined && job.progress.total
      ? job.progress.completed / job.progress.total * 100
      : undefined
  )
  const artifact = job?.result?.generatedArtifacts.find((candidate) =>
    candidate.mediaKind === 'document' && candidate.mimeType === 'application/x-otio+json'
  )
  return <li className={`interchange-job job-${job?.state ?? 'unknown'}`}>
    <div className="interchange-heading">
      <div><strong>{messages.interchangeJobTitle}</strong><small>{ticket.documentDigest.slice(0, 12)}</small></div>
      <span className="job-state">{job ? jobStateLabel(messages, job.state) : messages.interchangeStatusUnavailable}</span>
    </div>
    <p>{formatMessage(messages.interchangePinnedRevision, {
      revision: ticket.pinnedRevision,
      sequence: ticket.sequenceId
    })}</p>
    {ticket.pinnedRevision !== props.currentRevision && <p className="stale-badge">{messages.interchangeOlderRevision}</p>}
    <dl className="interchange-metrics">
      <div><dt>{messages.interchangeDocumentSize}</dt><dd>{formatBytes(ticket.documentBytes)}</dd></div>
      <div><dt>SHA-256</dt><dd>{ticket.documentDigest.slice(0, 16)}…</dd></div>
    </dl>
    <LossManifestView manifest={ticket.lossManifest} messages={messages} />
    {job && <progress
      max={100}
      value={progress ?? (job.state === 'completed' ? 100 : undefined)}
      aria-label={formatMessage(messages.progressLabel, {
        label: messages.interchangeJobTitle,
        value: Math.round(progress ?? 0)
      })}
    />}
    {job && <p>{jobDetailLabel(messages, job)}</p>}
    <div className="button-row">
      <button type="button" disabled={controller.state.busy} onClick={() => void controller.refreshOtioExport(ticket.jobId)}>
        {messages.interchangeRefreshStatus}
      </button>
      {job && !terminal && <button
        type="button"
        className="danger-button"
        disabled={controller.state.busy}
        onClick={() => void controller.cancelOtioExport(ticket.jobId)}
      >{messages.cancelJob}</button>}
      {artifact && <button
        type="button"
        disabled={artifact.availability !== 'available'}
        onClick={() => void controller.openArtifact(artifact)}
      >{messages.openWithSystem}</button>}
      {artifact && <button
        type="button"
        disabled={artifact.availability !== 'available'}
        onClick={() => void controller.revealArtifact(artifact)}
      >{messages.showInFolder}</button>}
    </div>
  </li>
}

export function LossManifestView({ manifest, messages }: {
  manifest: InterchangeLossManifestProjection
  messages: Messages
}): React.JSX.Element {
  return <details className="interchange-loss" open={!manifest.portableLossless || !manifest.kunRoundTripLossless}>
    <summary>{messages.interchangeLossManifest}</summary>
    <p className={manifest.portableLossless ? 'package-complete' : 'package-incomplete'}>
      {manifest.portableLossless ? messages.interchangePortableLossless : messages.interchangePortableLossy}
    </p>
    <p className={manifest.kunRoundTripLossless ? 'package-complete' : 'package-incomplete'}>
      {manifest.kunRoundTripLossless ? messages.interchangeRoundTripLossless : messages.interchangeRoundTripLossy}
    </p>
    {manifest.entries.length === 0
      ? <p>{messages.interchangeNoReportedLosses}</p>
      : <ul>{manifest.entries.map((entry) => <li key={`${entry.code}:${entry.nodeId}`}>
          <strong>{entry.feature}</strong><code>{entry.nodeId}</code><span>{entry.message}</span>
        </li>)}</ul>}
    {manifest.truncated > 0 && <p className="package-incomplete">{formatMessage(
      messages.interchangeLossTruncated,
      { count: manifest.truncated }
    )}</p>}
  </details>
}

export function ProjectPackagePanel({ controller, messages }: {
  controller: EditorController
  messages: Messages
}): React.JSX.Element {
  const project = controller.state.project!
  const [missingMediaPolicy, setMissingMediaPolicy] = useState<'fail' | 'omit'>('fail')
  const [mediaScope, setMediaScope] = useState<'all' | 'selected'>('all')
  const [includeReceipts, setIncludeReceipts] = useState(true)
  const [includeAgentProvenance, setIncludeAgentProvenance] = useState(false)
  const selectedAssetIds = [...new Set([
    ...project.selection.selectedAssetIds,
    ...(controller.state.selectedAssetId ? [controller.state.selectedAssetId] : [])
  ])].filter((assetId) => project.assets.some(({ id }) => id === assetId))
  const tickets = controller.state.projectPackageTickets
    .filter(({ projectId }) => projectId === project.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void controller.startProjectPackage({
      missingMediaPolicy,
      includeReceipts,
      includeAgentProvenance,
      mediaScope,
      ...(mediaScope === 'selected' ? { assetIds: selectedAssetIds } : {})
    })
  }
  return (
    <Panel title={messages.projectPackageTitle}>
      <form className="project-package-form" onSubmit={submit}>
        <div className="project-package-options">
          <label>
            <span>{messages.projectPackageMediaScope}</span>
            <select value={mediaScope} onChange={(event) => setMediaScope(event.target.value as typeof mediaScope)}>
              <option value="all">{messages.projectPackageAllMedia}</option>
              <option value="selected" disabled={selectedAssetIds.length === 0}>
                {formatMessage(messages.projectPackageSelectedMedia, { count: selectedAssetIds.length })}
              </option>
            </select>
          </label>
          <label>
            <span>{messages.projectPackageMissingPolicy}</span>
            <select value={missingMediaPolicy} onChange={(event) => setMissingMediaPolicy(event.target.value as typeof missingMediaPolicy)}>
              <option value="fail">{messages.projectPackageFailMissing}</option>
              <option value="omit">{messages.projectPackageOmitMissing}</option>
            </select>
          </label>
          <label className="checkbox-field">
            <input type="checkbox" checked={includeReceipts} onChange={(event) => setIncludeReceipts(event.target.checked)} />
            <span>{messages.projectPackageIncludeReceipts}</span>
          </label>
          <label className="checkbox-field">
            <input type="checkbox" checked={includeAgentProvenance} onChange={(event) => setIncludeAgentProvenance(event.target.checked)} />
            <span>{messages.projectPackageIncludeAgentReference}</span>
          </label>
        </div>
        <button
          type="submit"
          disabled={controller.state.busy || (mediaScope === 'selected' && selectedAssetIds.length === 0)}
        >{messages.projectPackageExport}</button>
        <p className="boundary-note">{messages.projectPackagePrivacyBoundary}</p>
      </form>
      {tickets.length === 0
        ? <EmptyState>{messages.projectPackageEmptyJobs}</EmptyState>
        : <ul className="project-package-list">{tickets.map((ticket) => {
            const job = controller.state.jobs.find(({ id }) => id === ticket.jobId)
            return <ProjectPackageRow
              key={ticket.jobId}
              ticket={ticket}
              job={job}
              currentRevision={project.currentRevision}
              controller={controller}
              messages={messages}
            />
          })}</ul>}
    </Panel>
  )
}

export function ProjectPackageRow(props: {
  ticket: ProjectPackageTicket
  job?: JobSnapshot
  currentRevision: number
  controller: EditorController
  messages: Messages
}): React.JSX.Element {
  const { ticket, job, controller, messages } = props
  const terminal = job ? ['completed', 'failed', 'cancelled', 'interrupted'].includes(job.state) : false
  const progress = job?.progress?.percentage ?? (
    job?.progress?.completed !== undefined && job.progress.total
      ? job.progress.completed / job.progress.total * 100
      : undefined
  )
  const result = job ? projectPackageResultSummary(job) : undefined
  const stale = ticket.pinnedRevision !== props.currentRevision
  return (
    <li className={`project-package-job job-${job?.state ?? 'unknown'}`}>
      <div className="project-package-heading">
        <div>
          <strong>{messages.jobKindProjectPackage}</strong>
          <small>{ticket.packageId}</small>
        </div>
        <span className="job-state">{job ? jobStateLabel(messages, job.state) : messages.projectPackageStatusUnavailable}</span>
      </div>
      <p>{formatMessage(messages.projectPackagePinnedRevision, {
        revision: ticket.pinnedRevision,
        sequence: ticket.sequenceId
      })}</p>
      {stale && <p className="stale-badge">{messages.projectPackageOlderRevision}</p>}
      <dl className="project-package-metrics">
        <div><dt>{messages.projectPackageSelectedCount}</dt><dd>{ticket.selectedAssetCount}</dd></div>
        <div><dt>{messages.projectPackageEmbeddedCount}</dt><dd>{ticket.embeddedAssetCount}</dd></div>
        <div><dt>{messages.projectPackageUniqueCount}</dt><dd>{ticket.uniqueMediaCount}</dd></div>
        <div><dt>{messages.projectPackageDeduplicatedCount}</dt><dd>{ticket.deduplicatedAssetCount}</dd></div>
      </dl>
      <p className={ticket.complete ? 'package-complete' : 'package-incomplete'}>
        {ticket.complete ? messages.projectPackageComplete : messages.projectPackageIncomplete}
      </p>
      {ticket.missingAssetIds.length > 0 && <p className="project-package-missing">
        {formatMessage(messages.projectPackageMissingAssets, { ids: ticket.missingAssetIds.join(', ') })}
      </p>}
      <p className="subtle">{formatMessage(messages.projectPackageRequestedProvenance, {
        receipts: ticket.receiptsRequested ? messages.requested : messages.notRequested,
        agent: ticket.agentProvenanceRequested ? messages.requested : messages.notRequested
      })}</p>
      {job && <progress
        max={100}
        value={progress ?? (job.state === 'completed' ? 100 : undefined)}
        aria-label={formatMessage(messages.progressLabel, {
          label: messages.jobKindProjectPackage,
          value: Math.round(progress ?? 0)
        })}
      />}
      {job && <p>{jobDetailLabel(messages, job)}</p>}
      {result && <dl className="project-package-result">
        <div><dt>{messages.projectPackageOutput}</dt><dd>{result.displayName}</dd></div>
        <div><dt>{messages.projectPackageEntries}</dt><dd>{result.entryCount}</dd></div>
        <div><dt>{messages.projectPackageArchiveSize}</dt><dd>{formatBytes(result.archiveBytes)}</dd></div>
        <div><dt>SHA-256</dt><dd>{result.sha256}</dd></div>
      </dl>}
      <div className="button-row project-package-actions">
        <button type="button" disabled={controller.state.busy} onClick={() => void controller.refreshProjectPackage(ticket.jobId)}>
          {messages.projectPackageRefreshStatus}
        </button>
        {job && !terminal && <button
          type="button"
          className="danger-button"
          disabled={controller.state.busy}
          onClick={() => void controller.cancelProjectPackage(ticket.jobId)}
        >{messages.cancelJob}</button>}
      </div>
    </li>
  )
}
