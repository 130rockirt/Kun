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
import { elapsedDuration, formatDurationMs, plainLines, summarize } from './render-utils.js'

export type RenderedChildRow = {
  start: number
  end: number
  child: ProjectedChildRun
}

export class ChildRunGroupComponent {
  private children: ProjectedChildRun[]
  private expanded: boolean
  private rows: RenderedChildRow[] = []

  constructor(children: ProjectedChildRun[], expanded: boolean) {
    this.children = sortChildRuns(children)
    this.expanded = expanded
  }

  update(children: ProjectedChildRun[], expanded: boolean): void {
    this.children = sortChildRuns(children)
    this.expanded = expanded
  }

  childRows(): readonly RenderedChildRow[] {
    return this.rows
  }

  render(width: number, animationFrame = 0): string[] {
    const lines: string[] = []
    this.rows = []
    const counts = childStatusCounts(this.children)
    const active = counts.running + counts.waiting + counts.background > 0
    const failed = counts.failed > 0
    const icon = active
      ? cyan(activityFrame('subagent', animationFrame))
      : failed
        ? red('✗')
        : green('●')
    const breakdown = [
      counts.completed ? `${counts.completed} done` : undefined,
      counts.failed ? `${counts.failed} failed` : undefined,
      counts.running ? `${counts.running} running` : undefined,
      counts.waiting ? `${counts.waiting} waiting` : undefined,
      counts.background ? `${counts.background} background` : undefined
    ].filter(Boolean).join(', ')
    const totalTools = this.children.reduce((sum, child) => sum + (child.toolInvocations ?? 0), 0)
    const totalTokens = this.children.reduce((sum, child) => sum + (child.totalTokens ?? 0), 0)
    const maxElapsed = Math.max(0, ...this.children.map((child) =>
      child.durationMs ?? elapsedMilliseconds(child.startedAt, child.updatedAt, isActiveChildRun(child))
    ))
    const metrics = [
      totalTools ? `${totalTools} tools` : undefined,
      totalTokens ? `${formatTokenCount(totalTokens)} tok` : undefined,
      maxElapsed ? formatDurationMs(maxElapsed) : undefined
    ].filter(Boolean).join(' · ')
    lines.push(truncateToWidth(
      `   ${icon} ${bold(active ? `Running ${this.children.length} agents` : `${this.children.length} agents finished`)}${breakdown ? ` ${dim(`(${breakdown})`)}` : ''}${metrics ? ` ${dim(`· ${metrics}`)}` : ''}`,
      Math.max(8, width)
    ))

    this.children.forEach((child, index) => {
      const start = lines.length
      const last = index === this.children.length - 1
      const branch = last ? '└─' : '├─'
      const continuation = last ? '  ' : '│ '
      const label = sanitizeTerminalText(child.profileName || child.profile || 'agent')
      const description = sanitizeTerminalText(child.label || child.prompt || child.childId)
      const status = childStatusLabel(child)
      lines.push(truncateToWidth(
        `   ${dim(branch)} ${cyan(label)} ${dim(`· ${description}`)}${childMetrics(child) ? ` ${dim(`· ${childMetrics(child)}`)}` : ''} ${childStatusColor(child, status)}`,
        Math.max(8, width)
      ))
      if (isActiveChildRun(child) && child.activity) {
        const elapsed = elapsedDuration(child.activity.startedAt, undefined, true)
        lines.push(truncateToWidth(
          `   ${continuation}   ${cyan(activityFrame(childActivityVisualKind(child), animationFrame))} ${sanitizeTerminalText(child.activity.label)}${elapsed ? ` ${dim(`· ${elapsed}`)}` : ''}`,
          Math.max(8, width)
        ))
      } else {
        const preview = child.text || (isActiveChildRun(child)
          ? child.status === 'queued' ? 'Waiting to start…' : 'Working independently…'
          : child.prompt)
        if (preview) {
          const previewLines = plainLines(preview, Math.max(8, width - 10), 0)
            .slice(0, this.expanded ? 6 : isActiveChildRun(child) ? 1 : 0)
          for (const line of previewLines) lines.push(dim(`   ${continuation}   ${line}`))
        }
      }
      if (
        this.expanded &&
        child.prompt &&
        (isActiveChildRun(child) || Boolean(child.text && child.prompt !== child.text))
      ) {
        lines.push(dim(`   ${continuation}   Task: ${truncateToWidth(sanitizeTerminalText(child.prompt), Math.max(8, width - 12))}`))
      }
      this.rows.push({ start, end: Math.max(start, lines.length - 1), child })
    })
    lines.push(dim(`     ${this.expanded ? 'Ctrl+O collapse' : 'Ctrl+O expand'} · click an agent to open its live session · Ctrl+B background`))
    return lines
  }
}

export class ChildRunComponent {
  constructor(
    private child: ProjectedChildRun,
    private expanded: boolean
  ) {}

  update(child: ProjectedChildRun, expanded: boolean): void {
    this.child = child
    this.expanded = expanded
  }

  get value(): ProjectedChildRun { return this.child }

  render(width: number, animationFrame = 0): string[] {
    const child = this.child
    const active = child.status === 'queued' || child.status === 'running'
    const failed = child.status === 'failed' || child.status === 'aborted'
    const icon = active
      ? cyan(activityFrame('subagent', animationFrame))
      : failed
        ? red('✗')
        : green('●')
    const label = child.label || child.profile || 'Subagent'
    const role = child.profile && child.profile !== label ? ` · ${child.profile}` : ''
    const metrics = childMetrics(child)
    const previewLimit = this.expanded ? 8 : failed ? 5 : 2
    const liveActivity = active && child.activity
      ? truncateToWidth(
          `     ${cyan(activityFrame(childActivityVisualKind(child), animationFrame))} ${sanitizeTerminalText(child.activity.label)}${elapsedDuration(child.activity.startedAt, undefined, true) ? ` ${dim(`· ${elapsedDuration(child.activity.startedAt, undefined, true)}`)}` : ''}`,
          Math.max(8, width)
        )
      : undefined
    return [
      `   ${icon} ${bold('Subagent')} · ${sanitizeTerminalText(label)}${dim(role)}${metrics ? ` ${dim(`· ${metrics}`)}` : ''} ${childStatusColor(child, childStatusLabel(child))}`,
      ...(liveActivity
        ? [liveActivity]
        : child.text
        ? plainLines(child.text, Math.max(8, width - 5), 5).slice(0, previewLimit).map((line) => `${failed ? red('     ') : dim('     ')}${failed ? red(line) : dim(line)}`)
        : active ? [dim(`     ${child.status === 'queued' ? 'Waiting for an execution slot…' : 'Working independently…'}`)] : []),
      ...(this.expanded && child.prompt
        ? [dim(`     Task: ${truncateToWidth(sanitizeTerminalText(child.prompt), Math.max(8, width - 11))}`)]
        : []),
      dim(`     ${this.expanded ? 'Ctrl+O collapse' : 'Ctrl+O expand'} · click to open · keyboard: /subagents${isForegroundChildRun(child) ? ' · Ctrl+B background' : ''}`)
    ]
  }
}

export function sortChildRuns(children: readonly ProjectedChildRun[]): ProjectedChildRun[] {
  return [...children].sort((left, right) =>
    (left.childSeq ?? Number.MAX_SAFE_INTEGER) - (right.childSeq ?? Number.MAX_SAFE_INTEGER) ||
    left.startedAt.localeCompare(right.startedAt) ||
    left.childId.localeCompare(right.childId)
  )
}

export function childStatusCounts(children: readonly ProjectedChildRun[]): {
  completed: number
  failed: number
  running: number
  waiting: number
  background: number
} {
  let completed = 0
  let failed = 0
  let running = 0
  let waiting = 0
  let background = 0
  for (const child of children) {
    if (child.detached && isActiveChildRun(child)) {
      background += 1
      continue
    }
    if (child.status === 'completed') completed += 1
    else if (child.status === 'failed' || child.status === 'aborted') failed += 1
    else if (child.status === 'queued') waiting += 1
    else if (child.status === 'running') running += 1
  }
  return { completed, failed, running, waiting, background }
}

export function childStatusLabel(child: ProjectedChildRun): string {
  if (child.detached && isActiveChildRun(child)) return '◐ Background'
  switch (child.status) {
    case 'queued': return 'Waiting'
    case 'running': return 'Running'
    case 'completed': return '✓ Completed'
    case 'failed': return '✗ Failed'
    case 'aborted': return '✗ Stopped'
  }
}

export function childStatusColor(child: ProjectedChildRun, label: string): string {
  if (child.status === 'failed' || child.status === 'aborted') return red(label)
  if (child.status === 'completed') return green(label)
  return cyan(label)
}

export function childMetrics(child: ProjectedChildRun): string {
  const active = isActiveChildRun(child)
  return [
    child.detached ? 'background' : undefined,
    child.toolInvocations !== undefined ? `${child.toolInvocations} tools` : undefined,
    child.totalTokens ? `${formatTokenCount(child.totalTokens)} tok` : undefined,
    child.cacheHitRate !== undefined && child.cacheHitRate !== null
      ? `${Math.round(child.cacheHitRate * 100)}% cache`
      : undefined,
    child.durationMs !== undefined
      ? formatDurationMs(child.durationMs)
      : elapsedDuration(child.startedAt, undefined, active)
  ].filter(Boolean).join(' · ')
}

export function elapsedMilliseconds(startedAt: string, updatedAt: string, active: boolean): number {
  const started = Date.parse(startedAt)
  const ended = active ? Date.now() : Date.parse(updatedAt)
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return 0
  return Math.max(0, ended - started)
}

export function isActiveChildRun(child: ProjectedChildRun): boolean {
  return child.status === 'queued' || child.status === 'running'
}

export function isForegroundChildRun(child: ProjectedChildRun): boolean {
  return !child.detached && isActiveChildRun(child)
}

export function childActivityVisualKind(child: ProjectedChildRun): ActivityVisualKind {
  switch (child.activity?.phase) {
    case 'thinking': return 'thinking'
    case 'responding': return 'responding'
    case 'tool': return 'tool'
    case 'retrying': return 'retrying'
    case 'waiting':
    case 'compacting':
    case 'starting':
    default:
      return 'waiting'
  }
}

/**
 * Exclusive subagent browser and controllable child transcript. ChildRunExecutor
 * persists side threads with id === childId, so the route opens that
 * authoritative id and never guesses from a display label.
 */
