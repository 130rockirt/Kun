import type { MediaSearchResult } from '../engine/media-search.js'
import type { EditorController } from './controller.js'
import { formatMessage, type Messages } from './i18n.js'
import {
  projectFrameFromSourceTime,
  type AssetProjection,
  type ItemProjection,
  type ProjectProjection
} from './model.js'

export function SearchResultRow(props: {
  controller: EditorController
  project: ProjectProjection
  result: MediaSearchResult
  messages: Messages
}): React.JSX.Element {
  const { controller, project, result, messages } = props
  const asset = project.assets.find(({ id }) => id === result.assetId)
  const targetTrackKind = asset?.kind === 'audio' ? 'audio' : 'video'
  const track = project.tracks.find(({ kind }) => kind === targetTrackKind)
  const preview = async (): Promise<void> => {
    await controller.openAsset(result.assetId)
    const item = project.items.find((candidate) =>
      candidate.assetId === result.assetId &&
      candidate.sourceStartUs <= result.sourceRange.startUs &&
      result.sourceRange.startUs < candidate.sourceEndUs
    )
    if (item) {
      controller.seek(projectFrameFromSourceTime(
        project,
        { item },
        result.sourceRange.startUs / 1_000_000
      ))
    }
  }
  const insert = async (): Promise<void> => {
    if (!asset || !track) return
    const item = insertionItem(project, result, track.id, asset.kind, controller.state.playheadFrame)
    await controller.applyOperations(
      [{ type: 'add-item', item }],
      formatMessage(messages.searchInsertSummary, { name: asset.name })
    )
  }
  return (
    <li className="media-search-result">
      <div>
        <strong>{result.assetName}</strong>
        <span className="evidence-badge">
          {result.evidenceKind === 'spoken'
            ? messages.searchEvidenceSpoken
            : result.evidenceKind === 'visual'
              ? messages.searchEvidenceVisual
              : messages.searchEvidenceFilename}
        </span>
      </div>
      <p>{result.excerpt}</p>
      <small>
        {formatSourceTime(result.sourceRange.startUs)}–{formatSourceTime(result.sourceRange.endUs)} · {' '}
        {result.scoreSemantics}
      </small>
      <div className="button-row">
        <button type="button" className="quiet-button" onClick={() => void preview()}>
          {messages.previewSourceRange}
        </button>
        <button type="button" disabled={!track || controller.state.busy} onClick={() => void insert()}>
          {messages.insertSourceRange}
        </button>
      </div>
    </li>
  )
}

function insertionItem(
  project: ProjectProjection,
  result: MediaSearchResult,
  trackId: string,
  assetKind: AssetProjection['kind'],
  timelineStartFrame: number
): ItemProjection {
  const durationUs = result.sourceRange.endUs - result.sourceRange.startUs
  const durationFrames = Math.max(1, Math.round(
    durationUs * project.fps.numerator / (1_000_000 * project.fps.denominator)
  ))
  return {
    id: `search-insert-${Date.now().toString(36)}`,
    assetId: result.assetId,
    trackId,
    timelineStartFrame,
    durationFrames,
    sourceStartUs: result.sourceRange.startUs,
    sourceEndUs: result.sourceRange.endUs,
    speed: { numerator: 1, denominator: 1 },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    opacity: 1,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    ...(assetKind === 'audio' ? { volume: 1 } : {})
  }
}


function formatSourceTime(valueUs: number): string {
  const seconds = valueUs / 1_000_000
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${(seconds - minutes * 60).toFixed(2).padStart(5, '0')}`
}
