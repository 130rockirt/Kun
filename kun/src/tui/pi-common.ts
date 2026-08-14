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

export const bold = visual.strong
export const dim = visual.muted
export const blue = visual.brand
export const cyan = visual.focus
export const green = visual.success
export const yellow = visual.warning
export const red = visual.danger
export const magenta = visual.warning
export const italic = visual.italic

/**
 * Ctrl+C follows the same contextual cancel path as Escape while a leader,
 * overlay, or exclusive route owns input. At the normal composer, the global
 * keymap still keeps its existing clear/exit behavior.
 */
export const isCancelInput = (data: string): boolean =>
  matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')

export const EXIT_CONFIRM_WINDOW_MS = 1_500
export const UNDO_ESCAPE_WINDOW_MS = 600
export const TOTAL_ELAPSED_MIN_START_GAP_MS = 100
export const BRACKETED_PASTE_START = '\x1b[200~'
export const BRACKETED_PASTE_END = '\x1b[201~'

export const ENABLE_MOUSE_TRACKING = '\x1b[?1000h\x1b[?1006h'
export const DISABLE_MOUSE_TRACKING = '\x1b[?1000l\x1b[?1006l'

export type SgrMouseEvent = {
  button: number
  x: number
  y: number
  pressed: boolean
}

/** Decode one complete SGR mouse report emitted by terminals in mode 1006. */
export function parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
  if (!data.startsWith('\x1b[<')) return undefined
  const match = /^(\d+);(\d+);(\d+)([Mm])$/u.exec(data.slice(3))
  if (!match) return undefined
  const button = Number(match[1])
  const x = Number(match[2])
  const y = Number(match[3])
  if (!Number.isSafeInteger(button) || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 1 || y < 1) {
    return undefined
  }
  return { button, x, y, pressed: match[4] === 'M' }
}

export const DIRECT_SEMANTIC_ACTIONS: readonly TuiKeyAction[] = [
  'session_new', 'session_list', 'session_timeline', 'session_compact', 'session_export',
  'session_status', 'session_undo', 'session_redo', 'session_child_first', 'session_parent',
  'session_sibling_next', 'session_sibling_previous', 'messages_copy', 'model_list',
  'agent_list', 'thinking_toggle', 'pointer_mode_toggle', 'tool_details_toggle', 'input_editor', 'input_steer',
  'input_paste',
  'sidebar_toggle', 'theme_list', 'session_share', 'session_unshare', 'share',
  'plugin_list', 'console_toggle', 'diff_toggle', 'terminal_toggle',
  'session_quick_1', 'session_quick_2', 'session_quick_3',
  'session_quick_4', 'session_quick_5', 'session_quick_6', 'session_quick_7',
  'session_quick_8', 'session_quick_9'
]

// Runtime/model/tool strings are untrusted terminal input. Apply both secret
// redaction and control-sequence stripping at the display boundary so every
// component, overlay, notification, and clipboard path gets the same policy.
export const sanitizeTerminalText = (value: string): string =>
  stripTerminalControls(redactSecretText(value))

export const selectTheme: SelectListTheme = {
  selectedPrefix: cyan,
  selectedText: bold,
  description: dim,
  scrollInfo: dim,
  noMatch: dim
}

export const editorTheme: EditorTheme = {
  borderColor: cyan,
  selectList: selectTheme
}

export const markdownTheme: MarkdownTheme = {
  heading: bold,
  link: cyan,
  linkUrl: dim,
  code: yellow,
  codeBlock: (value) => value,
  codeBlockBorder: (value) => {
    const language = codeFenceLanguage(value.slice(3))
    return language
      ? dim(`╭─ ${language === 'text' || language === 'plaintext' ? 'code' : language}`)
      : dim('╰─')
  },
  codeBlockIndent: dim('│ '),
  highlightCode: highlightTerminalCode,
  quote: dim,
  quoteBorder: magenta,
  hr: dim,
  listBullet: cyan,
  bold,
  italic,
  strikethrough: visual.strikethrough,
  underline: visual.underline
}

export { TUI_SLASH_COMMANDS } from './commands.js'

export type ExclusiveRouteHandle = {
  hide: () => void
}

export function localSharePath(dataDir: string, threadId: string): string {
  return join(dataDir, 'tui', 'shares', `${threadId}.md`)
}

export async function writeLocalShareSnapshot(
  dataDir: string,
  threadId: string,
  markdown: string
): Promise<string> {
  const path = localSharePath(dataDir, threadId)
  await withRuntimeDataDirAncillaryWriter(dataDir, async () => {
    await mkdir(join(dataDir, 'tui', 'shares'), { recursive: true, mode: 0o700 })
    await writeFile(path, markdown, { encoding: 'utf8', mode: 0o600 })
  })
  return path
}

export async function removeLocalShareSnapshot(
  dataDir: string,
  threadId: string
): Promise<void> {
  await withRuntimeDataDirAncillaryWriter(dataDir, async () => {
    await unlink(localSharePath(dataDir, threadId))
  })
}
