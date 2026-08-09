import { useEffect, useState } from 'react'
import type {
  MulticamPanelAsset,
  MulticamPanelGroup,
  MulticamPanelMember,
  MulticamPanelMessages,
  MulticamPanelRange,
  MulticamRenameRequest,
  MulticamSwitchRequest,
  MulticamSyncConfirmation
} from './multicam-panel.js'

export function MemberCard(props: {
  group: MulticamPanelGroup
  member: MulticamPanelMember
  asset?: MulticamPanelAsset
  range: MulticamPanelRange
  coveragePolicy: 'reject' | 'clamp'
  copy: MulticamPanelMessages
  disabled: boolean
  run(operation: () => void | Promise<void>): void
  onRenameLabels(request: MulticamRenameRequest): void | Promise<void>
  onConfirmSync(request: MulticamSyncConfirmation): void | Promise<void>
  onSwitch(request: MulticamSwitchRequest): void | Promise<void>
}): React.JSX.Element {
  const { group, member, copy } = props
  const isReference = member.id === group.referenceMemberId
  const [memberLabel, setMemberLabel] = useState(member.memberLabel)
  const [angleLabel, setAngleLabel] = useState(member.angleLabel)
  const [offsetFrames, setOffsetFrames] = useState(member.sync.offsetFrames)
  const [confidence, setConfidence] = useState(member.sync.confidence ?? 0)
  const [syncStatus, setSyncStatus] = useState<'verified' | 'uncertain'>(
    member.sync.status === 'verified' ? 'verified' : 'uncertain'
  )
  const coverage = coveragePercent(member.coverage, group.durationFrames)
  const syncText = syncStatusLabel(member.sync.status, copy)
  const confidenceText = member.sync.confidence === undefined
    ? '—'
    : `${Math.round(member.sync.confidence * 100)}%`

  useEffect(() => setMemberLabel(member.memberLabel), [member.memberLabel])
  useEffect(() => setAngleLabel(member.angleLabel), [member.angleLabel])
  useEffect(() => setOffsetFrames(member.sync.offsetFrames), [member.sync.offsetFrames])
  useEffect(() => setConfidence(member.sync.confidence ?? 0), [member.sync.confidence])
  useEffect(() => {
    setSyncStatus(member.sync.status === 'verified' ? 'verified' : 'uncertain')
  }, [member.sync.status])

  return (
    <li className="multicam-member-card" data-sync-status={member.sync.status}>
      <header>
        <div>
          <strong>{member.angleLabel}</strong>
          <span>{member.memberLabel}</span>
        </div>
        {isReference && <span className="multicam-reference-badge">{copy.reference}</span>}
      </header>
      <dl className="multicam-member-facts">
        <div><dt>{copy.source}</dt><dd>{props.asset?.name ?? member.assetId}</dd></div>
        <div><dt>{copy.coverage}</dt><dd>{coverage}%</dd></div>
        <div>
          <dt>{copy.syncStatus}</dt>
          <dd aria-label={`${copy.syncStatus}: ${syncText}; ${copy.syncConfidence}: ${confidenceText}`}>
            {syncText} · {confidenceText}
          </dd>
        </div>
        <div><dt>{copy.offsetFrames}</dt><dd>{member.sync.offsetFrames}</dd></div>
      </dl>
      <div className="multicam-coverage-meter" aria-label={`${copy.coverage}: ${coverage}%`}>
        <span style={{ inlineSize: `${coverage}%` }} />
      </div>

      <details className="multicam-member-editor">
        <summary>{copy.saveLabels}</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            const nextMemberLabel = memberLabel.normalize('NFKC').trim()
            const nextAngleLabel = angleLabel.normalize('NFKC').trim()
            if (!nextMemberLabel || !nextAngleLabel) return
            props.run(() => props.onRenameLabels({
              groupId: group.id,
              memberId: member.id,
              memberLabel: nextMemberLabel,
              angleLabel: nextAngleLabel
            }))
          }}
        >
          <label>
            <span>{copy.memberLabel}</span>
            <input
              value={memberLabel}
              maxLength={96}
              disabled={props.disabled}
              onChange={(event) => setMemberLabel(event.target.value)}
            />
          </label>
          <label>
            <span>{copy.angleLabel}</span>
            <input
              value={angleLabel}
              maxLength={96}
              disabled={props.disabled}
              onChange={(event) => setAngleLabel(event.target.value)}
            />
          </label>
          <button type="submit" disabled={props.disabled || !memberLabel.trim() || !angleLabel.trim()}>
            {copy.saveLabels}
          </button>
        </form>
      </details>

      {!isReference && (
        <details className="multicam-sync-editor">
          <summary>{copy.confirmSync}</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              props.run(() => props.onConfirmSync({
                groupId: group.id,
                memberId: member.id,
                offsetFrames,
                status: syncStatus,
                confidence: Number.isFinite(confidence) ? clamp(confidence, 0, 1) : 0
              }))
            }}
          >
            <label>
              <span>{copy.offsetFrames}</span>
              <input
                type="number"
                step={1}
                value={offsetFrames}
                disabled={props.disabled}
                onChange={(event) => setOffsetFrames(integerInput(event.target.value, 0))}
              />
            </label>
            <label>
              <span>{copy.syncConfidence}</span>
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                required
                value={confidence}
                disabled={props.disabled}
                onChange={(event) => setConfidence(Number(event.target.value))}
              />
            </label>
            <label>
              <span>{copy.syncStatus}</span>
              <select
                value={syncStatus}
                disabled={props.disabled}
                onChange={(event) => setSyncStatus(event.target.value as 'verified' | 'uncertain')}
              >
                <option value="verified">{copy.verified}</option>
                <option value="uncertain">{copy.uncertain}</option>
              </select>
            </label>
            <button type="submit" disabled={props.disabled}>{copy.confirmSync}</button>
          </form>
        </details>
      )}

      <button
        type="button"
        className="multicam-switch-button"
        disabled={props.disabled || member.sync.status === 'unknown'}
        onClick={() => props.run(() => props.onSwitch({
          groupId: group.id,
          memberId: member.id,
          range: props.range,
          coveragePolicy: props.coveragePolicy
        }))}
      >{copy.switchToAngle}</button>
    </li>
  )
}

function coveragePercent(coverage: readonly MulticamPanelRange[], durationFrames: number): number {
  if (durationFrames <= 0) return 0
  const normalized = coverage
    .map(({ startFrame, endFrame }) => ({
      startFrame: clamp(Math.trunc(startFrame), 0, durationFrames),
      endFrame: clamp(Math.trunc(endFrame), 0, durationFrames)
    }))
    .filter(({ startFrame, endFrame }) => endFrame > startFrame)
    .sort((left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame)
  let covered = 0
  let cursorStart = -1
  let cursorEnd = -1
  for (const range of normalized) {
    if (range.startFrame > cursorEnd) {
      if (cursorEnd > cursorStart) covered += cursorEnd - cursorStart
      cursorStart = range.startFrame
      cursorEnd = range.endFrame
    } else {
      cursorEnd = Math.max(cursorEnd, range.endFrame)
    }
  }
  if (cursorEnd > cursorStart) covered += cursorEnd - cursorStart
  return Math.round((covered / durationFrames) * 100)
}


function syncStatusLabel(status: MulticamPanelMember['sync']['status'], copy: MulticamPanelMessages): string {
  if (status === 'reference') return copy.reference
  if (status === 'verified') return copy.verified
  if (status === 'uncertain') return copy.uncertain
  return copy.unknown
}

function integerInput(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
