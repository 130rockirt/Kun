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
import { childIdFromToolResult, elapsedDuration, humanizeToolName, oneLine, outputText, plainLines, summarize, toolAction } from './render-utils.js'

export const KUN_REPLY_GROUP_PREFIX = 'kun-reply:'
export const EXPLORE_GROUP_PREFIX = 'explore-group:'
export const EXPLORE_GROUP_COMPACT_LIMIT = 12

export type ToolCallItem = Extract<TurnItem, { kind: 'tool_call' }>
export type ToolResultItem = Extract<TurnItem, { kind: 'tool_result' }>
export type ReasoningItem = Extract<TurnItem, { kind: 'assistant_reasoning' }>

export type ExplorationEntry = {
  call: ToolCallItem
  result?: ToolResultItem
}

export type ExplorationTimelineEntry =
  | { kind: 'reasoning'; item: ReasoningItem }
  | { kind: 'action'; entry: ExplorationEntry }

export type ExplorationStage = {
  id: string
  turnId: string
  entries: ExplorationEntry[]
  timeline: ExplorationTimelineEntry[]
  insertAfterItemId: string
  active: boolean
}

export function isKunReplyItem(item: TurnItem): boolean {
  return item.kind === 'assistant_text' ||
    item.kind === 'assistant_reasoning' ||
    item.kind === 'tool_call' ||
    item.kind === 'tool_result' ||
    item.kind === 'approval' ||
    item.kind === 'user_input' ||
    item.kind === 'review' ||
    item.kind === 'error'
}
export function deriveExplorationStages(
  items: readonly TurnItem[],
  toolResults: ReadonlyMap<string, ToolResultItem>,
  runningTurnId: string | undefined
): ExplorationStage[] {
  const stages: ExplorationStage[] = []
  const stageIndexes = new Map<string, number>()
  let turnId = ''
  let entries: ExplorationEntry[] = []
  let timeline: ExplorationTimelineEntry[] = []
  let leadingReasoning: ReasoningItem[] = []

  const flush = (closed: boolean): void => {
    const lastTimelineEntry = timeline.at(-1)
    const insertAfterItemId = lastTimelineEntry?.kind === 'reasoning'
      ? lastTimelineEntry.item.id
      : lastTimelineEntry?.entry.call.id
    if (entries.length >= 2 && turnId && insertAfterItemId) {
      const index = stageIndexes.get(turnId) ?? 0
      stageIndexes.set(turnId, index + 1)
      stages.push({
        id: `${EXPLORE_GROUP_PREFIX}${turnId}:${index}`,
        turnId,
        entries,
        timeline,
        insertAfterItemId,
        active: !closed && runningTurnId === turnId
      })
    }
    entries = []
    timeline = []
    leadingReasoning = []
  }

  for (const item of items) {
    if (turnId && item.turnId !== turnId) flush(true)
    turnId = item.turnId

    if (item.kind === 'tool_call' && explorationToolAction(item)) {
      if (entries.length === 0 && leadingReasoning.length > 0) {
        timeline.push(...leadingReasoning.map((reasoning) => ({
          kind: 'reasoning' as const,
          item: reasoning
        })))
        leadingReasoning = []
      }
      const entry = { call: item, result: toolResults.get(item.callId) }
      entries.push(entry)
      timeline.push({ kind: 'action', entry })
      continue
    }
    if (item.kind === 'assistant_reasoning') {
      if (entries.length > 0) timeline.push({ kind: 'reasoning', item })
      else leadingReasoning.push(item)
      continue
    }
    flush(true)
  }
  flush(false)
  return stages
}

export function explorationToolAction(item: ToolCallItem): { verb: string; subject: string } | undefined {
  if (item.toolKind !== 'tool_call') return undefined
  const name = item.toolName.toLowerCase()
  if (
    name.includes('browser_use') ||
    name.includes('computer_use') ||
    name.includes('delegate') ||
    name.includes('write') ||
    name.includes('edit') ||
    name.includes('patch')
  ) {
    return undefined
  }

  const tokens = name.split(/[^a-z0-9]+/u).filter(Boolean)
  const action = toolAction(item)
  if (
    name === 'rg' ||
    tokens.some((token) => token === 'search' || token === 'grep' || token === 'find' || token === 'glob')
  ) {
    return { ...action, verb: 'Search' }
  }
  if (tokens.includes('list')) return { ...action, verb: 'List' }
  if (
    name === 'open_url' ||
    tokens.some((token) => token === 'fetch' || token === 'download')
  ) {
    return { ...action, verb: 'Fetch' }
  }
  if (
    name === 'repo_map' ||
    tokens.some((token) => token === 'read' || token === 'view' || token === 'inspect')
  ) {
    return { ...action, verb: 'Read' }
  }
  return undefined
}

export function explorationEntryFailed(entry: ExplorationEntry): boolean {
  return Boolean(
    entry.result?.isError ||
    entry.call.status === 'failed' ||
    entry.call.status === 'aborted'
  )
}

export function explorationStageDuration(stage: ExplorationStage): string {
  const first = stage.timeline[0]
  const start = first?.kind === 'reasoning' ? first.item.createdAt : first?.entry.call.createdAt
  const last = stage.timeline.at(-1)
  const end = stage.active
    ? undefined
    : last?.kind === 'reasoning'
      ? last.item.finishedAt ?? last.item.createdAt
      : last?.entry.result?.finishedAt ??
        last?.entry.call.finishedAt ??
        last?.entry.result?.createdAt ??
        last?.entry.call.createdAt
  return elapsedDuration(start, end, stage.active)
}

export function renderExplorationDetail(
  label: string,
  value: string,
  width: number,
  maxLines: number,
  continuation: string,
  tone: (value: string) => string
): string[] {
  const safeLabel = sanitizeTerminalText(label).slice(0, 12)
  const prefix = `   ${continuation}  `
  const available = Math.max(1, width - visibleWidth(prefix) - safeLabel.length - 3)
  const values = plainLines(value, available, 0).slice(0, maxLines)
  return values.map((line, index) => {
    const marker = index === values.length - 1 ? '└' : '├'
    const renderedLabel = index === 0 ? `${safeLabel} · ` : ' '.repeat(safeLabel.length + 3)
    return truncateToWidth(`${prefix}${tone(`${marker} ${renderedLabel}${line}`)}`, width)
  })
}
