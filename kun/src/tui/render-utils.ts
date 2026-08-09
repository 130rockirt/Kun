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
import type { ExplorationEntry, ExplorationStage, ToolCallItem, ToolResultItem } from './transcript-exploration.js'

export function popupFrame(title: string, body: string[], width: number): string[] {
  const safeWidth = Math.max(12, width)
  const inner = safeWidth - 4
  const topTitle = ` ${sanitizeTerminalText(title)} `
  const top = `┌${topTitle}${'─'.repeat(Math.max(0, safeWidth - visibleWidth(topTitle) - 2))}┐`
  const lines = body.flatMap((entry) => String(entry).split('\n')).map((entry) => {
    const clipped = truncateToWidth(entry, inner)
    return `│ ${clipped}${' '.repeat(Math.max(0, inner - visibleWidth(clipped)))} │`
  })
  return [top, ...lines, `└${'─'.repeat(safeWidth - 2)}┘`]
}

export function plainLines(value: string, width: number, padding: number): string[] {
  const safe = sanitizeTerminalText(value || '')
  return safe.split('\n').map((line) => `${' '.repeat(padding)}${truncateToWidth(line, Math.max(1, width - padding))}`)
}

export function summarize(value: unknown): string {
  try {
    return truncateToWidth(JSON.stringify(redactSecrets(value)), 100)
  } catch {
    return String(value)
  }
}

export function outputText(value: unknown): string {
  if (typeof value === 'string') return sanitizeTerminalText(value)
  try { return sanitizeTerminalText(JSON.stringify(redactSecrets(value))) } catch { return sanitizeTerminalText(String(value)) }
}

export function elapsedDuration(
  start: string | undefined,
  end: string | undefined,
  live: boolean,
  nowMs = Date.now()
): string {
  if (!start) return live ? '0.0s' : ''
  if (!end && !live) return ''
  const startMs = Date.parse(start)
  const endMs = end ? Date.parse(end) : nowMs
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return ''
  return formatDurationMs(Math.max(0, endMs - startMs))
}

export function elapsedStartGapMs(earlier: string | undefined, later: string | undefined): number {
  if (!earlier || !later) return 0
  const earlierMs = Date.parse(earlier)
  const laterMs = Date.parse(later)
  if (!Number.isFinite(earlierMs) || !Number.isFinite(laterMs)) return 0
  return Math.max(0, laterMs - earlierMs)
}

export function formatDurationMs(durationMs: number): string {
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`
  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.floor((durationMs % 60_000) / 1_000)
  return `${minutes}m ${seconds}s`
}

export function formatGoalDuration(seconds: number): string {
  return formatDurationMs(Math.max(0, seconds) * 1_000)
}

export function itemDuration(item: TurnItem, live: boolean, inferredEnd?: string): string {
  return elapsedDuration(item.createdAt, item.finishedAt ?? inferredEnd, live)
}

export function resolveReasoningEndAt(
  item: Extract<TurnItem, { kind: 'assistant_reasoning' }>,
  items: readonly TurnItem[],
  projection: ThreadProjection | undefined
): string | undefined {
  if (item.finishedAt) return item.finishedAt

  const itemIndex = items.findIndex((candidate) => candidate.id === item.id)
  if (itemIndex >= 0) {
    const next = items.slice(itemIndex + 1).find((candidate) =>
      candidate.turnId === item.turnId && candidate.id !== item.id
    )
    if (next?.createdAt) return next.createdAt
  }

  const activity = projection?.activity
  if (activity?.turnId === item.turnId && activity.phase !== 'thinking') {
    return activity.startedAt
  }

  const turn = projection?.thread.turns.find((candidate) => candidate.id === item.turnId)
  if (turn?.finishedAt) return turn.finishedAt

  if (activity?.turnId === item.turnId) return activity.updatedAt
  return undefined
}

export function childIdFromToolResult(
  result: Extract<TurnItem, { kind: 'tool_result' }> | undefined
): string | undefined {
  if (!result || !result.output || typeof result.output !== 'object') return undefined
  const value = result.output as Record<string, unknown>
  return typeof value.childId === 'string' ? value.childId : undefined
}

export function humanizeToolName(name: string): string {
  const normalized = sanitizeTerminalText(name).replaceAll('_', ' ').trim()
  return normalized ? `${normalized[0]!.toUpperCase()}${normalized.slice(1)}` : 'Tool'
}
export function toolAction(item: Extract<TurnItem, { kind: 'tool_call' }>): { verb: string; subject: string } {
  const args = item.arguments
  const value = (...keys: string[]): string => {
    for (const key of keys) {
      const candidate = args[key]
      if (typeof candidate === 'string' && candidate.trim()) return oneLine(candidate)
    }
    return ''
  }
  const name = item.toolName.toLowerCase()
  if (['bash', 'exec', 'exec_command', 'shell'].some((entry) => name.includes(entry))) {
    return { verb: 'Run', subject: value('command', 'cmd') || item.summary || '' }
  }
  if (name.includes('read') || name.includes('view')) {
    return { verb: 'Read', subject: value('path', 'file_path', 'url') || item.summary || '' }
  }
  if (name.includes('write') || name.includes('edit') || name.includes('patch')) {
    return { verb: 'Edit', subject: value('path', 'file_path') || item.summary || '' }
  }
  if (name.includes('search') || name.includes('grep') || name === 'rg' || name.includes('find')) {
    return { verb: 'Search', subject: value('query', 'pattern', 'path') || item.summary || '' }
  }
  if (name.includes('web') || name.includes('fetch') || name.includes('open_url')) {
    return { verb: 'Fetch', subject: value('url', 'query') || item.summary || '' }
  }
  if (name === 'delegate_task') {
    return { verb: 'Delegate', subject: value('label', 'prompt') || item.summary || '' }
  }
  return { verb: humanizeToolName(item.toolName), subject: item.summary ?? summarize(args) }
}

export function sourcePageSuffix(output: unknown): string {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return ''
  const record = output as Record<string, unknown>
  const start = record.start_line
  const end = record.end_line
  const total = record.total_lines
  if (typeof start === 'number' && typeof end === 'number' && typeof total === 'number') {
    return ` (lines ${start}-${end}/${total}${record.has_more === true ? ', more' : ''})`
  }
  const matches = Array.isArray(record.matches) ? record.matches.length : undefined
  if (matches !== undefined) return ` (${matches} result${matches === 1 ? '' : 's'}${record.has_more === true ? ', more' : ''})`
  return ''
}

export function toolResultSummary(value: unknown): string {
  return conciseToolResultSummary(value) ?? outputText(value)
}

export function toolTreeSection(
  label: string,
  value: string,
  width: number,
  maxLines: number,
  terminal: boolean,
  tone: (value: string) => string
): string[] {
  const safeLabel = sanitizeTerminalText(label).slice(0, 12)
  const prefixWidth = safeLabel ? safeLabel.length + 7 : 6
  const lines = plainLines(value, Math.max(1, width - prefixWidth), 0).slice(0, maxLines)
  return lines.map((line, index) => {
    const marker = index === 0 ? (terminal ? '└' : '├') : '│'
    const labelPrefix = index === 0 && safeLabel ? `${safeLabel}  ` : ' '.repeat(safeLabel ? safeLabel.length + 2 : 0)
    return truncateToWidth(tone(`   ${marker} ${labelPrefix}${line}`), width)
  })
}

export function conciseToolResultSummary(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['summary', 'message', 'error', 'output', 'text']) {
      const candidate = record[key]
      if (typeof candidate === 'string' && candidate.trim()) return candidate
    }
  }
  return undefined
}

export function isModelConnectionError(item: Extract<TurnItem, { kind: 'error' }>): boolean {
  return item.code === 'http_401' || item.code === 'unauthorized' ||
    /\b401\b|invalid or expired credentials|no auth context|authentication|unauthori[sz]ed/iu.test(item.message)
}

export function friendlyRuntimeError(message: string): string {
  if (/\b401\b|invalid or expired credentials|no auth context|unauthori[sz]ed/iu.test(message)) {
    return 'The selected provider rejected its saved credentials (HTTP 401).'
  }
  if (/\b403\b|permission denied|forbidden/iu.test(message)) {
    return 'The selected provider refused this request (HTTP 403). Check the account permissions and model access.'
  }
  if (/\b429\b|rate.?limit/iu.test(message)) {
    return 'The selected provider is rate limited. Wait briefly or choose another model.'
  }
  return sanitizeTerminalText(message).slice(0, 800)
}

export function oneLine(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/gu, ' ').trim().slice(0, 160) || '(empty)'
}

/** Decode plain and Kitty printable input without treating escape sequences as text. */
export function printableInput(data: string): string | undefined {
  const kitty = decodeKittyPrintable(data)
  if (kitty) return kitty
  if (!data.includes('\x1b') && Array.from(data).every((value) => value.codePointAt(0)! >= 0x20)) return data
  return undefined
}
