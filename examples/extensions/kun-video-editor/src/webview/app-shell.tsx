import {
  useEffect,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PropsWithChildren,
  type ReactNode
} from 'react'
import type { EditorController } from './controller.js'
import { formatMessage, type Messages } from './i18n.js'
import type { MulticamPanelMessages } from './multicam-panel.js'
import {
  frameToSeconds,
  proofIsStale,
  type EditorState,
  type EditorWorkspace,
  type ProjectProjection
} from './model.js'
import { formatTime } from './app-common.js'

const SIDEBAR_BREAKPOINT_QUERY = '(max-width: 1180px)'

type WorkbenchIconName =
  | 'script'
  | 'clips'
  | 'timeline'
  | 'properties'
  | 'output'
  | 'project'
  | 'playhead'
  | 'proof'
  | 'back'
  | 'play'
  | 'pause'
  | 'forward'
  | 'split'
  | 'delete'

export function WorkbenchIcon({ name }: { name: WorkbenchIconName }): React.JSX.Element {
  const paths: Readonly<Record<WorkbenchIconName, ReactNode>> = {
    script: <><path d="M5 4.5h10v15H5z" /><path d="M8 8h4M8 11h5M8 14h3" /></>,
    clips: <><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="m8 13 2.5-2.5L15 15l2-2 3.5 3.5M8 9h.01" /></>,
    timeline: <><path d="M4 7h16M4 12h16M4 17h16" /><path d="M8 4v6M15 9v6M11 14v6" /></>,
    properties: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9M4 12h3M11 12h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="9" cy="17" r="2" /></>,
    output: <><path d="M12 4v11M8 8l4-4 4 4" /><path d="M5 13v6h14v-6" /></>,
    project: <><path d="M4 6h6l2 2h8v10H4z" /></>,
    playhead: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></>,
    proof: <><path d="m5 12 4 4L19 6" /></>,
    back: <><path d="m11 7-5 5 5 5M18 7v10" /></>,
    play: <><path d="m9 7 8 5-8 5z" /></>,
    pause: <><path d="M9 7v10M15 7v10" /></>,
    forward: <><path d="m13 7 5 5-5 5M6 7v10" /></>,
    split: <><circle cx="7" cy="7" r="2" /><circle cx="7" cy="17" r="2" /><path d="m9 8 9 8M9 16l9-8" /></>,
    delete: <><path d="M5 7h14M9 7V5h6v2M8 10v7M12 10v7M16 10v7M7 7l1 13h8l1-13" /></>
  }
  return (
    <svg className="workbench-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  )
}

export function multicamPanelMessages(messages: Messages): MulticamPanelMessages {
  return {
    title: messages.multicamTitle,
    subtitle: messages.multicamSubtitle,
    createGroup: messages.multicamCreateGroup,
    newGroupName: messages.multicamNewGroupName,
    sources: messages.multicamSources,
    sourceUnavailable: messages.multicamSourceUnavailable,
    referenceAngle: messages.multicamReferenceAngle,
    create: messages.multicamCreate,
    groups: messages.multicamGroups,
    emptyTitle: messages.multicamEmptyTitle,
    emptyBody: messages.multicamEmptyBody,
    duration: messages.multicamDuration,
    groupName: messages.multicamGroupName,
    saveName: messages.multicamSaveName,
    editRange: messages.multicamEditRange,
    startFrame: messages.multicamStartFrame,
    endFrame: messages.multicamEndFrame,
    coveragePolicy: messages.multicamCoveragePolicy,
    rejectIncomplete: messages.multicamRejectIncomplete,
    clampIncomplete: messages.multicamClampIncomplete,
    members: messages.multicamMembers,
    source: messages.multicamSource,
    memberLabel: messages.multicamMemberLabel,
    angleLabel: messages.multicamAngleLabel,
    saveLabels: messages.multicamSaveLabels,
    reference: messages.multicamReference,
    syncStatus: messages.multicamSyncStatus,
    syncConfidence: messages.multicamSyncConfidence,
    offsetFrames: messages.multicamOffsetFrames,
    coverage: messages.multicamCoverage,
    confirmSync: messages.multicamConfirmSync,
    verified: messages.multicamVerified,
    uncertain: messages.multicamUncertain,
    unknown: messages.multicamUnknown,
    switchToAngle: messages.multicamSwitchToAngle,
    layouts: messages.multicamLayouts,
    applyLayout: messages.multicamApplyLayout,
    noLayouts: messages.multicamNoLayouts,
    program: messages.multicamProgram,
    noProgram: messages.multicamNoProgram,
    angle: messages.multicamAngle,
    layout: messages.multicamLayout,
    previewRange: messages.multicamPreviewRange,
    mergeAdjacent: messages.multicamMergeAdjacent,
    actionFailed: messages.multicamActionFailed,
    working: messages.multicamWorking
  }
}


export function SequenceNavigator({ controller, messages }: {
  controller: EditorController
  messages: Messages
}): React.JSX.Element {
  const project = controller.state.project!
  const [name, setName] = useState('')
  const nestedBy = new Set(project.items.flatMap(({ nestedSequenceId }) => nestedSequenceId ? [nestedSequenceId] : []))
  const create = (event: FormEvent): void => {
    event.preventDefault()
    if (!name.trim()) return
    void controller.createSequence(name, true)
    setName('')
  }
  return (
    <section className="sequence-navigator" aria-label={messages.sequences}>
      <div className="sequence-strip" role="tablist" aria-label={messages.openSequences}>
        {project.sequences.filter(({ viewState }) => viewState.open).map((sequence) => (
          <button
            type="button"
            role="tab"
            key={sequence.id}
            aria-selected={sequence.id === project.activeSequenceId}
            onClick={() => void controller.selectSequence(sequence.id)}
          >
            <span>{sequence.name}</span>
            <small>{formatTime(frameToSeconds(project, sequence.durationFrames))}</small>
          </button>
        ))}
      </div>
      <details className="sequence-menu">
        <summary>{messages.manageSequences}</summary>
        <form className="sequence-create" onSubmit={create}>
          <label><span>{messages.sequenceName}</span><input value={name} maxLength={160} onChange={(event) => setName(event.target.value)} /></label>
          <button type="submit" disabled={!name.trim() || controller.state.busy}>{messages.createSequence}</button>
        </form>
        <ul className="sequence-list">
          {project.sequences.map((sequence) => {
            const active = sequence.id === project.activeSequenceId
            const deleteSafe = project.sequences.length > 1 && !active && !sequence.viewState.open &&
              !nestedBy.has(sequence.id) && (sequence.nestedByCount ?? 0) === 0
            return <li key={sequence.id}>
              <button type="button" className="sequence-identity" aria-current={active ? 'page' : undefined} onClick={() => void controller.selectSequence(sequence.id)}>
                <strong>{sequence.name}</strong>
                <small>{formatMessage(messages.sequenceCounts, { items: sequence.itemCount, captions: sequence.captionCount })}</small>
              </button>
              <div className="button-row sequence-actions">
                <button type="button" onClick={() => {
                  const next = window.prompt(messages.renameSequencePrompt, sequence.name)
                  if (next?.trim()) void controller.renameSequence(sequence.id, next)
                }}>{messages.rename}</button>
                <button type="button" onClick={() => {
                  const next = window.prompt(messages.duplicateSequencePrompt, `${sequence.name} ${messages.copySuffix}`)
                  if (next?.trim()) void controller.duplicateSequence(sequence.id, next, true)
                }}>{messages.duplicate}</button>
                {sequence.viewState.open
                  ? <button type="button" disabled={project.sequences.length < 2} onClick={() => void controller.closeSequence(sequence.id)}>{messages.close}</button>
                  : <button type="button" onClick={() => void controller.selectSequence(sequence.id)}>{messages.open}</button>}
                <button
                  type="button"
                  className="danger-button"
                  disabled={!deleteSafe}
                  title={!deleteSafe ? messages.sequenceDeleteBlocked : undefined}
                  onClick={() => window.confirm(formatMessage(messages.deleteSequenceConfirm, { name: sequence.name })) && void controller.deleteSequence(sequence.id)}
                >{messages.delete}</button>
              </div>
            </li>
          })}
        </ul>
      </details>
    </section>
  )
}

export function useCompactSidebar(): boolean {
  const [compact, setCompact] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
    return window.matchMedia(SIDEBAR_BREAKPOINT_QUERY).matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(SIDEBAR_BREAKPOINT_QUERY)
    const update = (): void => setCompact(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return compact
}

export function WorkbenchSectionTabs(props: {
  activeSection: EditorWorkspace
  onChange(section: EditorWorkspace): void
  messages: Messages
}): React.JSX.Element {
  const sections: ReadonlyArray<{ id: EditorWorkspace; label: string; icon: WorkbenchIconName }> = [
    { id: 'script', label: props.messages.workspaceScript, icon: 'script' },
    { id: 'clips', label: props.messages.workspaceClips, icon: 'clips' },
    { id: 'timeline', label: props.messages.workspaceTimeline, icon: 'timeline' },
    { id: 'properties', label: props.messages.workspaceProperties, icon: 'properties' },
    { id: 'output', label: props.messages.workspaceOutput, icon: 'output' }
  ]
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    const current = tabs.indexOf(event.target as HTMLButtonElement)
    if (current < 0) return
    event.preventDefault()
    const direction = event.currentTarget.ownerDocument?.dir === 'rtl' ? -1 : 1
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (current + (event.key === 'ArrowRight' ? direction : -direction) + tabs.length) % tabs.length
    tabs[next]?.focus()
    tabs[next]?.click()
  }
  return (
    <nav className="workbench-tabs" role="tablist" aria-label={props.messages.workspaceTabs} onKeyDown={handleKeyDown}>
      {sections.map((section) => (
        <button
          type="button"
          id={`video-editor-tab-${section.id}`}
          key={section.id}
          data-section={section.id}
          role="tab"
          aria-selected={props.activeSection === section.id}
          aria-controls={`video-editor-pane-${section.id}`}
          tabIndex={props.activeSection === section.id ? 0 : -1}
          onClick={() => props.onChange(section.id)}
        >
          <WorkbenchIcon name={section.icon} />
          <span>{section.label}</span>
        </button>
      ))}
    </nav>
  )
}

export function ProjectStatusStrip(props: {
  state: EditorState
  project: ProjectProjection
  messages: Messages
}): React.JSX.Element {
  const { state, project, messages } = props
  const completedArtifactJobIds = new Set(state.jobs
    .filter((job) => job.state === 'completed' && (job.result?.generatedArtifacts.length ?? 0) > 0)
    .map(({ id }) => id))
  const latestProof = [...state.renderTickets]
    .filter((ticket) =>
      ticket.projectId === project.id &&
      (ticket.renderKind === 'proof-frame' || ticket.renderKind === 'preview') &&
      completedArtifactJobIds.has(ticket.jobId)
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.jobId.localeCompare(left.jobId))[0]
  const proofState = !latestProof ? 'missing' : proofIsStale(latestProof, project) ? 'stale' : 'current'
  const proofLabel = !latestProof
    ? messages.proofFreshnessMissing
    : formatMessage(
        proofState === 'stale' ? messages.proofFreshnessStale : messages.proofFreshnessCurrent,
        { revision: latestProof.pinnedRevision }
      )
  return <div
    className="project-status-strip"
    role="status"
    aria-atomic="true"
    aria-label={messages.compactProjectStatus}
    data-proof-state={proofState}
  >
    <span className="project-status-item project-status-project" data-status-kind="project">
      <WorkbenchIcon name="project" />
      <strong>{messages.projectStatusProject}</strong>
      <span title={project.name}>{project.name} · r{project.currentRevision}</span>
    </span>
    <span className="project-status-item" data-status-kind="playhead">
      <WorkbenchIcon name="playhead" />
      <strong>{messages.projectStatusPlayhead}</strong>
      <span>{state.playheadFrame}f · {formatTime(frameToSeconds(project, state.playheadFrame))}</span>
    </span>
    <span className="project-status-item" data-status-kind="proof">
      <WorkbenchIcon name="proof" />
      <strong>{messages.projectStatusProof}</strong>
      <span>{proofLabel}</span>
    </span>
  </div>
}


export function WorkspaceDisclosure(props: PropsWithChildren<{ title: string }>): React.JSX.Element {
  return (
    <details className="workspace-disclosure">
      <summary><strong>{props.title}</strong><span aria-hidden="true">⌄</span></summary>
      <div className="workspace-disclosure-body">{props.children}</div>
    </details>
  )
}
