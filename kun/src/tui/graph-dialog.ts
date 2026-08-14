import {
  Editor,
  Input,
  Markdown,
  ProcessTerminal,
  TUI,
  decodeKittyPrintable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type EditorTheme,
  type Focusable,
  type MarkdownTheme,
  type OverlayHandle,
  type SelectListTheme,
  type SlashCommand
} from '@earendil-works/pi-tui'
import {
  providerCatalogEntries,
  type ProviderCatalogAuthFlow,
  type ProviderCatalogAuthType,
  type ProviderCatalogKind
} from '@kun/provider-catalog'
import { spawn } from 'node:child_process'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { stdin as processStdin, stdout as processStdout } from 'node:process'
import { redactSecrets, redactSecretText } from '../config/secret-redaction.js'
import { withRuntimeDataDirAncillaryWriter } from '../server/runtime-data-dir-lease.js'
import type { AttachmentMetadata } from '../contracts/attachments.js'
import type { TurnItem } from '../contracts/items.js'
import type { ModelReasoningEffort } from '../contracts/capabilities.js'
import {
  KUN_TOOL_PERMISSION_MODES,
  kunToolPermissionModeFromSettings,
  kunToolPermissionModeSettings,
  type ApprovalPolicy,
  type ApprovalReviewer,
  type KunToolPermissionMode,
  type SandboxMode
} from '../contracts/policy.js'
import {
  isModelConnectionProfileUsable,
  type ClaudeSdkInstallStatus,
  type ModelConnectionOAuthStatus,
  type ModelConnectionProfile,
  type ModelConnectionSnapshot
} from '../contracts/model-connections.js'
import type { TuiCommand, TuiCommandDefinition } from './commands.js'
import { parseTuiCommand, TUI_COMMAND_DEFINITIONS, TUI_SLASH_COMMANDS } from './commands.js'
import { runSelfUpdateCommand } from '../cli/self-update.js'
import {
  activityFrame,
  formatContextGauge,
  formatTokenCount,
  type ActivityVisualKind
} from './activity.js'
import { parseTuiKeymapConfig, type TuiKeyAction, type TuiKeymap } from './keymap.js'
import { TuiClientError, type KunTuiClient, type SkillsSnapshot } from './client.js'
import type { TuiControllerState } from './controller.js'
import { TuiController } from './controller.js'
import {
  sanitizeTerminalText as stripTerminalControls,
  wrapText
} from './layout.js'
import { codeFenceLanguage, highlightTerminalCode, terminalAssistantMarkdown } from './markdown-code.js'
import {
  contextualFooter,
  pageFrame,
  sectionLabel,
  selectionRow,
  statusGlyph,
  visual,
  visualDensity
} from './visual-system.js'
import { InlineStreamTerminal, ScrollbackPreservingTerminal } from './pi-terminal.js'
import { ProviderQuotaDialog } from './provider-quota.js'
import { UsageDialog } from './usage-report.js'
import {
  installAntigravityCli,
  resolveAntigravityCliCommand,
  resolveGeminiCliCommand,
  type OfficialProviderCliId
} from '../services/official-provider-cli.js'
import {
  copyWithSystemClipboard,
  editTextInExternalEditor,
  lastAssistantText,
  osc52ClipboardSequence,
  renderThreadMarkdown,
  runInteractiveProviderCli,
  writeThreadExport
} from './operations.js'
import {
  applyRuntimeEvent,
  hydrateProjectedChildRuns,
  matchingRequestContextSnapshot,
  projectThreadSnapshot,
  type ProjectedApprovalReview,
  type ProjectedChildRun,
  type ProjectedTurnActivity,
  type ThreadProjection
} from './state.js'
import type { TerminalInput, TerminalOutput } from './pi-terminal.js'
import {
  latestTuiGraphRun,
  moveTuiGraphBoardSelection,
  projectTuiGraphBoard,
  type TuiGraphBoardNode,
  type TuiGraphBoardProjection,
  summarizeTuiGraphRun
} from './graph-mode.js'
import {
  answerCurrentUserInputWithText,
  confirmCurrentUserInput,
  createUserInputSession,
  currentUserInputQuestion,
  isUserInputSessionComplete,
  moveUserInputOption,
  orderedUserInputAnswers,
  selectedUserInputLabels,
  toggleCurrentUserInputOption,
  type UserInputSession
} from './user-input.js'
import {
  ClipboardImageError,
  clipboardImageEmptyHint,
  readClipboardImage,
  type ClipboardImage
} from './clipboard-image.js'
import { WorkspaceFileAutocompleteProvider } from './file-mentions.js'
import { bold, dim, blue, cyan, green, yellow, red, magenta, italic, isCancelInput, EXIT_CONFIRM_WINDOW_MS, UNDO_ESCAPE_WINDOW_MS, TOTAL_ELAPSED_MIN_START_GAP_MS, BRACKETED_PASTE_START, BRACKETED_PASTE_END, ENABLE_MOUSE_TRACKING, DISABLE_MOUSE_TRACKING, DIRECT_SEMANTIC_ACTIONS, sanitizeTerminalText, selectTheme, editorTheme, markdownTheme, parseSgrMouseEvent, writeLocalShareSnapshot, removeLocalShareSnapshot, type SgrMouseEvent, type ExclusiveRouteHandle } from './pi-common.js'
import { popupFrame } from './render-utils.js'
import { joinSides } from './render-layout.js'

export type GraphBoardRenderedLine = {
  text: string
  nodeId?: string
}

export class GraphBoardDialog implements Component, Focusable {
  private state: TuiControllerState
  private selectedId?: string
  private currentBoard?: TuiGraphBoardProjection
  private readonly nodeRows = new Map<number, string>()
  private lastRenderedHeight = 0
  private _focused = false

  constructor(private readonly input: {
    tui: TUI
    controller: TuiController
    state: TuiControllerState
    runId: string
    terminalRows: () => number
    initialNodeId?: string
    close: () => void
    openWorker: (runId: string, nodeId: string, childThreadId: string) => void
  }) {
    this.state = input.state
    this.selectedId = input.initialNodeId
  }

  get focused(): boolean { return this._focused }
  set focused(value: boolean) { this._focused = value }

  selectedNodeId(): string {
    return this.currentBoard?.selectedNodeId ?? this.selectedId ?? ''
  }

  update(state: TuiControllerState): void {
    this.state = state
    this.input.tui.requestRender()
  }

  render(width: number): string[] {
    const run = this.state.graphRuns.find((candidate) => candidate.id === this.input.runId)
    if (!run) {
      const lines = popupFrame('GRAPH', [
        '',
        ` ${red('GraphRun is no longer available.')}`,
        '',
        contextualFooter([{ key: 'Esc', label: 'back' }], Math.max(12, width - 4))
      ], width)
      this.lastRenderedHeight = lines.length
      return lines
    }

    const safeWidth = Math.max(48, width)
    const inner = safeWidth - 4
    const board = projectTuiGraphBoard(run, {
      ...(this.selectedId ? { selectedNodeId: this.selectedId } : {}),
      width: inner,
      height: this.input.terminalRows()
    })
    this.currentBoard = board
    this.selectedId = board.selectedNodeId
    const selected = board.nodes.find((node) => node.id === board.selectedNodeId)!
    const summary = joinSides(
      ` ${graphRunStatusText(board.status)}  ${sanitizeTerminalText(board.title)}`,
      `${board.progress.accepted}/${board.progress.total} accepted · ${board.progress.activeAgents} agents · r${board.revision}`,
      inner
    )
    const goal = truncateToWidth(` ${dim('Goal')}  ${sanitizeTerminalText(board.goal)}`, inner)
    const availableRows = Math.max(7, Math.floor(this.input.terminalRows() * 0.78) - 7)
    const body: GraphBoardRenderedLine[] = [
      { text: summary },
      { text: goal },
      { text: '' }
    ]

    if (board.renderMode === 'topology') {
      const inspectorWidth = Math.max(30, Math.min(42, Math.floor(inner * 0.36)))
      const graphWidth = Math.max(28, inner - inspectorWidth - 3)
      const graphRows = visibleGraphBoardRows(
        graphBoardRows(board, graphWidth, true),
        board.selectedNodeId,
        availableRows
      )
      const inspectorRows = graphInspectorRows(selected, inspectorWidth)
      const rowCount = Math.max(graphRows.length, Math.min(availableRows, inspectorRows.length))
      for (let index = 0; index < rowCount; index += 1) {
        const graphLine = graphRows[index]
        const detailLine = inspectorRows[index] ?? ''
        body.push({
          text: joinGraphColumns(graphLine?.text ?? '', detailLine, graphWidth, inspectorWidth),
          ...(graphLine?.nodeId ? { nodeId: graphLine.nodeId } : {})
        })
      }
    } else {
      const compactInspector = graphCompactInspectorRows(selected, inner)
      const listRows = visibleGraphBoardRows(
        graphBoardRows(board, inner, false),
        board.selectedNodeId,
        Math.max(4, availableRows - compactInspector.length)
      )
      body.push(...listRows)
      body.push(...compactInspector.map((text) => ({ text })))
    }

    body.push({
      text: contextualFooter([
        { key: '↑/↓', label: 'select' },
        { key: 'Enter', label: selected.childThreadId ? 'worker session' : 'worker unavailable' },
        { key: 'Esc', label: 'back' }
      ], inner)
    })
    const lines = popupFrame(`GRAPH · ${board.status}`, body.map((line) => line.text), safeWidth)
    this.nodeRows.clear()
    body.forEach((line, index) => {
      if (line.nodeId) this.nodeRows.set(index + 1, line.nodeId)
    })
    this.lastRenderedHeight = lines.length
    return lines
  }

  handleInput(data: string): void {
    const mouse = parseSgrMouseEvent(data)
    if (mouse) {
      this.handleMouse(mouse)
      return
    }
    if (isCancelInput(data)) {
      this.input.close()
      return
    }
    const board = this.currentBoard
    if (!board) return
    if (matchesKey(data, 'up') || data.toLowerCase() === 'k') {
      this.selectedId = moveTuiGraphBoardSelection(board, -1)
    } else if (matchesKey(data, 'down') || data.toLowerCase() === 'j') {
      this.selectedId = moveTuiGraphBoardSelection(board, 1)
    } else if (matchesKey(data, 'pageUp')) {
      this.selectedId = moveTuiGraphBoardSelection(board, -5)
    } else if (matchesKey(data, 'pageDown')) {
      this.selectedId = moveTuiGraphBoardSelection(board, 5)
    } else if (matchesKey(data, 'home') || data === 'g') {
      this.selectedId = board.nodes[0]?.id
    } else if (matchesKey(data, 'end') || data === 'G') {
      this.selectedId = board.nodes.at(-1)?.id
    } else if (matchesKey(data, 'enter')) {
      this.openSelectedWorker(board)
      return
    } else {
      return
    }
    this.input.tui.requestRender()
  }

  handleMouse(mouse: SgrMouseEvent): void {
    if (!mouse.pressed) return
    const board = this.currentBoard
    if (!board) return
    if ((mouse.button & 64) !== 0) {
      this.selectedId = moveTuiGraphBoardSelection(
        board,
        (mouse.button & 1) === 0 ? -3 : 3
      )
      this.input.tui.requestRender()
      return
    }
    if ((mouse.button & 3) !== 0) return
    const row = centeredOverlayRow(
      mouse.y,
      this.lastRenderedHeight,
      this.input.terminalRows()
    )
    const nodeId = row === undefined ? undefined : this.nodeRows.get(row)
    if (!nodeId) return
    this.selectedId = nodeId
    this.input.tui.requestRender()
  }

  invalidate(): void {}

  private openSelectedWorker(board: TuiGraphBoardProjection): void {
    const node = board.nodes.find((candidate) => candidate.id === board.selectedNodeId)
    if (!node?.childThreadId) {
      this.input.controller.notify('This Graph node does not have an available worker session yet.', 'error')
      return
    }
    this.input.openWorker(board.runId, node.id, node.childThreadId)
  }
}

export function graphBoardRows(
  board: TuiGraphBoardProjection,
  width: number,
  topology: boolean
): GraphBoardRenderedLine[] {
  const rows: GraphBoardRenderedLine[] = []
  for (const phase of board.phases) {
    rows.push({ text: sectionLabel(`Phase ${phase.order + 1} · ${phase.title}`, width) })
    for (const node of phase.nodes) {
      if (topology && node.dependencies.length) {
        const dependencies = node.dependencies.map((edge) =>
          `${edge.from} ─${edge.label}→ ${node.id}`
        ).join('  ')
        rows.push({ text: truncateToWidth(`   ${dim(dependencies)}`, width) })
      }
      rows.push({
        text: selectionRow(
          `${graphNodeMarker(node)} ${sanitizeTerminalText(node.id)}  ${sanitizeTerminalText(node.title)}`,
          `${node.status} · ${sanitizeTerminalText(node.assignment)}`,
          width,
          node.id === board.selectedNodeId,
          0
        ),
        nodeId: node.id
      })
      if (topology && node.dependents.length) {
        const outgoing = node.dependents.map((edge) =>
          `${node.id} ─${edge.label}→ ${edge.to}`
        ).join('  ')
        rows.push({ text: truncateToWidth(`   ${dim(outgoing)}`, width) })
      }
    }
  }
  return rows
}

export function graphInspectorRows(node: TuiGraphBoardNode, width: number): string[] {
  const dependencies = node.dependencies.length
    ? node.dependencies.map((edge) => `${edge.from} (${edge.label})`).join(', ')
    : 'none'
  const rows = [
    sectionLabel(`Node ${node.id}`, width),
    ` ${graphNodeMarker(node)} ${bold(sanitizeTerminalText(node.title))}`,
    ` ${dim('Status')}   ${graphNodeStatusText(node.status)}`,
    ` ${dim('Phase')}    ${sanitizeTerminalText(node.phaseTitle)}`,
    ` ${dim('Agent')}    ${sanitizeTerminalText(node.assignment)}`,
    ` ${dim('Attempt')}  ${node.attemptNumber
      ? `${node.attemptNumber}${node.attemptStatus ? ` · ${node.attemptStatus}` : ''}`
      : 'not started'}`,
    ` ${dim('Depends')}  ${sanitizeTerminalText(dependencies)}`,
    '',
    ` ${dim('Objective')}`,
    ...wrapText(sanitizeTerminalText(node.objective), Math.max(8, width - 2))
      .slice(0, 4)
      .map((line) => ` ${line}`),
    ...(node.progressSummary
      ? ['', ` ${dim('Progress')}`, ...wrapText(
          sanitizeTerminalText(node.progressSummary),
          Math.max(8, width - 2)
        ).slice(0, 2).map((line) => ` ${line}`)]
      : []),
    ...(node.lastTransitionReason
      ? ['', ` ${dim('Latest')}`, ...wrapText(
          sanitizeTerminalText(node.lastTransitionReason),
          Math.max(8, width - 2)
        ).slice(0, 2).map((line) => ` ${line}`)]
      : []),
    ...(node.childThreadId
      ? ['', ` ${dim('Worker')}   ${sanitizeTerminalText(node.childThreadId)}`]
      : [])
  ]
  return rows.map((line) => truncateToWidth(line, width))
}

export function graphCompactInspectorRows(node: TuiGraphBoardNode, width: number): string[] {
  const dependencies = node.dependencies.length
    ? node.dependencies.map((edge) => `${edge.from} (${edge.label})`).join(', ')
    : 'none'
  const rows = [
    sectionLabel(`Node ${node.id}`, width),
    ` ${graphNodeMarker(node)} ${bold(sanitizeTerminalText(node.title))} · ${graphNodeStatusText(node.status)}`,
    ` ${dim('Agent')} ${sanitizeTerminalText(node.assignment)} · ${dim('Attempt')} ${
      node.attemptNumber
        ? `${node.attemptNumber}${node.attemptStatus ? ` (${node.attemptStatus})` : ''}`
        : 'not started'
    }`,
    ` ${dim('Depends')} ${sanitizeTerminalText(dependencies)}`,
    ` ${dim('Latest')} ${sanitizeTerminalText(node.lastTransitionReason ?? 'No transition reason recorded.')}`,
    ` ${dim('Worker')} ${sanitizeTerminalText(node.childThreadId ?? 'not available')}`
  ]
  return rows.map((line) => truncateToWidth(line, width))
}

export function visibleGraphBoardRows(
  rows: GraphBoardRenderedLine[],
  selectedNodeId: string,
  limit: number
): GraphBoardRenderedLine[] {
  if (rows.length <= limit) return rows
  const selectedRow = Math.max(0, rows.findIndex((row) => row.nodeId === selectedNodeId))
  const start = Math.max(0, Math.min(
    selectedRow - Math.floor(limit / 2),
    rows.length - limit
  ))
  return rows.slice(start, start + limit)
}

export function joinGraphColumns(
  left: string,
  right: string,
  leftWidth: number,
  rightWidth: number
): string {
  const clippedLeft = truncateToWidth(left, leftWidth)
  const paddedLeft = `${clippedLeft}${' '.repeat(Math.max(0, leftWidth - visibleWidth(clippedLeft)))}`
  return `${paddedLeft} ${dim('│')} ${truncateToWidth(right, rightWidth)}`
}

export function graphNodeMarker(node: TuiGraphBoardNode): string {
  switch (node.status) {
    case 'accepted': return green(node.marker)
    case 'failed':
    case 'blocked': return red(node.marker)
    case 'queued':
    case 'repair_required': return yellow(node.marker)
    case 'running':
    case 'submitted':
    case 'reviewing': return cyan(node.marker)
    default: return dim(node.marker)
  }
}

export function graphNodeStatusText(status: TuiGraphBoardNode['status']): string {
  if (status === 'accepted') return green(status)
  if (status === 'failed' || status === 'blocked') return red(status)
  if (status === 'queued' || status === 'repair_required') return yellow(status)
  if (status === 'running' || status === 'submitted' || status === 'reviewing') {
    return cyan(status)
  }
  return dim(status)
}

export function graphRunStatusText(status: TuiGraphBoardProjection['status']): string {
  if (status === 'completed') return green(status)
  if (status === 'failed' || status === 'cancelled') return red(status)
  if (status === 'paused' || status === 'awaiting_human') return yellow(status)
  return cyan(status)
}

export function centeredOverlayRow(
  terminalRow: number,
  renderedHeight: number,
  terminalHeight: number
): number | undefined {
  if (terminalRow < 1 || renderedHeight < 1) return undefined
  const availableHeight = Math.max(1, terminalHeight - 2)
  const maxHeight = Math.max(1, Math.min(Math.floor(terminalHeight * 0.85), availableHeight))
  const effectiveHeight = Math.min(renderedHeight, maxHeight)
  const overlayTop = 1 + Math.floor((availableHeight - effectiveHeight) / 2)
  const row = terminalRow - 1 - overlayTop
  return row >= 0 && row < effectiveHeight ? row : undefined
}
