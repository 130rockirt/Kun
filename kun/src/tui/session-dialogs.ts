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
import { plainLines, popupFrame } from './render-utils.js'
import { safeError } from './render-layout.js'

export class ThreadPickerDialog implements Component, Focusable {
  private state: TuiControllerState
  private readonly input = new Input()
  private _focused = false
  private deleteConfirmId?: string

  constructor(
    private readonly controller: TuiController,
    private readonly tui: TUI,
    private readonly keymap: TuiKeymap
  ) {
    this.state = controller.state
    this.input.setValue(this.state.threadSearch)
  }

  get focused(): boolean { return this._focused }
  set focused(value: boolean) { this._focused = value; this.input.focused = value }

  update(state: TuiControllerState): void { this.state = state; this.tui.requestRender() }

  render(width: number): string[] {
    const inner = Math.max(10, width - 2)
    const density = visualDensity(width)
    const start = Math.max(0, Math.min(this.state.selectedThreadIndex - 6, Math.max(0, this.state.threads.length - 12)))
    const list = this.state.threads.slice(start, start + 12).map((thread, visibleIndex) => {
      const index = start + visibleIndex
      const selected = index === this.state.selectedThreadIndex
      const current = thread.id === this.state.projection?.thread.id
      const marker = `${thread.pinned ? '◆' : '◇'}${current ? '*' : ' '}`
      const left = `${marker} ${sanitizeTerminalText(thread.title || 'Untitled')}`
      const updated = thread.updatedAt.slice(5, 16).replace('T', ' ')
      const right = density === 'wide'
        ? `${thread.status} · ${sanitizeTerminalText(thread.model)} · ${basename(thread.workspace)} · ${updated}`
        : density === 'compact'
          ? `${thread.status} · ${sanitizeTerminalText(thread.model)} · ${updated}`
          : `${thread.status} · ${updated}`
      return selectionRow(left, right, inner, selected, 0)
    })
    if (list.length === 0) list.push(dim('No sessions found. Ctrl+X N creates one.'))
    const selected = this.state.threads[this.state.selectedThreadIndex]
    const confirm = this.deleteConfirmId && selected?.id === this.deleteConfirmId
      ? red(` Delete “${sanitizeTerminalText(selected.title || selected.id)}” permanently?`)
      : ''
    return pageFrame({
      path: ['KUN', 'Sessions'],
      right: `${this.state.threads.length} ${this.state.threadListMode === 'archived' ? 'archived' : 'saved'}`,
      body: [
        ` ${dim('Search')}  ${this.input.render(Math.max(8, inner - 10)).join(' ')}`,
        '',
        ...list,
        ...(confirm ? ['', confirm] : [])
      ],
      footer: this.deleteConfirmId
        ? [
            { key: 'Enter', label: 'delete permanently', tone: 'danger' },
            { key: 'Esc', label: 'cancel' }
          ]
        : [
            { key: 'Enter', label: 'open' },
            { key: this.keymap.display('session_pin'), label: 'pin' },
            ...(this.state.threadListMode === 'archived'
              ? [{ key: 'u', label: 'restore' }]
              : [{ key: 'a', label: 'archives' }]),
            { key: this.keymap.display('session_delete'), label: 'delete' },
            { key: 'Esc', label: 'back' }
          ],
      width
    })
  }

  handleInput(data: string): void {
    if (this.deleteConfirmId) {
      if (isCancelInput(data)) { this.deleteConfirmId = undefined; return }
      if (matchesKey(data, 'enter')) {
        this.deleteConfirmId = undefined
        void this.controller.deleteSelectedThread()
      }
      return
    }
    if (isCancelInput(data)) {
      this.controller.showChat()
      return
    }
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) { this.controller.selectThread(-1); return }
    if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) { this.controller.selectThread(1); return }
    if (matchesKey(data, 'pageUp')) { this.controller.selectThread(-10); return }
    if (matchesKey(data, 'pageDown')) { this.controller.selectThread(10); return }
    if (matchesKey(data, 'home')) { this.controller.selectThread(-Number.MAX_SAFE_INTEGER); return }
    if (matchesKey(data, 'end')) { this.controller.selectThread(Number.MAX_SAFE_INTEGER); return }
    if (data.toLowerCase() === 'a' && this.state.threadListMode === 'active') {
      this.controller.showThreads('', 'archived')
      return
    }
    if (data.toLowerCase() === 'u' && this.state.threadListMode === 'archived') {
      void this.controller.restoreSelectedThread()
      return
    }
    if (this.keymap.matches('session_pin', data)) { void this.controller.toggleSelectedThreadPin(); return }
    if (this.keymap.matches('session_delete', data)) {
      this.deleteConfirmId = this.state.threads[this.state.selectedThreadIndex]?.id
      return
    }
    if (matchesKey(data, 'enter')) { void this.controller.openSelectedThread(); return }
    this.input.handleInput(data)
    void this.controller.refreshThreads(this.input.getValue())
  }

  invalidate(): void { this.input.invalidate() }
}

export class HelpDialog implements Component, Focusable {
  private _focused = false
  constructor(private readonly controller: TuiController, private readonly keymap: TuiKeymap) {}
  get focused(): boolean { return this._focused }
  set focused(value: boolean) { this._focused = value }
  render(width: number): string[] {
    return pageFrame({
      path: ['KUN', 'Help'],
      description: `Press ${this.keymap.display('command_list')} to search every command.`,
      body: [
        sectionLabel('Conversation', width - 2),
        ` ${cyan(bold('Enter'))} ${dim('send or steer')}  ·  ${cyan(bold('Ctrl+J'))} ${dim('newline')}  ·  ${cyan(bold('Esc'))} ${dim('stop turn')}`,
        ` ${cyan(bold(this.keymap.display('variant_cycle')))} ${dim('reasoning effort')}  ·  ${cyan(bold(this.keymap.display('session_list')))} ${dim('sessions')}`,
        '',
        sectionLabel('Start and switch', width - 2),
        ` ${cyan(bold('/connect'))} ${dim('providers')}  ·  ${cyan(bold('/model'))} ${dim('model')}  ·  ${cyan(bold('/sessions'))} ${dim('previous work')}`,
        ` ${cyan(bold(this.keymap.display('agent_list')))} ${dim('Agent / Plan / Graph / Goal mode')}  ·  ${cyan(bold('/graph'))} ${dim('Graph then type requirement')}`,
        '',
        sectionLabel('Terminal', width - 2),
        ` ${dim('Mouse wheel/trackpad scrolls terminal history; drag selects text to copy.')}`,
        ` ${cyan(bold(this.keymap.display('pointer_mode_toggle')))} ${dim('enable direct Thinking/Subagent clicks; toggle again to restore native selection')}`,
        ` ${dim('Shift+PgUp/PgDn also uses native scrollback. Ctrl+C acts as back in routes.')}`
      ],
      footer: [
        { key: this.keymap.display('command_list'), label: 'all commands' },
        { key: 'Esc', label: 'back' }
      ],
      width
    })
  }
  handleInput(data: string): void {
    if (isCancelInput(data) || data === '?') this.controller.showChat()
  }
  invalidate(): void {}
}

export class InspectionDialog implements Component, Focusable {
  private offset = 0
  private _focused = false

  constructor(
    private readonly controller: TuiController,
    private readonly title: string,
    private readonly lines: string[],
    private readonly terminalRows: () => number
  ) {}
  get focused(): boolean { return this._focused }
  set focused(value: boolean) { this._focused = value }
  render(width: number): string[] {
    const pageSize = Math.max(1, Math.floor(this.terminalRows() * 0.8) - 4)
    const maxOffset = Math.max(0, this.lines.length - pageSize)
    this.offset = Math.min(this.offset, maxOffset)
    const visible = this.lines.slice(this.offset, this.offset + pageSize)
    return pageFrame({
      path: ['KUN', this.title],
      right: this.lines.length > pageSize
        ? `${this.offset + 1}-${Math.min(this.lines.length, this.offset + pageSize)}/${this.lines.length}`
        : `${this.lines.length} lines`,
      description: inspectionDescription(this.title),
      body: visible.flatMap((line) => renderInspectionLine(this.title, line, Math.max(10, width - 2))),
      footer: [
        ...(this.lines.length > pageSize ? [{ key: '↑/↓', label: 'scroll' }] : []),
        { key: 'Esc', label: 'back' }
      ],
      width
    })
  }
  handleInput(data: string): void {
    const pageSize = Math.max(1, Math.floor(this.terminalRows() * 0.8) - 4)
    const maxOffset = Math.max(0, this.lines.length - pageSize)
    if (isCancelInput(data) || matchesKey(data, 'enter')) this.controller.dismissInspection()
    else if (matchesKey(data, 'up')) this.offset = Math.max(0, this.offset - 1)
    else if (matchesKey(data, 'down')) this.offset = Math.min(maxOffset, this.offset + 1)
    else if (matchesKey(data, 'pageUp')) this.offset = Math.max(0, this.offset - pageSize)
    else if (matchesKey(data, 'pageDown')) this.offset = Math.min(maxOffset, this.offset + pageSize)
  }
  invalidate(): void {}
}

export function inspectionDescription(title: string): string {
  switch (title) {
    case 'Status': return 'Current session, model, permissions, and shared runtime connection.'
    case 'MCP servers': return 'Configured tool servers and their live availability.'
    case 'Tasks': return 'Subagents, background commands, plan work, goals, and extension jobs.'
    case 'Plan': return 'Persisted plan items for the current session.'
    case 'Goal': return 'Persistent objective and its current budget state.'
    case 'Context': return 'Token usage reported for the current session.'
    case 'Queued guidance': return 'Messages waiting to steer the active turn.'
    default: return 'Read-only details from the shared runtime.'
  }
}

export function renderInspectionLine(title: string, value: string, width: number): string[] {
  const safe = sanitizeTerminalText(value)
  const nested = /^\s{2,}/u.test(value)
  if (nested) {
    const text = safe.trim()
    const failed = /\b(error|failed|disconnected)\b/iu.test(text)
    return [`   ${failed ? red(text) : dim(text)}`]
  }
  const taskStatus = safe.match(/^(\d+\.\s+)?\[([^\]]+)\]\s+(.+)$/u)
  if (taskStatus) {
    const state = taskStatus[2]!.toLowerCase()
    const glyph = statusGlyph(
      state.includes('progress') || state.includes('running')
        ? 'running'
        : state.includes('complete') || state.includes('done')
          ? 'success'
          : state.includes('fail')
            ? 'failed'
            : 'queued'
    )
    return [` ${glyph} ${taskStatus[1] ?? ''}${taskStatus[3]}  ${dim(taskStatus[2]!)}`]
  }
  const field = safe.match(/^([^:]{1,24}):\s*(.*)$/u)
  if (field) {
    const label = field[1]!
    const content = field[2]!
    const stateful = title === 'Status' && label === 'Connection'
    const glyph = stateful
      ? `${statusGlyph(content === 'connected' ? 'success' : content === 'reconnecting' ? 'warning' : 'failed')} `
      : ''
    return [
      truncateToWidth(
        ` ${glyph}${dim(label.padEnd(Math.min(18, Math.max(8, label.length))))}  ${content}`,
        width
      )
    ]
  }
  const numbered = safe.match(/^(\d+)\.\s+(.+)$/u)
  if (numbered) return [` ${cyan(numbered[1]!)}  ${numbered[2]}`]
  return plainLines(safe, width, 1)
}

export const PERMISSION_PRESET_COPY: Record<
  KunToolPermissionMode,
  { label: string; description: string }
> = {
  'ask-for-approval': {
    label: 'Ask for approval',
    description: 'Workspace-safe actions run automatically; approval-worthy actions ask you first'
  },
  'approve-for-me': {
    label: 'Approve for me',
    description: 'The selected model reviews approval-worthy actions and denies them if review fails'
  },
  'full-access': {
    label: 'Full access',
    description: 'No Kun approval; tools may access any file, run commands, and use the network'
  }
}

export class PermissionDialog implements Component, Focusable {
  private _focused = true
  private presetIndex: number
  private readonly startsInFullAccess: boolean
  private confirmingFullAccess = false
  private saving = false
  private error = ''

  constructor(
    private readonly controller: TuiController,
    approvalPolicy: ApprovalPolicy,
    sandboxMode: SandboxMode,
    approvalReviewer: ApprovalReviewer,
    private readonly close: () => void
  ) {
    const mode = kunToolPermissionModeFromSettings({
      approvalPolicy,
      sandboxMode,
      approvalReviewer
    })
    this.presetIndex = Math.max(0, KUN_TOOL_PERMISSION_MODES.indexOf(mode))
    this.startsInFullAccess = mode === 'full-access'
  }

  get focused(): boolean { return this._focused }
  set focused(value: boolean) { this._focused = value }

  render(width: number): string[] {
    if (this.confirmingFullAccess) return this.renderFullAccessConfirmation(width)
    return pageFrame({
      path: ['KUN', 'Permissions'],
      description: 'Choose who reviews actions that cross the workspace boundary.',
      body: [
        sectionLabel('Tool permission mode', width - 2),
        ...KUN_TOOL_PERMISSION_MODES.map((mode, index) => {
          const copy = PERMISSION_PRESET_COPY[mode]
          return selectionRow(copy.label, copy.description, width - 2, index === this.presetIndex)
        }),
        ...(this.error ? ['', red(this.error)] : [])
      ],
      footer: this.saving
        ? [{ key: statusGlyph('running'), label: 'saving' }]
        : [
            { key: '↑/↓', label: 'mode' },
            { key: 'Enter', label: 'save' },
            { key: 'Esc', label: 'cancel' }
          ],
      width
    })
  }

  handleInput(data: string): void {
    if (this.saving) return
    if (this.confirmingFullAccess) {
      if (isCancelInput(data)) {
        this.confirmingFullAccess = false
        return
      }
      if (matchesKey(data, 'enter') || data.toLowerCase() === 'y') {
        const settings = kunToolPermissionModeSettings('full-access')
        void this.save(
          settings.approvalPolicy,
          settings.sandboxMode,
          settings.approvalReviewer
        )
      }
      return
    }
    if (isCancelInput(data)) { this.close(); return }
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) {
      this.presetIndex = Math.max(0, this.presetIndex - 1)
    } else if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) {
      this.presetIndex = Math.min(KUN_TOOL_PERMISSION_MODES.length - 1, this.presetIndex + 1)
    } else if (matchesKey(data, 'home') || matchesKey(data, 'pageUp')) {
      this.presetIndex = 0
    } else if (matchesKey(data, 'end') || matchesKey(data, 'pageDown')) {
      this.presetIndex = KUN_TOOL_PERMISSION_MODES.length - 1
    } else if (matchesKey(data, 'enter')) {
      const mode = KUN_TOOL_PERMISSION_MODES[this.presetIndex]!
      if (mode === 'full-access' && !this.startsInFullAccess) {
        this.confirmingFullAccess = true
        this.error = ''
        return
      }
      const settings = kunToolPermissionModeSettings(mode)
      void this.save(
        settings.approvalPolicy,
        settings.sandboxMode,
        settings.approvalReviewer
      )
    }
  }

  invalidate(): void {}

  private renderFullAccessConfirmation(width: number): string[] {
    return pageFrame({
      path: ['KUN', 'Permissions', 'Confirm Full access'],
      description: 'Full access removes Kun-level approval and workspace restrictions.',
      body: [
        red(bold('Enable Full access?')),
        '',
        ...plainLines(
          'Kun may access any file on this computer, execute host commands, and use network-capable tools without Kun approval.',
          width - 2,
          0
        ),
        '',
        yellow('Only enable Full access for a task and workspace you trust.'),
        ...(this.error ? ['', red(this.error)] : [])
      ],
      footer: this.saving
        ? [{ key: statusGlyph('running'), label: 'saving' }]
        : [
            { key: 'Enter', label: 'enable Full access', tone: 'danger' },
            { key: 'Esc', label: 'cancel' }
          ],
      width
    })
  }

  private async save(
    approvalPolicy: ApprovalPolicy,
    sandboxMode: SandboxMode,
    approvalReviewer: ApprovalReviewer
  ): Promise<void> {
    this.saving = true
    try {
      const saved = await this.controller.setPermissions(
        approvalPolicy,
        sandboxMode,
        approvalReviewer
      )
      if (saved) this.close()
      else this.saving = false
    } catch (error) {
      this.saving = false
      this.error = safeError(error)
    }
  }
}
