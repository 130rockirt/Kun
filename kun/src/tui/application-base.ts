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
import type { SubagentDialog } from './subagent-dialog.js'
import type { GraphBoardDialog } from './graph-dialog.js'
import type { CommandPaletteDialog, VariantDialog, AgentModeDialog, GoalDialog } from './command-dialogs.js'
import type { ThreadPickerDialog, HelpDialog, InspectionDialog, PermissionDialog } from './session-dialogs.js'
import type { ApprovalDialog, UserInputDialog, TimelineDialog, SkillsDialog } from './runtime-dialogs.js'
import type { ConnectDialog } from './connect-dialog.js'
import type { ModelDialog } from './model-dialog.js'
import { ChatRoot } from './chat-root.js'

export abstract class PiTuiApplicationBase {
  protected readonly terminal: ScrollbackPreservingTerminal
  protected readonly tui: TUI
  protected readonly root: ChatRoot
  protected unsubscribeController?: () => void
  protected removeInputListener?: () => void
  protected resolveRun?: () => void
  protected started = false
  protected stopped = false
  protected threadOverlay?: { component: ThreadPickerDialog; handle: ExclusiveRouteHandle }
  protected helpOverlay?: { component: HelpDialog; handle: ExclusiveRouteHandle }
  protected approvalOverlay?: { id: string; component: ApprovalDialog; handle: ExclusiveRouteHandle }
  protected inputOverlay?: { id: string; component: UserInputDialog; handle: ExclusiveRouteHandle }
  protected connectRoute?: ConnectDialog
  protected modelRoute?: ModelDialog
  protected quotaRoute?: ProviderQuotaDialog
  protected usageRoute?: UsageDialog
  protected subagentRoute?: SubagentDialog
  protected subagentPopup?: { component: SubagentDialog; handle: OverlayHandle }
  protected subagentPopupReturn?: () => void
  protected graphPopup?: { runId: string; component: GraphBoardDialog; handle: OverlayHandle }
  protected pendingGraphSelection?: { runId: string; nodeId: string }
  protected commandOverlay?: { component: CommandPaletteDialog; handle: ExclusiveRouteHandle }
  protected variantOverlay?: { component: VariantDialog; handle: ExclusiveRouteHandle }
  protected agentOverlay?: { component: AgentModeDialog; handle: ExclusiveRouteHandle }
  protected goalOverlay?: { component: GoalDialog; handle: ExclusiveRouteHandle }
  protected inspectionOverlay?: { value: TuiControllerState['inspection']; component: InspectionDialog; handle: ExclusiveRouteHandle }
  protected permissionOverlay?: { component: PermissionDialog; handle: ExclusiveRouteHandle }
  protected timelineOverlay?: { component: TimelineDialog; handle: ExclusiveRouteHandle }
  protected skillsOverlay?: { component: SkillsDialog; handle: ExclusiveRouteHandle }
  protected autocompleteWorkspace?: string
  protected autocompleteRequest?: Promise<void>
  protected leaderPending = false
  protected leaderTimer?: ReturnType<typeof setTimeout>
  protected threadRefreshTimer?: ReturnType<typeof setInterval>
  protected animationTimer?: ReturnType<typeof setInterval>
  protected pendingExit?: { key: 'ctrl+c' | 'ctrl+d'; timer: ReturnType<typeof setTimeout> }
  protected pendingUndoTimer?: ReturnType<typeof setTimeout>
  protected terminalActive = false
  // Kun is an inline normal-screen application, so leave the mouse with the
  // terminal by default. This preserves wheel scrollback and ordinary
  // drag-selection/copy. Direct transcript clicks remain an explicit opt-in
  // through Ctrl+X P or /mouse on.
  protected pointerModeEnabled = false
  protected mouseTrackingWanted = false
  protected mouseTrackingEnabled = false
  protected clipboardPastePending = false
  protected readonly signalHandler = () => this.requestQuit()

  protected abstract copyLastResponse(): Promise<void>
  protected abstract editExternal(initial: string): Promise<string>
  protected abstract exportThread(path?: string): Promise<void>
  protected abstract hideAllOverlays(): void
  protected abstract openInteractiveTerminal(): Promise<void>
  protected abstract pasteClipboardImage(): Promise<void>
  protected abstract refreshSkillAutocomplete(workspace: string): Promise<void>
  protected abstract shareThread(): Promise<void>
  protected abstract unshareThread(): Promise<void>
  protected abstract showAgentModes(): void
  protected abstract showCommandPalette(): void
  protected abstract showConnect(): Promise<void>
  protected abstract showGoal(): void
  protected abstract showModels(): Promise<void>
  protected abstract showPermissions(): void
  protected abstract showQuota(): void
  protected abstract showSkills(query?: string): Promise<void>
  protected abstract showSubagents(): void
  protected abstract showSubagentPopup(child: ProjectedChildRun, onClose?: () => void): void
  protected abstract showTimeline(query?: string, target?: string): void
  protected abstract showUsage(): void
  protected abstract showVariants(): void
  protected abstract syncAnimation(state: TuiControllerState): void
  protected abstract syncGraphBoard(state: TuiControllerState): void
  protected abstract syncMouseTracking(state: TuiControllerState): void
  protected abstract syncOverlays(state: TuiControllerState): void
  protected abstract writeMouseTracking(enabled: boolean): void
  protected abstract handleTerminalInput(data: string): { consume?: boolean } | undefined
  protected abstract cancelLeader(): void
  protected abstract clearPendingExit(): void
  protected abstract clearPendingUndo(): void

  constructor(
    readonly controller: TuiController,
    input: TerminalInput,
    output: TerminalOutput,
    protected readonly keymap: TuiKeymap = parseTuiKeymapConfig({}).keymap,
    protected readonly clipboardImageReader: () => Promise<ClipboardImage | null> = readClipboardImage,
    protected readonly officialProviderAuthenticator?: (
      provider: OfficialProviderCliId
    ) => Promise<void>
  ) {
    const baseTerminal = input === processStdin && output === processStdout
      ? new ProcessTerminal()
      : new InlineStreamTerminal(input, output)
    this.terminal = new ScrollbackPreservingTerminal(baseTerminal)
    this.tui = new TUI(this.terminal, true)
    this.root = new ChatRoot(this.tui, controller, this.keymap, {
      onConnect: () => { void this.showConnect() },
      onModel: () => { void this.showModels() },
      onUsage: () => this.showUsage(),
      onQuota: () => this.showQuota(),
      onVariants: () => this.showVariants(),
      onGoal: () => this.showGoal(),
      onPermission: () => this.showPermissions(),
      onTimeline: (query, target) => this.showTimeline(query, target),
      onSubagents: () => this.showSubagents(),
      onSkills: (query) => { void this.showSkills(query) },
      onEditor: (initial) => this.editExternal(initial),
      onCopy: () => { void this.copyLastResponse() },
      onExport: (path) => { void this.exportThread(path) },
      onPointerMode: (action) => this.setPointerModeFromCommand(action),
      onTheme: (name) => this.controller.setTheme(name),
      onShare: () => { void this.shareThread() },
      onUnshare: () => { void this.unshareThread() },
      onConsole: () => { void this.controller.showRuntimeConsole() },
      onDiff: () => { void this.controller.showWorkspaceDiff() },
      onTerminal: () => { void this.openInteractiveTerminal() },
      onSessions: () => this.controller.showThreads(),
      onExtensions: () => { void this.controller.manageExtensions() },
      onPasteImage: () => this.pasteClipboardImage(),
      onClear: () => {
        this.terminal.clearScreen()
        this.tui.requestRender(true)
      }
    })
    this.root.setPointerMode(false)
  }

  run(): Promise<void> {
    if (this.started) return new Promise((resolve) => { this.resolveRun = resolve })
    this.started = true
    this.tui.addChild(this.root)
    this.tui.setFocus(this.root)
    this.removeInputListener = this.tui.addInputListener((data) => this.handleTerminalInput(data))
    this.unsubscribeController = this.controller.subscribe((state) => {
      this.subagentRoute?.updateParentProjection(state.projection)
      this.subagentPopup?.component.updateParentProjection(state.projection)
      this.graphPopup?.component.update(state)
      this.goalOverlay?.component.update(state)
      this.root.update(state)
      this.syncMouseTracking(state)
      this.syncAnimation(state)
      this.syncOverlays(state)
      this.syncGraphBoard(state)
      void this.refreshSkillAutocomplete(state.projection?.thread.workspace ?? this.controller.options.workspace)
      if (state.quitRequested) this.resolveRun?.()
      this.tui.requestRender()
    })
    process.on('SIGTERM', this.signalHandler)
    process.on('SIGHUP', this.signalHandler)
    this.tui.start()
    this.terminalActive = true
    this.syncMouseTracking(this.controller.state)
    this.terminal.setTitle('Kun')
    void this.refreshSkillAutocomplete(this.controller.state.projection?.thread.workspace ?? this.controller.options.workspace)
    return new Promise((resolve) => { this.resolveRun = resolve })
  }

  requestQuit(): void {
    this.controller.requestQuit()
  }

  async submitStartupGraphPrompt(prompt: string): Promise<boolean> {
    this.root.setEditorText(prompt)
    const submitted = await this.controller.submitGraphRequirement(prompt)
    if (submitted) this.root.setEditorText('')
    return submitted
  }

  protected setPointerModeFromCommand(action?: string): void {
    const normalized = action?.trim().toLowerCase()
    if (normalized && !['on', 'off', 'toggle'].includes(normalized)) {
      this.controller.notify('Usage: /mouse [on|off]', 'error')
      return
    }
    const enabled = normalized === 'on'
      ? true
      : normalized === 'off'
        ? false
        : !this.pointerModeEnabled
    this.setPointerMode(enabled)
  }

  protected setPointerMode(enabled: boolean, notify = true): void {
    if (this.pointerModeEnabled === enabled && this.mouseTrackingWanted === enabled) return
    this.pointerModeEnabled = enabled
    this.mouseTrackingWanted = enabled
    this.root.setPointerMode(enabled)
    this.writeMouseTracking(enabled)
    if (notify) {
      this.controller.notify(enabled
        ? 'Mouse clicks enabled · click Graph, Thinking, or a Subagent directly. Shift+drag selects in supported terminals.'
        : `Text selection mode · drag to select; ${this.keymap.display('pointer_mode_toggle')} restores clicks.`)
    }
    this.tui.requestRender()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    process.off('SIGTERM', this.signalHandler)
    process.off('SIGHUP', this.signalHandler)
    this.unsubscribeController?.()
    this.unsubscribeController = undefined
    this.removeInputListener?.()
    this.removeInputListener = undefined
    this.hideAllOverlays()
    this.cancelLeader()
    this.clearPendingExit()
    this.clearPendingUndo()
    this.pointerModeEnabled = false
    this.root.setPointerMode(false)
    this.mouseTrackingWanted = false
    this.writeMouseTracking(false)
    if (this.threadRefreshTimer) clearInterval(this.threadRefreshTimer)
    this.threadRefreshTimer = undefined
    if (this.animationTimer) clearInterval(this.animationTimer)
    this.animationTimer = undefined
    if (this.started) {
      await this.terminal.drainInput(250, 25).catch(() => undefined)
      this.tui.stop()
      this.terminalActive = false
    }
    this.resolveRun?.()
    this.resolveRun = undefined
  }
}
