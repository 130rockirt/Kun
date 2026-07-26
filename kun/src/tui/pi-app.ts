import {
  CombinedAutocompleteProvider,
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
  type SlashCommand,
  type Terminal
} from '@earendil-works/pi-tui'
import {
  providerCatalogEntries,
  type ProviderCatalogAuthFlow,
  type ProviderCatalogAuthType,
  type ProviderCatalogKind
} from '@kun/provider-catalog'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, sep } from 'node:path'
import { stdin as processStdin, stdout as processStdout } from 'node:process'
import { redactSecrets, redactSecretText } from '../config/secret-redaction.js'
import type { TurnItem } from '../contracts/items.js'
import type { ModelReasoningEffort } from '../contracts/capabilities.js'
import {
  APPROVAL_POLICIES,
  SANDBOX_MODES,
  type ApprovalPolicy,
  type SandboxMode
} from '../contracts/policy.js'
import type {
  ClaudeSdkInstallStatus,
  ModelConnectionOAuthStatus,
  ModelConnectionProfile,
  ModelConnectionSnapshot
} from '../contracts/model-connections.js'
import type { TuiCommand, TuiCommandDefinition } from './commands.js'
import { parseTuiCommand, TUI_COMMAND_DEFINITIONS, TUI_SLASH_COMMANDS } from './commands.js'
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
import { sanitizeTerminalText as stripTerminalControls } from './layout.js'
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
import {
  copyWithSystemClipboard,
  editTextInExternalEditor,
  lastAssistantText,
  osc52ClipboardSequence,
  writeThreadExport
} from './operations.js'
import {
  applyRuntimeEvent,
  hydrateProjectedChildRuns,
  projectThreadSnapshot,
  type ProjectedChildRun,
  type ProjectedTurnActivity,
  type ThreadProjection
} from './state.js'
import type { TerminalInput, TerminalOutput } from './pi-terminal.js'
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

const bold = visual.strong
const dim = visual.muted
const blue = visual.brand
const cyan = visual.focus
const green = visual.success
const yellow = visual.warning
const red = visual.danger
const magenta = visual.warning
const italic = visual.italic

/**
 * Ctrl+C follows the same contextual cancel path as Escape while a leader,
 * overlay, or exclusive route owns input. At the normal composer, the global
 * keymap still keeps its existing clear/exit behavior.
 */
const isCancelInput = (data: string): boolean =>
  matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')

const EXIT_CONFIRM_WINDOW_MS = 1_500
const UNDO_ESCAPE_WINDOW_MS = 600

const ENABLE_MOUSE_TRACKING = '\x1b[?1000h\x1b[?1006h'
const DISABLE_MOUSE_TRACKING = '\x1b[?1000l\x1b[?1006l'

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

const DIRECT_SEMANTIC_ACTIONS: readonly TuiKeyAction[] = [
  'session_new', 'session_list', 'session_timeline', 'session_compact', 'session_export',
  'session_status', 'session_undo', 'session_redo', 'session_child_first', 'session_parent',
  'session_sibling_next', 'session_sibling_previous', 'messages_copy', 'model_list',
  'agent_list', 'thinking_toggle', 'pointer_mode_toggle', 'tool_details_toggle', 'input_editor', 'input_steer',
  'session_quick_1', 'session_quick_2', 'session_quick_3',
  'session_quick_4', 'session_quick_5', 'session_quick_6', 'session_quick_7',
  'session_quick_8', 'session_quick_9'
]

// Runtime/model/tool strings are untrusted terminal input. Apply both secret
// redaction and control-sequence stripping at the display boundary so every
// component, overlay, notification, and clipboard path gets the same policy.
const sanitizeTerminalText = (value: string): string =>
  stripTerminalControls(redactSecretText(value))

const selectTheme: SelectListTheme = {
  selectedPrefix: cyan,
  selectedText: bold,
  description: dim,
  scrollInfo: dim,
  noMatch: dim
}

const editorTheme: EditorTheme = {
  borderColor: cyan,
  selectList: selectTheme
}

const markdownTheme: MarkdownTheme = {
  heading: bold,
  link: cyan,
  linkUrl: dim,
  code: yellow,
  codeBlock: (value) => value,
  codeBlockBorder: dim,
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

type ExclusiveRouteHandle = {
  hide: () => void
}

/** pi-tui application shell. It deliberately uses the normal screen buffer. */
export class PiTuiApplication {
  private readonly terminal: Terminal
  private readonly tui: TUI
  private readonly root: ChatRoot
  private unsubscribeController?: () => void
  private removeInputListener?: () => void
  private resolveRun?: () => void
  private started = false
  private stopped = false
  private threadOverlay?: { component: ThreadPickerDialog; handle: ExclusiveRouteHandle }
  private helpOverlay?: { component: HelpDialog; handle: ExclusiveRouteHandle }
  private approvalOverlay?: { id: string; component: ApprovalDialog; handle: ExclusiveRouteHandle }
  private inputOverlay?: { id: string; component: UserInputDialog; handle: ExclusiveRouteHandle }
  private connectRoute?: ConnectDialog
  private modelRoute?: ModelDialog
  private subagentRoute?: SubagentDialog
  private subagentPopup?: { component: SubagentDialog; handle: OverlayHandle }
  private commandOverlay?: { component: CommandPaletteDialog; handle: ExclusiveRouteHandle }
  private variantOverlay?: { component: VariantDialog; handle: ExclusiveRouteHandle }
  private agentOverlay?: { component: AgentModeDialog; handle: ExclusiveRouteHandle }
  private inspectionOverlay?: { value: TuiControllerState['inspection']; component: InspectionDialog; handle: ExclusiveRouteHandle }
  private permissionOverlay?: { component: PermissionDialog; handle: ExclusiveRouteHandle }
  private timelineOverlay?: { component: TimelineDialog; handle: ExclusiveRouteHandle }
  private skillsOverlay?: { component: SkillsDialog; handle: ExclusiveRouteHandle }
  private autocompleteWorkspace?: string
  private autocompleteRequest?: Promise<void>
  private leaderPending = false
  private leaderTimer?: ReturnType<typeof setTimeout>
  private threadRefreshTimer?: ReturnType<typeof setInterval>
  private animationTimer?: ReturnType<typeof setInterval>
  private pendingExit?: { key: 'ctrl+c' | 'ctrl+d'; timer: ReturnType<typeof setTimeout> }
  private pendingUndoTimer?: ReturnType<typeof setTimeout>
  private terminalActive = false
  private pointerModeEnabled = false
  private mouseTrackingWanted = false
  private mouseTrackingEnabled = false
  private readonly signalHandler = () => this.requestQuit()

  constructor(
    readonly controller: TuiController,
    input: TerminalInput,
    output: TerminalOutput,
    private readonly keymap: TuiKeymap = parseTuiKeymapConfig({}).keymap
  ) {
    const baseTerminal = input === processStdin && output === processStdout
      ? new ProcessTerminal()
      : new InlineStreamTerminal(input, output)
    this.terminal = new ScrollbackPreservingTerminal(baseTerminal)
    this.tui = new TUI(this.terminal, true)
    this.root = new ChatRoot(this.tui, controller, this.keymap, {
      onConnect: () => { void this.showConnect() },
      onModel: () => { void this.showModels() },
      onVariants: () => this.showVariants(),
      onPermission: () => this.showPermissions(),
      onTimeline: (query, target) => this.showTimeline(query, target),
      onSubagents: () => this.showSubagents(),
      onSkills: (query) => { void this.showSkills(query) },
      onEditor: (initial) => this.editExternal(initial),
      onCopy: () => { void this.copyLastResponse() },
      onExport: (path) => { void this.exportThread(path) },
      onPointerMode: (action) => this.setPointerModeFromCommand(action)
    })
  }

  run(): Promise<void> {
    if (this.started) return new Promise((resolve) => { this.resolveRun = resolve })
    this.started = true
    this.tui.addChild(this.root)
    this.tui.setFocus(this.root)
    this.removeInputListener = this.tui.addInputListener((data) => this.handleGlobalInput(data))
    this.unsubscribeController = this.controller.subscribe((state) => {
      this.subagentRoute?.updateParentProjection(state.projection)
      this.subagentPopup?.component.updateParentProjection(state.projection)
      this.root.update(state)
      this.syncMouseTracking(state)
      this.syncAnimation(state)
      this.syncOverlays(state)
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

  private setPointerModeFromCommand(action?: string): void {
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

  private setPointerMode(enabled: boolean, notify = true): void {
    if (this.pointerModeEnabled === enabled && this.mouseTrackingWanted === enabled) return
    this.pointerModeEnabled = enabled
    this.mouseTrackingWanted = enabled
    this.root.setPointerMode(enabled)
    this.writeMouseTracking(enabled)
    if (notify) {
      this.controller.notify(enabled
        ? 'Pointer mode enabled · click Thinking/Subagent · Esc or Ctrl+C returns to text selection.'
        : 'Text selection enabled · drag to select, then use your terminal copy shortcut.')
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

  private syncAnimation(state: TuiControllerState): void {
    const active = Boolean(
      state.busy ||
      state.connection === 'connecting' ||
      state.connection === 'reconnecting' ||
      state.projection?.runningTurnId ||
      state.projection?.childRuns.some((run) => run.status === 'queued' || run.status === 'running')
    )
    if (active && !this.animationTimer) {
      this.animationTimer = setInterval(() => {
        this.root.tickAnimation()
        this.tui.requestRender()
      }, 80)
    } else if (!active && this.animationTimer) {
      clearInterval(this.animationTimer)
      this.animationTimer = undefined
    }
  }

  private handleGlobalInput(data: string): { consume?: boolean } | undefined {
    const mouse = parseSgrMouseEvent(data)
    if (mouse) {
      this.clearPendingGestures()
      if (!this.pointerModeEnabled) return { consume: true }
      if (this.subagentPopup) {
        this.subagentPopup.component.handleMouse(mouse)
        return { consume: true }
      }
      if (this.tui.hasOverlay()) return { consume: true }
      if (this.subagentRoute) {
        this.subagentRoute.handleMouse(mouse)
        return { consume: true }
      }
      if (mouse.pressed && (mouse.button & 3) === 0) {
        if (this.root.toggleThinkingAtTerminalRow(mouse.y)) return { consume: true }
        const child = this.root.childAtTerminalRow(mouse.y)
        if (child) this.showSubagentPopup(child)
      }
      // Mouse protocol bytes must never reach the composer as text.
      return { consume: true }
    }
    // Focused modal components own their keys. This preserves approval and
    // structured-input priority over global shortcuts.
    if (this.tui.hasOverlay()) {
      this.clearPendingGestures()
      return undefined
    }
    // Dense selectors rendered as primary routes own every key before the
    // composer, session, leader, and global layers. They are deliberately not
    // pi-tui overlays: inline overlays are transparent and visually mix with
    // the welcome/transcript beneath them.
    if (this.root.hasPrimaryRoute()) {
      this.clearPendingGestures()
      return undefined
    }
    if (this.pointerModeEnabled && isCancelInput(data)) {
      this.clearPendingGestures()
      this.setPointerMode(false)
      return { consume: true }
    }
    this.cancelPendingGesturesForDifferentInput(data)
    if (this.leaderPending) {
      this.cancelLeader()
      if (isCancelInput(data)) return { consume: true }
      const match = this.keymap.leaderMatch(data)
      if (match) this.executeKeyAction(match.action)
      else this.controller.notify('Unknown Leader sequence.', 'error')
      return match && (match.binding.preventDefault === false || match.binding.fallthrough)
        ? undefined
        : { consume: true }
    }
    if (this.keymap.matchesLeader(data)) {
      this.beginLeader()
      return this.keyConsumption('leader', data)
    }
    if (this.keymap.matches('command_list', data)) {
      this.showCommandPalette()
      return this.keyConsumption('command_list', data)
    }
    if (this.keymap.matches('variant_cycle', data)) {
      this.controller.cycleReasoningEffort()
      return this.keyConsumption('variant_cycle', data)
    }
    if (this.keymap.matches('input_newline', data)) {
      this.root.insertNewline()
      return this.keyConsumption('input_newline', data)
    }
    if (this.keymap.matches('input_clear', data) && !this.root.editorEmpty()) {
      this.clearPendingGestures()
      this.root.clearEditor()
      return this.keyConsumption('input_clear', data)
    }
    if (this.keymap.matches('app_exit', data)) {
      if (this.root.editorEmpty()) {
        const key = matchesKey(data, 'ctrl+c')
          ? 'ctrl+c'
          : matchesKey(data, 'ctrl+d')
            ? 'ctrl+d'
            : undefined
        if (key === 'ctrl+c' && this.controller.state.projection?.runningTurnId) {
          this.clearPendingGestures()
          void this.controller.interrupt()
          return this.keyConsumption('app_exit', data)
        }
        if (!key) {
          this.clearPendingGestures()
          this.requestQuit()
          return this.keyConsumption('app_exit', data)
        }
        if (this.pendingExit?.key === key) {
          this.clearPendingGestures()
          this.requestQuit()
        } else {
          this.armPendingExit(key)
        }
        return this.keyConsumption('app_exit', data)
      }
      return undefined
    }
    if (this.keymap.matches('session_interrupt', data)) {
      if (this.root.mayHaveAutocomplete()) return undefined
      if (this.controller.state.projection?.runningTurnId) {
        this.clearPendingGestures()
        void this.controller.interrupt()
        return this.keyConsumption('session_interrupt', data)
      }
      if (matchesKey(data, 'escape') && this.root.editorEmpty() && this.controller.state.projection) {
        if (this.pendingUndoTimer) {
          this.clearPendingUndo()
          void this.controller.undoLastTurn()
        } else {
          this.armPendingUndo()
        }
        return this.keyConsumption('session_interrupt', data)
      }
      return undefined
    }
    if (this.root.editorEmpty() && this.controller.state.projection) {
      if (matchesKey(data, 'left')) {
        void this.controller.navigateSessionRelation('previous-sibling')
        return { consume: true }
      }
      if (matchesKey(data, 'right')) {
        void this.controller.navigateSessionRelation('next-sibling')
        return { consume: true }
      }
      if (matchesKey(data, 'up')) {
        void this.controller.navigateSessionRelation('parent')
        return { consume: true }
      }
    }
    if (this.keymap.matches('session_rename', data) && this.root.editorEmpty()) {
      this.root.setEditorText('/rename ')
      return this.keyConsumption('session_rename', data)
    }
    if (this.keymap.matches('agent_cycle', data) || this.keymap.matches('agent_cycle_reverse', data)) {
      if (this.root.mayHaveAutocomplete()) return undefined
      const mode = this.controller.state.projection?.thread.mode ?? this.controller.state.composerMode
      void this.controller.setPlanMode(mode === 'agent' ? 'plan' : 'agent')
      return this.keyConsumption(this.keymap.matches('agent_cycle', data) ? 'agent_cycle' : 'agent_cycle_reverse', data)
    }
    if (this.keymap.matches('model_cycle_recent', data)) {
      void this.controller.cycleRecentModel(1)
      return this.keyConsumption('model_cycle_recent', data)
    }
    if (this.keymap.matches('model_cycle_recent_reverse', data)) {
      void this.controller.cycleRecentModel(-1)
      return this.keyConsumption('model_cycle_recent_reverse', data)
    }
    if (this.keymap.matches('app_suspend', data)) {
      this.suspendProcess()
      return this.keyConsumption('app_suspend', data)
    }
    const directAction = DIRECT_SEMANTIC_ACTIONS.find((action) => this.keymap.matches(action, data))
    if (directAction) {
      this.executeKeyAction(directAction)
      return this.keyConsumption(directAction, data)
    }
    if (matchesKey(data, 'ctrl+l')) {
      this.tui.requestRender(true)
      return { consume: true }
    }
    return undefined
  }

  private cancelPendingGesturesForDifferentInput(data: string): void {
    if (this.pendingExit && !matchesKey(data, this.pendingExit.key)) this.clearPendingExit()
    if (this.pendingUndoTimer && !matchesKey(data, 'escape')) this.clearPendingUndo()
  }

  private armPendingExit(key: 'ctrl+c' | 'ctrl+d'): void {
    this.clearPendingExit()
    const label = key === 'ctrl+c' ? 'Ctrl+C' : 'Ctrl+D'
    this.root.setTransientHint(`Press ${label} again to exit`)
    this.pendingExit = {
      key,
      timer: setTimeout(() => this.clearPendingExit(), EXIT_CONFIRM_WINDOW_MS)
    }
    this.tui.requestRender()
  }

  private clearPendingExit(): void {
    if (!this.pendingExit) return
    clearTimeout(this.pendingExit.timer)
    this.pendingExit = undefined
    this.root.setTransientHint(undefined)
    this.tui.requestRender()
  }

  private armPendingUndo(): void {
    this.clearPendingUndo()
    this.root.setTransientHint('Press Esc again to undo the last turn')
    this.pendingUndoTimer = setTimeout(() => this.clearPendingUndo(), UNDO_ESCAPE_WINDOW_MS)
    this.tui.requestRender()
  }

  private clearPendingUndo(): void {
    if (!this.pendingUndoTimer) return
    clearTimeout(this.pendingUndoTimer)
    this.pendingUndoTimer = undefined
    this.root.setTransientHint(undefined)
    this.tui.requestRender()
  }

  private clearPendingGestures(): void {
    this.clearPendingExit()
    this.clearPendingUndo()
  }

  private keyConsumption(action: TuiKeyAction, data: string): { consume?: boolean } | undefined {
    const binding = this.keymap.match(action, data)
    return binding?.preventDefault !== false && !binding?.fallthrough ? { consume: true } : undefined
  }

  private beginLeader(): void {
    this.cancelLeader()
    this.leaderPending = true
    this.root.setLeaderHint(this.keymap.leaderActions())
    this.leaderTimer = setTimeout(() => {
      this.cancelLeader()
      this.controller.notify('Leader timed out.')
    }, this.keymap.leaderTimeoutMs)
    this.tui.requestRender()
  }

  private cancelLeader(): void {
    if (this.leaderTimer) clearTimeout(this.leaderTimer)
    this.leaderTimer = undefined
    this.leaderPending = false
    this.root.setLeaderHint(undefined)
  }

  private executeKeyAction(action: TuiKeyAction): void {
    if (action.startsWith('session_quick_')) {
      const slot = Number(action.slice('session_quick_'.length))
      void this.controller.openQuickSession(slot)
      return
    }
    switch (action) {
      case 'session_new': void this.controller.createThread(); break
      case 'session_list': this.controller.showThreads(); break
      case 'session_timeline': this.showTimeline(); break
      case 'session_compact': void this.controller.compact(); break
      case 'session_export': void this.exportThread(); break
      case 'session_status': void this.controller.showStatus(); break
      case 'messages_copy': void this.copyLastResponse(); break
      case 'session_undo': void this.controller.undoLastTurn(); break
      case 'session_redo': void this.controller.redoBranch(); break
      case 'session_child_first': void this.controller.navigateSessionRelation('child'); break
      case 'session_parent': void this.controller.navigateSessionRelation('parent'); break
      case 'session_sibling_next': void this.controller.navigateSessionRelation('next-sibling'); break
      case 'session_sibling_previous': void this.controller.navigateSessionRelation('previous-sibling'); break
      case 'model_list': void this.showModels(); break
      case 'agent_list': this.showAgentModes(); break
      case 'thinking_toggle': void this.root.executeSlash('thinking'); break
      case 'pointer_mode_toggle': this.setPointerModeFromCommand(); break
      case 'tool_details_toggle': this.root.toggleToolDetails(); break
      case 'input_editor': void this.root.openExternalEditor(); break
      case 'input_steer': void this.root.steerEditor(); break
      case 'app_exit': this.requestQuit(); break
      case 'command_list': this.showCommandPalette(); break
      case 'variant_cycle': this.controller.cycleReasoningEffort(); break
      default: this.controller.notify(`Action ${action} is unavailable in this context.`, 'error')
    }
  }

  private suspendProcess(): void {
    if (process.platform === 'win32') {
      this.controller.notify('Process suspend is only available on Unix terminals.', 'error')
      return
    }
    this.setPointerMode(false, false)
    this.writeMouseTracking(false)
    this.tui.stop()
    this.terminalActive = false
    process.once('SIGCONT', () => {
      if (this.stopped) return
      this.tui.start()
      this.terminalActive = true
      this.writeMouseTracking(this.mouseTrackingWanted)
      this.terminal.setTitle('Kun')
      this.tui.setFocus(this.root)
      this.tui.requestRender(true)
    })
    process.kill(process.pid, 'SIGTSTP')
  }

  private showExclusiveRoute(
    kind: string,
    component: Component & Focusable
  ): ExclusiveRouteHandle {
    let visible = true
    this.root.showPrimaryRoute(kind, component)
    this.tui.setFocus(component)
    this.tui.requestRender()
    return {
      hide: () => {
        if (!visible) return
        visible = false
        this.root.hidePrimaryRoute(component)
        this.tui.setFocus(this.root.activePrimaryRoute() ?? this.root)
        this.tui.requestRender()
      }
    }
  }

  private syncOverlays(state: TuiControllerState): void {
    if (state.modelConnections) {
      this.connectRoute?.updateSnapshot(state.modelConnections)
      this.modelRoute?.updateSnapshot(state.modelConnections)
    }

    if (state.view === 'threads') {
      if (!this.threadOverlay) {
        const component = new ThreadPickerDialog(this.controller, this.tui, this.keymap)
        const handle = this.showExclusiveRoute('sessions', component)
        this.threadOverlay = { component, handle }
        this.threadRefreshTimer = setInterval(() => {
          void this.controller.refreshThreads(this.controller.state.threadSearch)
        }, 2_000)
      }
      this.threadOverlay.component.update(state)
    } else if (this.threadOverlay) {
      this.threadOverlay.handle.hide()
      this.threadOverlay = undefined
      if (this.threadRefreshTimer) clearInterval(this.threadRefreshTimer)
      this.threadRefreshTimer = undefined
    }

    if (state.view === 'help') {
      if (!this.helpOverlay) {
        const component = new HelpDialog(this.controller, this.keymap)
        this.helpOverlay = {
          component,
          handle: this.showExclusiveRoute('help', component)
        }
      }
    } else if (this.helpOverlay) {
      this.helpOverlay.handle.hide()
      this.helpOverlay = undefined
    }

    const approval = state.projection?.pendingApproval
    if (approval) {
      if (this.approvalOverlay?.id !== approval.approvalId) {
        this.approvalOverlay?.handle.hide()
        const component = new ApprovalDialog(this.controller, approval.toolName, approval.summary)
        this.approvalOverlay = {
          id: approval.approvalId,
          component,
          handle: this.showExclusiveRoute('approval', component)
        }
      }
    } else if (this.approvalOverlay) {
      this.approvalOverlay.handle.hide()
      this.approvalOverlay = undefined
    }

    const pendingInput = state.projection?.pendingUserInput
    if (pendingInput) {
      if (this.inputOverlay?.id !== pendingInput.inputId) {
        this.inputOverlay?.handle.hide()
        const component = new UserInputDialog(this.tui, this.controller, createUserInputSession(pendingInput))
        this.inputOverlay = {
          id: pendingInput.inputId,
          component,
          handle: this.showExclusiveRoute('input', component)
        }
      }
    } else if (this.inputOverlay) {
      this.inputOverlay.handle.hide()
      this.inputOverlay = undefined
    }

    if (state.inspection && !approval && !pendingInput) {
      if (this.inspectionOverlay?.value !== state.inspection) {
        this.inspectionOverlay?.handle.hide()
        const component = new InspectionDialog(
          this.controller,
          state.inspection.title,
          state.inspection.lines,
          () => this.terminal.rows
        )
        this.inspectionOverlay = {
          value: state.inspection,
          component,
          handle: this.showExclusiveRoute('inspection', component)
        }
      }
    } else if (this.inspectionOverlay) {
      this.inspectionOverlay.handle.hide()
      this.inspectionOverlay = undefined
    }
  }

  private showPermissions(): void {
    if (this.permissionOverlay) return
    const thread = this.controller.state.projection?.thread
    if (!thread) { this.controller.notify('Open or create a thread first.', 'error'); return }
    const component = new PermissionDialog(this.controller, thread.approvalPolicy, thread.sandboxMode, () => {
      this.permissionOverlay?.handle.hide()
      this.permissionOverlay = undefined
      this.tui.setFocus(this.root)
    })
    this.permissionOverlay = {
      component,
      handle: this.showExclusiveRoute('permissions', component)
    }
  }

  private showTimeline(query?: string, target?: string): void {
    this.timelineOverlay?.handle.hide()
    const projection = this.controller.state.projection
    if (!projection) { this.controller.notify('Open or create a thread first.', 'error'); return }
    const component = new TimelineDialog(this.controller, projection, query, target, () => {
      this.timelineOverlay?.handle.hide()
      this.timelineOverlay = undefined
      this.tui.setFocus(this.root)
    })
    this.timelineOverlay = {
      component,
      handle: this.showExclusiveRoute('timeline', component)
    }
  }

  private async showSkills(query?: string): Promise<void> {
    this.skillsOverlay?.handle.hide()
    try {
      const workspace = this.controller.state.projection?.thread.workspace ?? this.controller.options.workspace
      const snapshot = await this.controller.client.skills(workspace)
      const component = new SkillsDialog(this.controller, snapshot, query, () => {
        this.skillsOverlay?.handle.hide()
        this.skillsOverlay = undefined
        this.tui.setFocus(this.root)
      })
      this.skillsOverlay = {
        component,
        handle: this.showExclusiveRoute('skills', component)
      }
    } catch (error) {
      this.controller.notify(safeError(error), 'error')
    }
  }

  private async refreshSkillAutocomplete(workspace: string): Promise<void> {
    if (this.autocompleteWorkspace === workspace) return
    if (this.autocompleteRequest) return this.autocompleteRequest
    const request = this.controller.client.skills(workspace).then((snapshot) => {
      if (this.stopped) return
      this.autocompleteWorkspace = workspace
      this.root.setAutocomplete(snapshot.skills, workspace)
    }).catch(() => undefined).finally(() => {
      if (this.autocompleteRequest !== request) return
      this.autocompleteRequest = undefined
      const desired = this.controller.state.projection?.thread.workspace ?? this.controller.options.workspace
      if (desired !== this.autocompleteWorkspace) void this.refreshSkillAutocomplete(desired)
    })
    this.autocompleteRequest = request
    return request
  }

  private async editExternal(initial: string): Promise<string> {
    this.setPointerMode(false, false)
    this.writeMouseTracking(false)
    this.tui.stop()
    this.terminalActive = false
    try {
      return await editTextInExternalEditor(initial)
    } finally {
      if (!this.stopped) {
        this.tui.start()
        this.terminalActive = true
        this.writeMouseTracking(this.mouseTrackingWanted)
        this.terminal.setTitle('Kun')
        this.tui.setFocus(this.root)
        this.tui.requestRender(true)
      }
    }
  }

  private async copyLastResponse(): Promise<void> {
    const projection = this.controller.state.projection
    if (!projection) { this.controller.notify('Open or create a thread first.', 'error'); return }
    const text = lastAssistantText(projection.thread)
    if (!text) { this.controller.notify('No assistant response is available to copy.', 'error'); return }
    const safeText = sanitizeTerminalText(text)
    // Match Kimi's remote-terminal behavior: give the local terminal an
    // OSC52 copy request even when native clipboard tooling exists on the
    // host, then use the native result as the verified delivery method.
    this.terminal.write(osc52ClipboardSequence(safeText))
    const method = await copyWithSystemClipboard(safeText)
    this.controller.notify(`Copied the last assistant response${method ? ` with ${method}` : ' with OSC52'}.`)
  }

  private async exportThread(path?: string): Promise<void> {
    const projection = this.controller.state.projection
    if (!projection) { this.controller.notify('Open or create a thread first.', 'error'); return }
    try {
      const written = await writeThreadExport(projection.thread, path)
      this.controller.notify(`Exported Markdown: ${written}`)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      this.controller.notify(code === 'EEXIST'
        ? 'Export target already exists; choose a new path so Kun does not overwrite it.'
        : safeError(error), 'error')
    }
  }

  private async showConnect(): Promise<void> {
    this.closeModelRoute()
    this.closeSubagentRoute()
    if (this.connectRoute) return
    try {
      const snapshot = await this.controller.client.modelConnections()
      const component = new ConnectDialog(
        this.tui,
        this.controller,
        snapshot,
        () => this.closeConnectRoute()
      )
      this.connectRoute = component
      this.root.showPrimaryRoute('connect', component)
      this.tui.setFocus(component)
      this.tui.requestRender()
    } catch (error) {
      this.controller.notify(safeError(error), 'error')
    }
  }

  private async showModels(): Promise<void> {
    this.closeConnectRoute()
    this.closeSubagentRoute()
    if (this.modelRoute) return
    try {
      const snapshot = this.controller.state.modelConnections ??
        await this.controller.client.modelConnections()
      const component = new ModelDialog(this.tui, this.controller, this.keymap, snapshot, () => this.closeModelRoute())
      this.modelRoute = component
      this.root.showPrimaryRoute('models', component)
      this.tui.setFocus(component)
      this.tui.requestRender()
    } catch (error) {
      this.controller.notify(safeError(error), 'error')
    }
  }

  private closeModelRoute(): void {
    if (!this.modelRoute) return
    const route = this.modelRoute
    this.modelRoute = undefined
    this.root.hidePrimaryRoute(route)
    this.tui.setFocus(this.root)
    this.tui.requestRender()
  }

  private closeConnectRoute(): void {
    if (!this.connectRoute) return
    const route = this.connectRoute
    this.connectRoute = undefined
    this.root.hidePrimaryRoute(route)
    this.tui.setFocus(this.root)
    this.tui.requestRender()
  }

  private showSubagents(): void {
    this.closeConnectRoute()
    this.closeModelRoute()
    if (this.subagentRoute) return
    const projection = this.controller.state.projection
    if (!projection) {
      this.controller.notify('Open or create a session first.', 'error')
      return
    }
    const component = new SubagentDialog(
      this.tui,
      this.controller,
      projection,
      () => this.closeSubagentRoute()
    )
    this.subagentRoute = component
    this.root.showPrimaryRoute('subagents', component)
    this.tui.setFocus(component)
    this.tui.requestRender()
  }

  private showSubagentPopup(child: ProjectedChildRun): void {
    this.closeSubagentPopup()
    const projection = this.controller.state.projection
    if (!projection) return
    const component = new SubagentDialog(
      this.tui,
      this.controller,
      projection,
      () => this.closeSubagentPopup(),
      true
    )
    const handle = this.tui.showOverlay(component, {
      width: '90%',
      minWidth: 42,
      maxHeight: '85%',
      anchor: 'center',
      margin: 1
    })
    this.subagentPopup = { component, handle }
    this.tui.setFocus(component)
    void component.open(child)
  }

  private closeSubagentPopup(): void {
    if (!this.subagentPopup) return
    const popup = this.subagentPopup
    this.subagentPopup = undefined
    popup.component.dispose()
    popup.handle.hide()
    this.setPointerMode(false, false)
    this.tui.setFocus(this.root)
    this.syncMouseTracking(this.controller.state)
    this.tui.requestRender()
  }

  private closeSubagentRoute(): void {
    if (!this.subagentRoute) return
    const route = this.subagentRoute
    this.subagentRoute = undefined
    route.dispose()
    this.root.hidePrimaryRoute(route)
    this.tui.setFocus(this.root)
    this.tui.requestRender()
  }

  private showCommandPalette(): void {
    if (this.commandOverlay) return
    const component = new CommandPaletteDialog(this.keymap, (entry) => {
      this.commandOverlay?.handle.hide()
      this.commandOverlay = undefined
      this.tui.setFocus(this.root)
      if (!entry?.slash) return
      if (entry.argumentRequired) this.root.setEditorText(`/${entry.slash} `)
      else void this.root.executeSlash(entry.slash)
    })
    this.commandOverlay = {
      component,
      handle: this.showExclusiveRoute('commands', component)
    }
  }

  private showVariants(): void {
    if (this.variantOverlay) return
    const efforts = this.controller.reasoningOptions()
    if (!efforts.length) {
      this.controller.notify('The selected model does not expose reasoning variants.', 'error')
      return
    }
    const component = new VariantDialog(this.controller, efforts, () => {
      this.variantOverlay?.handle.hide()
      this.variantOverlay = undefined
      this.tui.setFocus(this.root)
    })
    this.variantOverlay = {
      component,
      handle: this.showExclusiveRoute('reasoning', component)
    }
  }

  private showAgentModes(): void {
    if (this.agentOverlay) return
    const component = new AgentModeDialog(this.controller, () => {
      this.agentOverlay?.handle.hide()
      this.agentOverlay = undefined
      this.tui.setFocus(this.root)
    })
    this.agentOverlay = {
      component,
      handle: this.showExclusiveRoute('mode', component)
    }
  }

  private hideAllOverlays(): void {
    this.closeSubagentPopup()
    for (const entry of [
      this.threadOverlay, this.helpOverlay, this.approvalOverlay, this.inputOverlay,
      this.inspectionOverlay, this.permissionOverlay, this.timelineOverlay, this.skillsOverlay,
      this.commandOverlay, this.variantOverlay, this.agentOverlay
    ]) {
      entry?.handle.hide()
    }
    this.threadOverlay = undefined
    this.helpOverlay = undefined
    this.approvalOverlay = undefined
    this.inputOverlay = undefined
    this.inspectionOverlay = undefined
    this.permissionOverlay = undefined
    this.timelineOverlay = undefined
    this.skillsOverlay = undefined
    this.commandOverlay = undefined
    this.variantOverlay = undefined
    this.agentOverlay = undefined
    this.closeConnectRoute()
    this.closeModelRoute()
    this.closeSubagentRoute()
  }

  private syncMouseTracking(_state: TuiControllerState): void {
    this.mouseTrackingWanted = this.pointerModeEnabled
    this.writeMouseTracking(this.mouseTrackingWanted)
  }

  private writeMouseTracking(enabled: boolean): void {
    if (!this.terminalActive || this.mouseTrackingEnabled === enabled) return
    this.terminal.write(enabled ? ENABLE_MOUSE_TRACKING : DISABLE_MOUSE_TRACKING)
    this.mouseTrackingEnabled = enabled
  }
}

class ChatRoot implements Component, Focusable {
  private state: TuiControllerState
  private readonly transcript = new TranscriptComponent()
  private readonly editor: Editor
  // Keep the transcript readable by default: reasoning fragments continue to
  // accumulate, but only their compact disclosure row is shown until the user
  // expands all Thinking bodies with /thinking.
  private showReasoning = false
  private showToolDetails = false
  private pointerMode = false
  private transientHint?: string
  private leaderHint?: Array<{ action: TuiKeyAction; key: string }>
  private primaryRoutes: Array<{ kind: string; component: Component & Focusable }> = []
  private _focused = false
  private animationFrame = 0
  private transcriptStartRow?: number
  private lastRenderedLineCount = 0

  constructor(
    private readonly tui: TUI,
    private readonly controller: TuiController,
    private readonly keymap: TuiKeymap,
    private readonly actions: {
      onConnect: () => void
      onModel: () => void
      onVariants: () => void
      onPermission: () => void
      onTimeline: (query?: string, target?: string) => void
      onSubagents: () => void
      onSkills: (query?: string) => void
      onEditor: (initial: string) => Promise<string>
      onCopy: () => void
      onExport: (path?: string) => void
      onPointerMode: (action?: string) => void
    }
  ) {
    this.state = controller.state
    this.editor = new Editor(tui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 8 })
    this.setAutocomplete([], controller.options.workspace)
    this.editor.onSubmit = (text) => void this.submit(text)
  }

  get focused(): boolean { return this._focused }
  set focused(value: boolean) {
    this._focused = value
    this.editor.focused = value
  }

  update(state: TuiControllerState): void {
    this.state = state
    this.transcript.update(state.projection, this.showReasoning, this.showToolDetails, this.controller.runtime.legacyGui === true)
  }

  tickAnimation(): void {
    this.animationFrame = (this.animationFrame + 1) % 80
  }

  editorEmpty(): boolean { return this.editor.getText().length === 0 }

  clearEditor(): void { this.editor.setText(''); this.tui.requestRender() }

  insertNewline(): void { this.editor.handleInput('\x0a'); this.tui.requestRender() }

  setEditorText(text: string): void { this.editor.setText(text); this.tui.requestRender() }

  setPointerMode(enabled: boolean): void {
    this.pointerMode = enabled
    this.tui.requestRender()
  }

  setTransientHint(hint: string | undefined): void {
    this.transientHint = hint
  }

  toggleToolDetails(): void {
    this.showToolDetails = !this.showToolDetails
    this.transcript.update(
      this.state.projection,
      this.showReasoning,
      this.showToolDetails,
      this.controller.runtime.legacyGui === true
    )
    this.controller.notify(`Tool details ${this.showToolDetails ? 'expanded' : 'collapsed'}.`)
    this.tui.requestRender()
  }

  async openExternalEditor(): Promise<void> {
    const initial = this.editor.getText()
    try {
      const edited = await this.actions.onEditor(initial)
      this.editor.setText(edited.replace(/\s+$/u, ''))
    } catch (error) {
      this.controller.notify(safeError(error), 'error')
    }
    this.tui.requestRender()
  }

  async steerEditor(): Promise<void> {
    if (!this.state.projection?.runningTurnId) {
      this.controller.notify('Ctrl+S steers only while a turn is running; press Enter to send.', 'error')
      return
    }
    const raw = this.editor.getText()
    const text = raw.trim()
    if (!text) {
      this.controller.notify('Type guidance before pressing Ctrl+S.', 'error')
      return
    }
    this.editor.addToHistory(raw)
    this.editor.setText('')
    this.tui.requestRender()
    await this.controller.submit(text)
  }

  mayHaveAutocomplete(): boolean {
    const text = this.editor.getText()
    return /(?:^|\s)(?:\/[^\s]*|@[^\s]*|\.{1,2}\/[^\s]*|~\/[^\s]*)$/u.test(text)
  }

  setLeaderHint(hint: Array<{ action: TuiKeyAction; key: string }> | undefined): void {
    this.leaderHint = hint
  }

  hasPrimaryRoute(): boolean { return this.primaryRoutes.length > 0 }

  activePrimaryRoute(): Component & Focusable | undefined {
    return this.primaryRoutes.at(-1)?.component
  }

  childAtTerminalRow(terminalRow: number): ProjectedChildRun | undefined {
    const renderedRow = this.transcriptRenderedRowAtTerminalRow(terminalRow)
    return renderedRow === undefined ? undefined : this.transcript.childAtRenderedRow(renderedRow)
  }

  toggleThinkingAtTerminalRow(terminalRow: number): boolean {
    const renderedRow = this.transcriptRenderedRowAtTerminalRow(terminalRow)
    if (renderedRow === undefined || !this.transcript.toggleReasoningAtRenderedRow(renderedRow)) return false
    this.tui.requestRender()
    return true
  }

  private transcriptRenderedRowAtTerminalRow(terminalRow: number): number | undefined {
    if (this.transcriptStartRow === undefined || terminalRow < 1) return undefined
    const viewportStart = Math.max(0, this.lastRenderedLineCount - this.tui.terminal.rows)
    const contentRow = viewportStart + terminalRow - 1
    return contentRow - this.transcriptStartRow
  }

  showPrimaryRoute(kind: string, component: Component & Focusable): void {
    this.primaryRoutes = this.primaryRoutes.filter((route) => route.component !== component)
    this.primaryRoutes.push({ kind, component })
    this.editor.focused = false
  }

  hidePrimaryRoute(component: Component & Focusable): void {
    this.primaryRoutes = this.primaryRoutes.filter((route) => route.component !== component)
  }

  async executeSlash(name: string): Promise<void> {
    const command = parseTuiCommand(`/${name}`)
    if (command) await this.execute(command)
    this.tui.requestRender()
  }

  setAutocomplete(skills: SkillsSnapshot['skills'], workspace: string): void {
    const skillCommands: SlashCommand[] = skills.map((skill) => ({
      name: `skill:${skill.id}`,
      description: skill.description || `Invoke ${skill.name}`,
      argumentHint: '[prompt]'
    }))
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(
      [...TUI_SLASH_COMMANDS, ...skillCommands], workspace, null
    ))
  }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width)
    const projection = this.state.projection
    const primaryRoute = this.primaryRoutes.at(-1)
    this.transcriptStartRow = undefined
    const lines: string[] = []
    if (primaryRoute) {
      lines.push(...primaryRoute.component.render(safeWidth))
      // Keep an exclusive route at least one terminal tall. The blank tail is
      // intentional: it erases the previous welcome/transcript/composer frame
      // in normal-screen inline rendering without switching screen buffers.
      const tail = Math.max(0, this.tui.terminal.rows - lines.length)
      lines.push(...Array.from({ length: tail }, () => ''))
      this.lastRenderedLineCount = lines.length
      return lines.map((line) => truncateToWidth(line, safeWidth))
    }
    if (projection) {
      lines.push(renderConversationContext(this.state, this.controller, safeWidth), dim('─'.repeat(safeWidth)), '')
      this.transcriptStartRow = lines.length
      lines.push(...this.transcript.render(safeWidth, this.animationFrame))
    } else {
      lines.push(...renderKunWelcome(this.state, this.controller, safeWidth, this.tui.terminal.rows))
    }

    const composerLines = renderKunComposerFrame(
      this.editor.render(Math.max(8, safeWidth - 5)),
      this.state,
      this.controller,
      safeWidth,
      this.keymap
    )
    const activity = renderActivityRow(this.state, this.controller, safeWidth, this.animationFrame, this.transientHint)
    const bottom = [
      ...(activity ? [activity] : []),
      ...composerLines,
      renderShortcutFooter(this.state, this.keymap, safeWidth, this.leaderHint, this.pointerMode)
    ]
    // Keep the activity/composer cluster at the bottom of a roomy terminal.
    // Once the transcript grows, the spacer naturally disappears and the
    // normal terminal scrollback takes over.
    const spacer = Math.max(1, this.tui.terminal.rows - lines.length - bottom.length)
    lines.push(...Array.from({ length: spacer }, () => ''), ...bottom)
    this.lastRenderedLineCount = lines.length
    return lines.map((line) => truncateToWidth(line, safeWidth))
  }

  handleInput(data: string): void {
    this.editor.handleInput(data)
  }

  invalidate(): void {
    this.editor.invalidate()
    this.transcript.invalidate()
  }

  private async submit(raw: string): Promise<void> {
    const text = raw.trim()
    if (!text) return
    const command = parseTuiCommand(text)
    if (!command) {
      // Match Kimi's perceived-latency behavior: consume the prompt and let
      // the controller publish its local "preparing/sending" phase before
      // waiting for thread creation or the start-turn HTTP acknowledgement.
      this.editor.addToHistory(raw)
      this.editor.setText('')
      this.tui.requestRender()
      await this.controller.submit(text)
      return
    }
    await this.execute(command)
    this.editor.addToHistory(raw)
    // /editor deliberately leaves the edited draft in the composer. Every
    // other command consumes its input as usual.
    if (command.kind !== 'editor') this.editor.setText('')
    this.tui.requestRender()
  }

  async execute(command: TuiCommand): Promise<void> {
    switch (command.kind) {
      case 'help': this.controller.showHelp(); break
      case 'threads': this.controller.showThreads(command.search); break
      case 'new': await this.controller.createThread(command.title); break
      case 'open': await this.controller.openThread(command.threadId); break
      case 'rename': await this.controller.rename(command.title); break
      case 'archive': await this.controller.archive(); break
      case 'fork': await this.controller.fork(command.title); break
      case 'compact': await this.controller.compact(); break
      case 'connect': this.actions.onConnect(); break
      case 'model': this.actions.onModel(); break
      case 'variants': this.actions.onVariants(); break
      case 'reasoning':
        this.showReasoning = !this.showReasoning
        this.transcript.clearReasoningOverrides()
        this.transcript.update(this.state.projection, this.showReasoning, this.showToolDetails, this.controller.runtime.legacyGui === true)
        this.controller.notify(this.showReasoning
          ? 'Thinking is expanded.'
          : 'Thinking is collapsed.')
        break
      case 'mouse': this.actions.onPointerMode(command.action); break
      case 'status': await this.controller.showStatus(); break
      case 'copy': this.actions.onCopy(); break
      case 'export': this.actions.onExport(command.path); break
      case 'details':
        this.toggleToolDetails()
        break
      case 'permission': this.actions.onPermission(); break
      case 'undo': await this.controller.undoLastTurn(); break
      case 'redo': await this.controller.redoBranch(); break
      case 'init': await this.controller.initializeWorkspace(command.instructions); break
      case 'mcp': await this.controller.showMcp(); break
      case 'timeline': this.actions.onTimeline(command.query); break
      case 'jump': this.actions.onTimeline(undefined, command.target); break
      case 'subagents': this.actions.onSubagents(); break
      case 'tasks': await this.controller.showTasks(); break
      case 'plan': {
        const action = command.action?.trim().toLowerCase()
        if (action === 'plan' || action === 'on') await this.controller.setPlanMode('plan')
        else if (action === 'agent' || action === 'off' || action === 'build') await this.controller.setPlanMode('agent')
        else await this.controller.showPlan()
        break
      }
      case 'goal': await this.controller.manageGoal(command.action); break
      case 'skills': this.actions.onSkills(command.query); break
      case 'skill': await this.controller.invokeSkill(command.name, command.prompt); break
      case 'editor': {
        const initial = command.initial ?? ''
        this.editor.setText(initial)
        await this.openExternalEditor()
        break
      }
      case 'add-dir': await this.controller.addDirectory(command.path); break
      case 'btw': await this.controller.askSideQuestion(command.question); break
      case 'context': await this.controller.showContext(); break
      case 'queue': this.controller.showQueue(); break
      case 'quit': this.controller.requestQuit(); break
      case 'usage': this.controller.notify(`Usage: ${command.usage}`, 'error'); break
      case 'unknown': this.controller.notify(`Unknown command: /${command.name}`, 'error'); break
    }
  }
}

const KUN_REPLY_GROUP_PREFIX = 'kun-reply:'

function isKunReplyItem(item: TurnItem): boolean {
  return item.kind === 'assistant_text' ||
    item.kind === 'assistant_reasoning' ||
    item.kind === 'tool_call' ||
    item.kind === 'tool_result' ||
    item.kind === 'approval' ||
    item.kind === 'user_input' ||
    item.kind === 'review' ||
    item.kind === 'error'
}

export class TranscriptComponent implements Component {
  private order: string[] = []
  private readonly items = new Map<string, ItemComponent>()
  private readonly children = new Map<string, ChildRunComponent>()
  private readonly reasoningOverrides = new Map<string, boolean>()
  private showReasoning = false
  private projection?: ThreadProjection
  private renderedChildRows: Array<{ start: number; end: number; child: ProjectedChildRun }> = []
  private renderedReasoningRows: Array<{ row: number; itemId: string }> = []

  update(
    projection: ThreadProjection | undefined,
    showReasoning: boolean,
    showToolDetails: boolean,
    legacyGui = false
  ): void {
    this.projection = projection
    this.showReasoning = showReasoning
    const all = projection?.items ?? []
    const toolCalls = new Map(
      all.filter((item): item is Extract<TurnItem, { kind: 'tool_call' }> => item.kind === 'tool_call')
        .map((item) => [item.callId, item])
    )
    const toolResults = new Map(
      all.filter((item): item is Extract<TurnItem, { kind: 'tool_result' }> => item.kind === 'tool_result')
        .map((item) => [item.callId, item])
    )
    const visible = all.filter((item) => item.kind !== 'tool_result' || !toolCalls.has(item.callId))
    const nextIds = new Set(visible.map((item) => item.id))
    for (const id of this.items.keys()) if (!nextIds.has(id)) this.items.delete(id)
    for (const id of this.reasoningOverrides.keys()) if (!nextIds.has(id)) this.reasoningOverrides.delete(id)
    for (const item of visible) {
      const current = this.items.get(item.id)
      const result = item.kind === 'tool_call' ? toolResults.get(item.callId) : undefined
      const itemShowReasoning = item.kind === 'assistant_reasoning'
        ? this.reasoningOverrides.get(item.id) ?? showReasoning
        : showReasoning
      const turnRunning = projection?.runningTurnId === item.turnId
      const reasoningRunning = item.kind === 'assistant_reasoning' &&
        item.status === 'running' &&
        turnRunning &&
        projection?.activity?.turnId === item.turnId &&
        projection.activity.phase === 'thinking'
      const reasoningEndedAt = item.kind === 'assistant_reasoning' && !reasoningRunning
        ? resolveReasoningEndAt(item, all, projection)
        : undefined
      if (current?.kind === item.kind) {
        current.update(
          item,
          itemShowReasoning,
          showToolDetails,
          result,
          turnRunning,
          legacyGui,
          reasoningRunning,
          reasoningEndedAt
        )
      } else {
        this.items.set(item.id, new ItemComponent(
          item,
          itemShowReasoning,
          showToolDetails,
          result,
          turnRunning,
          legacyGui,
          reasoningRunning,
          reasoningEndedAt
        ))
      }
    }

    const childIds = new Set((projection?.childRuns ?? []).map((run) => `child:${run.childId}`))
    for (const id of this.children.keys()) if (!childIds.has(id)) this.children.delete(id)
    for (const child of projection?.childRuns ?? []) {
      const id = `child:${child.childId}`
      const current = this.children.get(id)
      if (current) current.update(child)
      else this.children.set(id, new ChildRunComponent(child))
    }

    const placedChildren = new Set<string>()
    const labeledTurns = new Set<string>()
    const order: string[] = []
    const addKunReplyLabel = (turnId: string): void => {
      if (labeledTurns.has(turnId)) return
      labeledTurns.add(turnId)
      order.push(`${KUN_REPLY_GROUP_PREFIX}${turnId}`)
    }
    for (const item of visible) {
      if (isKunReplyItem(item)) addKunReplyLabel(item.turnId)
      order.push(item.id)
      if (item.kind !== 'tool_call' || item.toolName !== 'delegate_task') continue
      const resultChildId = childIdFromToolResult(toolResults.get(item.callId))
      const label = typeof item.arguments.label === 'string' ? item.arguments.label.trim() : ''
      for (const child of projection?.childRuns ?? []) {
        if (child.parentTurnId !== item.turnId) continue
        if (child.childId !== resultChildId && (!label || child.label !== label)) continue
        const id = `child:${child.childId}`
        addKunReplyLabel(child.parentTurnId)
        order.push(id)
        placedChildren.add(id)
      }
    }
    for (const id of childIds) {
      if (placedChildren.has(id)) continue
      const child = this.children.get(id)?.value
      if (child) addKunReplyLabel(child.parentTurnId)
      order.push(id)
    }
    this.order = order
  }

  render(width: number, animationFrame = 0): string[] {
    const lines: string[] = []
    this.renderedChildRows = []
    this.renderedReasoningRows = []
    this.order.forEach((id, index) => {
      const replyGroup = id.startsWith(KUN_REPLY_GROUP_PREFIX)
      const rendered = replyGroup
        ? [cyan(bold(' Kun'))]
        : id.startsWith('child:')
          ? this.children.get(id)?.render(width, animationFrame) ?? []
          : this.items.get(id)?.render(width, animationFrame) ?? []
      const kind = replyGroup
        ? 'kun_reply'
        : id.startsWith('child:')
          ? 'child'
          : this.items.get(id)?.kind
      const compact = kind === 'child' || kind === 'assistant_text' ||
        kind === 'assistant_reasoning' || kind === 'tool_call' ||
        kind === 'tool_result' || kind === 'approval' ||
        kind === 'user_input' || kind === 'review' || kind === 'error' ||
        kind === 'compaction'
      if (index !== 0 && !compact) lines.push('')
      const start = lines.length
      lines.push(...rendered)
      if (kind === 'assistant_reasoning' && rendered.length) {
        this.renderedReasoningRows.push({ row: start, itemId: id })
      }
      if (id.startsWith('child:') && rendered.length) {
        const child = this.children.get(id)?.value
        if (child) this.renderedChildRows.push({ start, end: lines.length - 1, child })
      }
    })
    return lines
  }

  childAtRenderedRow(row: number): ProjectedChildRun | undefined {
    return this.renderedChildRows.find((entry) => row >= entry.start && row <= entry.end)?.child
  }

  reasoningAtRenderedRow(row: number): string | undefined {
    return this.renderedReasoningRows.find((entry) => row === entry.row)?.itemId
  }

  toggleReasoningAtRenderedRow(row: number): string | undefined {
    const itemId = this.reasoningAtRenderedRow(row)
    if (!itemId) return undefined
    const expanded = !(this.reasoningOverrides.get(itemId) ?? this.showReasoning)
    this.reasoningOverrides.set(itemId, expanded)
    this.items.get(itemId)?.setReasoningExpanded(expanded)
    return itemId
  }

  clearReasoningOverrides(): void {
    this.reasoningOverrides.clear()
  }

  invalidate(): void {
    for (const item of this.items.values()) item.invalidate()
  }
}

class ItemComponent implements Component {
  readonly kind: TurnItem['kind']
  private item: TurnItem
  private markdown?: Markdown
  private showReasoning: boolean
  private showToolDetails: boolean
  private toolResult?: Extract<TurnItem, { kind: 'tool_result' }>
  private turnRunning: boolean
  private legacyGui: boolean
  private reasoningRunning: boolean
  private reasoningEndedAt?: string

  constructor(
    item: TurnItem,
    showReasoning: boolean,
    showToolDetails: boolean,
    toolResult?: Extract<TurnItem, { kind: 'tool_result' }>,
    turnRunning = false,
    legacyGui = false,
    reasoningRunning = false,
    reasoningEndedAt?: string
  ) {
    this.kind = item.kind
    this.item = item
    this.showReasoning = showReasoning
    this.showToolDetails = showToolDetails
    this.toolResult = toolResult
    this.turnRunning = turnRunning
    this.legacyGui = legacyGui
    this.reasoningRunning = reasoningRunning
    this.reasoningEndedAt = reasoningEndedAt
    if (item.kind === 'assistant_text') {
      this.markdown = new Markdown(
        `${sanitizeTerminalText(item.text)}${turnRunning && item.status === 'running' ? ' ▍' : ''}`,
        2,
        0,
        markdownTheme
      )
    }
  }

  update(
    item: TurnItem,
    showReasoning: boolean,
    showToolDetails: boolean,
    toolResult?: Extract<TurnItem, { kind: 'tool_result' }>,
    turnRunning = false,
    legacyGui = false,
    reasoningRunning = false,
    reasoningEndedAt?: string
  ): void {
    this.item = item
    this.showReasoning = showReasoning
    this.showToolDetails = showToolDetails
    this.toolResult = toolResult
    this.turnRunning = turnRunning
    this.legacyGui = legacyGui
    this.reasoningRunning = reasoningRunning
    this.reasoningEndedAt = reasoningEndedAt
    if (item.kind === 'assistant_text') {
      this.markdown?.setText(`${sanitizeTerminalText(item.text)}${turnRunning && item.status === 'running' ? ' ▍' : ''}`)
    }
  }

  setReasoningExpanded(expanded: boolean): void {
    if (this.kind === 'assistant_reasoning') this.showReasoning = expanded
  }

  render(width: number, animationFrame = 0): string[] {
    const item = this.item
    const contentWidth = Math.max(8, width - 2)
    switch (item.kind) {
      case 'user_message': {
        const body = plainLines(item.displayText ?? item.text, Math.max(8, contentWidth - 2), 0)
        return [
          `${yellow(bold(' › You'))}${body[0] ? `  ${yellow(body[0])}` : ''}`,
          ...body.slice(1).map((line) => yellow(`   ${line}`))
        ]
      }
      case 'assistant_text': {
        const body = this.markdown?.render(contentWidth).map((line) => `   ${line}`) ?? []
        return body
      }
      case 'assistant_reasoning': {
        return renderKunThinking(item, contentWidth, {
          expanded: this.showReasoning,
          running: this.reasoningRunning,
          endedAt: this.reasoningEndedAt,
          animationFrame
        })
      }
      case 'tool_call': {
        const result = this.toolResult
        const running = !result && this.turnRunning && item.status !== 'failed' && item.status !== 'aborted'
        const failed = result?.isError || item.status === 'failed' || item.status === 'aborted'
        const icon = failed
          ? red('✗')
          : running
            ? cyan(activityFrame('tool', animationFrame))
            : green('●')
        const action = toolAction(item)
        const duration = elapsedDuration(item.createdAt, result?.finishedAt ?? item.finishedAt, running)
        const compactResult = result ? conciseToolResultSummary(result.output) : undefined
        const details = this.showToolDetails
          ? [
              ...toolTreeSection('input', outputText(item.arguments), contentWidth, 20, !result, dim),
              ...(result
                ? toolTreeSection('output', outputText(result.output), contentWidth, 40, true, result.isError ? red : dim)
                : [])
            ]
          : result?.isError
            ? toolTreeSection('', toolResultSummary(result.output), contentWidth, 4, true, red)
            : compactResult
              ? toolTreeSection('', compactResult, contentWidth, 1, true, dim)
              : []
        return [
          truncateToWidth(
            ` ${icon} ${bold(action.verb)}${action.subject ? ` ${dim(`· ${sanitizeTerminalText(action.subject)}`)}` : ''}${duration ? ` ${dim(`· ${duration}`)}` : ''}`,
            contentWidth
          ),
          ...details
        ]
      }
      case 'tool_result': {
        const output = outputText(item.output)
        return [
          ` ${item.isError ? red('✗') : green('●')} ${bold(humanizeToolName(item.toolName))}`,
          ...toolTreeSection(
            '',
            output,
            contentWidth,
            this.showToolDetails ? 50 : item.isError ? 5 : 2,
            true,
            item.isError ? red : dim
          )
        ]
      }
      case 'approval': return [` ${yellow('!')} Approval ${item.status}: ${sanitizeTerminalText(item.summary)}`]
      case 'user_input': return [` ${magenta('?')} Input ${item.status}: ${sanitizeTerminalText(item.prompt)}`]
      case 'compaction': return [` ${magenta('↺')} Compacted ${item.replacedTokens.toLocaleString()} tokens`]
      case 'review': return [magenta(' Review'), ...plainLines(item.reviewText ?? item.title, contentWidth, 2)]
      case 'error': {
        const warning = item.severity === 'warning' || item.status === 'aborted' || item.status === 'completed'
        const color = warning ? yellow : red
        const title = item.status === 'aborted'
          ? 'Stopped'
          : item.code === 'empty_turn'
            ? 'No response'
            : isModelConnectionError(item)
              ? 'Model connection failed'
              : 'Turn failed'
        return [
          color(` ✕ ${bold(title)}`),
          ...plainLines(friendlyRuntimeError(item.message), contentWidth, 3).slice(0, 8).map((line) => color(`   ${line}`)),
          ...(isModelConnectionError(item)
            ? [
                cyan('   Run /connect to refresh this provider.'),
                dim(this.legacyGui
                  ? '   Kun will update the protected store and active GUI runtime.'
                  : '   Or use /model to choose another model.')
              ]
            : [])
        ]
      }
    }
  }

  invalidate(): void { this.markdown?.invalidate() }
}

export function renderKunThinking(
  item: Extract<TurnItem, { kind: 'assistant_reasoning' }>,
  width: number,
  options: {
    expanded: boolean
    running: boolean
    endedAt?: string
    animationFrame?: number
  }
): string[] {
  const contentWidth = Math.max(8, width)
  const duration = itemDuration(item, options.running, options.endedAt)
  const title = options.running
    ? `${cyan(activityFrame('thinking', options.animationFrame ?? 0))} ${dim(italic('Thinking…'))} ${dim(`· ${duration}`)}`
    : `${dim('●')} ${dim(italic('Thinking'))} ${dim(duration ? `· ${duration}` : '')}`
  if (!options.expanded) {
    const rich = `   ${dim('▸')} ${title} ${dim('· collapsed · click or /thinking expand')}`
    const full = `   ${dim('▸')} ${title} ${dim('· collapsed · /thinking expand')}`
    const compact = `   ${dim('▸')} ${title} ${dim('· /thinking expand')}`
    const row = visibleWidth(rich) <= contentWidth
      ? rich
      : visibleWidth(full) <= contentWidth
        ? full
        : compact
    return [truncateToWidth(row, contentWidth)]
  }
  return [
    truncateToWidth(`   ${dim('▾')} ${title} ${dim('· click to collapse')}`, contentWidth),
    ...plainLines(item.text, Math.max(8, contentWidth - 7), 0)
      .map((line) => `${dim('     │')} ${dim(italic(line))}`)
  ]
}

class ChildRunComponent {
  constructor(private child: ProjectedChildRun) {}

  update(child: ProjectedChildRun): void { this.child = child }

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
    const metrics = [
      child.detached ? 'background' : undefined,
      child.toolInvocations !== undefined ? `${child.toolInvocations} tools` : undefined,
      child.durationMs !== undefined ? formatDurationMs(child.durationMs) : elapsedDuration(child.startedAt, undefined, active)
    ].filter(Boolean).join(' · ')
    return [
      `   ${icon} ${bold('Subagent')} · ${sanitizeTerminalText(label)}${dim(role)}${metrics ? ` ${dim(`· ${metrics}`)}` : ''}`,
      ...(child.text
        ? plainLines(child.text, Math.max(8, width - 5), 5).slice(0, failed ? 5 : 2).map((line) => `${failed ? red('     ') : dim('     ')}${failed ? red(line) : dim(line)}`)
        : active ? [dim(`     ${child.status === 'queued' ? 'Waiting for an execution slot…' : 'Working independently…'}`)] : []),
      dim('     Click to open · keyboard: /subagents')
    ]
  }
}

/**
 * Exclusive subagent browser and read-only child transcript. ChildRunExecutor
 * persists side threads with id === childId, so the route opens that
 * authoritative id and never guesses from a display label.
 */
class SubagentDialog implements Component, Focusable {
  private readonly input = new Input()
  private readonly transcript = new TranscriptComponent()
  private parentProjection: ThreadProjection
  private childProjection?: ThreadProjection
  private selectedChild?: ProjectedChildRun
  private index = 0
  private _focused = false
  private loading = false
  private error = ''
  private connection: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' = 'idle'
  private showReasoning = false
  private detailAbort?: AbortController
  private openGeneration = 0
  private detailOffset = 0
  private detailPageSize = 1
  private detailMaxOffset = 0
  private followDetailTail = true
  private detailPanelHeight = 0
  private transcriptPanelStartRow?: number

  constructor(
    private readonly tui: TUI,
    private readonly controller: TuiController,
    projection: ThreadProjection,
    private readonly close: () => void,
    private readonly detailOnly = false
  ) {
    this.parentProjection = projection
  }

  get focused(): boolean { return this._focused }
  set focused(value: boolean) { this._focused = value; this.input.focused = value && !this.selectedChild }

  updateParentProjection(projection: ThreadProjection | undefined): void {
    if (!projection || projection.thread.id !== this.parentProjection.thread.id) return
    this.parentProjection = projection
    if (this.selectedChild) {
      this.selectedChild = projection.childRuns.find((run) => run.childId === this.selectedChild?.childId) ??
        this.selectedChild
    }
    this.tui.requestRender()
  }

  dispose(): void {
    this.openGeneration += 1
    this.detailAbort?.abort()
    this.detailAbort = undefined
  }

  render(width: number): string[] {
    return this.selectedChild ? this.renderDetail(width) : this.renderList(width)
  }

  handleInput(data: string): void {
    const mouse = parseSgrMouseEvent(data)
    if (mouse) {
      this.handleMouse(mouse)
      return
    }
    if (this.selectedChild) {
      if (isCancelInput(data)) {
        if (this.detailOnly) this.close()
        else this.leaveDetail()
        return
      }
      if (data.toLowerCase() === 't') {
        this.showReasoning = !this.showReasoning
        this.transcript.clearReasoningOverrides()
        this.transcript.update(this.childProjection, this.showReasoning, false)
        this.tui.requestRender()
        return
      }
      if (matchesKey(data, 'up') || data.toLowerCase() === 'k') this.scrollDetail(-1)
      else if (matchesKey(data, 'down') || data.toLowerCase() === 'j') this.scrollDetail(1)
      else if (matchesKey(data, 'pageUp') || matchesKey(data, 'ctrl+u')) this.scrollDetail(-this.detailPageSize)
      else if (matchesKey(data, 'pageDown') || matchesKey(data, 'ctrl+d')) this.scrollDetail(this.detailPageSize)
      else if (matchesKey(data, 'home') || data === 'g') this.scrollDetailTo(0)
      else if (matchesKey(data, 'end') || data === 'G') this.scrollDetailTo(this.detailMaxOffset, true)
      return
    }
    if (isCancelInput(data)) {
      this.close()
      return
    }
    const children = this.children()
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) this.index = Math.max(0, this.index - 1)
    else if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) this.index = Math.min(Math.max(0, children.length - 1), this.index + 1)
    else if (matchesKey(data, 'pageUp')) this.index = Math.max(0, this.index - 10)
    else if (matchesKey(data, 'pageDown')) this.index = Math.min(Math.max(0, children.length - 1), this.index + 10)
    else if (matchesKey(data, 'home')) this.index = 0
    else if (matchesKey(data, 'end')) this.index = Math.max(0, children.length - 1)
    else if (matchesKey(data, 'enter') && children[this.index]) void this.openChild(children[this.index]!)
    else {
      this.input.handleInput(data)
      this.index = 0
    }
    this.tui.requestRender()
  }

  handleMouse(mouse: SgrMouseEvent): void {
    if (!mouse.pressed || !this.selectedChild) return
    if ((mouse.button & 64) !== 0) {
      this.scrollDetail((mouse.button & 1) === 0 ? -3 : 3)
      return
    }
    if ((mouse.button & 3) !== 0 || this.transcriptPanelStartRow === undefined) return
    const panelRow = this.panelRowAtTerminalRow(mouse.y)
    if (panelRow === undefined) return
    const transcriptRow = this.detailOffset + panelRow - this.transcriptPanelStartRow
    if (!this.transcript.toggleReasoningAtRenderedRow(transcriptRow)) return
    this.followDetailTail = false
    this.tui.requestRender()
  }

  invalidate(): void {
    this.input.invalidate()
    this.transcript.invalidate()
  }

  private children(): ProjectedChildRun[] {
    const query = this.input.getValue().trim().toLowerCase()
    const children = [...this.parentProjection.childRuns].reverse()
    return query
      ? children.filter((child) => [
          child.label,
          child.profile,
          child.model,
          child.prompt,
          child.text,
          child.childId
        ].filter(Boolean).join(' ').toLowerCase().includes(query))
      : children
  }

  private renderList(width: number): string[] {
    const inner = Math.max(16, width - 4)
    const children = this.children()
    this.index = Math.min(this.index, Math.max(0, children.length - 1))
    const active = children.filter((child) => child.status === 'queued' || child.status === 'running').length
    const rows = visibleWindow(children, this.index, 14).flatMap(({ value: child, index }) => {
      const selected = index === this.index
      const running = child.status === 'queued' || child.status === 'running'
      const icon = statusGlyph(
        running ? 'running' : child.status === 'completed' ? 'success' : 'failed'
      )
      const label = sanitizeTerminalText(child.label || child.profile || child.childId)
      const right = [
        child.model,
        child.detached ? 'background' : undefined,
        child.durationMs !== undefined ? formatDurationMs(child.durationMs) : elapsedDuration(child.startedAt, undefined, running)
      ].filter(Boolean).join(' · ')
      const line = selectionRow(`${icon} ${label}  ${dim(child.profile ?? '')}`, right, inner, selected)
      const summary = child.text || child.prompt
      return [
        line,
        ...(summary
          ? [`    ${dim(truncateToWidth(sanitizeTerminalText(summary).replace(/\s+/gu, ' '), Math.max(8, inner - 4)))}`]
          : [])
      ]
    })
    return pageFrame({
      path: ['KUN', 'Subagents'],
      right: `${active} active · ${children.length} total`,
      description: 'Delegated work from the current session.',
      body: [
        ` ${dim('Search')}  ${this.input.render(Math.max(10, inner - 10)).join(' ')}`,
        '',
        ...(rows.length ? rows : [` ${dim('No delegated child sessions in this conversation yet.')}`])
      ],
      footer: [
        { key: 'Enter', label: 'open transcript' },
        { key: 'PgUp/PgDn', label: 'navigate' },
        { key: 'Esc', label: 'back' }
      ],
      width
    })
  }

  private renderDetail(width: number): string[] {
    const child = this.selectedChild!
    const label = sanitizeTerminalText(child.label || child.profile || child.childId)
    const running = child.status === 'queued' || child.status === 'running'
    const statusKind = child.status === 'completed'
      ? 'success'
      : child.status === 'failed' || child.status === 'aborted'
        ? 'failed'
        : running
          ? 'running'
          : 'idle'
    const status = `${statusGlyph(statusKind)} ${sanitizeTerminalText(child.status)}`
    const transcriptLines: string[] = []
    if (this.loading) {
      transcriptLines.push(` ${statusGlyph('running', Math.floor(Date.now() / 200))} ${bold('Opening child transcript…')}`)
    } else if (this.error) {
      transcriptLines.push(` ${statusGlyph('failed')} ${red(sanitizeTerminalText(this.error))}`)
    } else if (this.childProjection) {
      transcriptLines.push(...this.transcript.render(Math.max(12, width - 4)))
      if (!this.childProjection.items.length) {
        transcriptLines.push(dim(' Waiting for the child session to emit output…'))
      }
    }
    this.detailPageSize = Math.max(3, Math.floor(this.tui.terminal.rows * 0.85) - 11)
    this.detailMaxOffset = Math.max(0, transcriptLines.length - this.detailPageSize)
    if (this.followDetailTail) this.detailOffset = this.detailMaxOffset
    else this.detailOffset = Math.min(this.detailOffset, this.detailMaxOffset)
    const visibleTranscript = transcriptLines.slice(
      this.detailOffset,
      this.detailOffset + this.detailPageSize
    )
    const scrollStatus = transcriptLines.length > this.detailPageSize
      ? `${this.detailOffset + 1}-${Math.min(transcriptLines.length, this.detailOffset + this.detailPageSize)}/${transcriptLines.length}`
      : `${transcriptLines.length} lines`
    const beforeTranscript = [
      ` ${dim('Parent')}  ${sanitizeTerminalText(this.parentProjection.thread.title || this.parentProjection.thread.id)}`,
      ` ${dim('Child')}   ${dim(child.childId)}${child.model ? `  ${dim('·')}  ${sanitizeTerminalText(child.model)}` : ''}`,
      ...(child.prompt
        ? [` ${dim('Task')}    ${truncateToWidth(sanitizeTerminalText(child.prompt).replace(/\s+/gu, ' '), Math.max(8, width - 14))}`]
        : []),
      sectionLabel('Transcript', Math.max(12, width - (this.detailOnly ? 4 : 0)))
    ]
    this.transcriptPanelStartRow = this.childProjection
      ? (this.detailOnly ? 1 : 3) + beforeTranscript.length
      : undefined
    const body = [
      ...beforeTranscript,
      ...visibleTranscript,
      joinSides(
        ` ${this.connection === 'connected' ? green('● live') : this.connection === 'reconnecting' ? yellow('● reconnecting') : dim(`● ${this.connection}`)}`,
        dim(scrollStatus),
        Math.max(12, width - 4)
      )
    ]
    const rendered = this.detailOnly
      ? popupFrame(`Subagent · ${label}`, [
          joinSides(status, dim('read-only'), Math.max(12, width - 4)),
          ...body,
          '',
          contextualFooter([
            { key: 'T', label: `${this.showReasoning ? 'collapse' : 'expand'} Thinking` },
            { key: '↑/↓', label: 'scroll' },
            { key: 'Esc', label: 'close' }
          ], Math.max(12, width - 4))
        ], width)
      : pageFrame({
          path: ['KUN', 'Subagents', label],
          right: `${status} · read-only`,
          body,
          footer: [
            { key: 'T', label: `${this.showReasoning ? 'collapse' : 'expand'} Thinking` },
            { key: '↑/↓', label: 'scroll' },
            { key: 'Esc', label: 'back to list' }
          ],
          width
        })
    this.detailPanelHeight = rendered.length
    return rendered
  }

  async open(child: ProjectedChildRun): Promise<void> {
    await this.openChild(child)
  }

  private async openChild(child: ProjectedChildRun): Promise<void> {
    this.dispose()
    const generation = this.openGeneration
    this.selectedChild = child
    this.childProjection = undefined
    this.loading = true
    this.error = ''
    this.connection = 'connecting'
    this.detailOffset = 0
    this.followDetailTail = true
    this.input.focused = false
    this.tui.requestRender()
    try {
      let detail: Awaited<ReturnType<KunTuiClient['getThread']>>
      let delegation: Awaited<ReturnType<KunTuiClient['delegationDiagnostics']>> | undefined
      for (;;) {
        try {
          const delegationRequest = typeof this.controller.client.delegationDiagnostics === 'function'
            ? this.controller.client.delegationDiagnostics(child.childId).catch(() => undefined)
            : Promise.resolve(undefined)
          ;[detail, delegation] = await Promise.all([
            this.controller.client.getThread(child.childId),
            delegationRequest
          ])
          break
        } catch (error) {
          if (generation !== this.openGeneration) return
          const current = this.selectedChild
          const pending = current?.status === 'queued' || current?.status === 'running'
          if (!pending || !(error instanceof TuiClientError) || (error.status !== 404 && error.status !== 410)) throw error
          // Child records are published before a queued executor receives a
          // slot and creates its side thread. Keep this route useful during
          // that window instead of flashing a false permanent failure.
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
      }
      if (generation !== this.openGeneration || this.selectedChild?.childId !== child.childId) return
      this.childProjection = hydrateProjectedChildRuns(projectThreadSnapshot(detail), delegation)
      this.transcript.update(this.childProjection, this.showReasoning, false)
      this.loading = false
      const abort = new AbortController()
      this.detailAbort = abort
      const subscription = this.controller.client.subscribeThreadEvents({
        threadId: child.childId,
        sinceSeq: this.childProjection.lastSeq,
        signal: abort.signal,
        onConnection: (connection) => {
          if (this.detailAbort !== abort) return
          this.connection = connection
          this.tui.requestRender()
        },
        onEvent: (event) => {
          if (this.detailAbort !== abort || !this.childProjection) return
          this.childProjection = applyRuntimeEvent(this.childProjection, event)
          this.transcript.update(this.childProjection, this.showReasoning, false)
          this.tui.requestRender()
        },
        onError: (error) => {
          if (this.detailAbort !== abort) return
          this.error = safeError(error)
          this.tui.requestRender()
        }
      })
      void subscription.catch((error) => {
        if (this.detailAbort !== abort || abort.signal.aborted) return
        this.error = safeError(error)
        this.connection = 'disconnected'
        this.tui.requestRender()
      })
    } catch (error) {
      if (generation !== this.openGeneration) return
      this.loading = false
      this.connection = 'disconnected'
      this.error = `Unable to open this child session: ${safeError(error)}`
      this.tui.requestRender()
    }
  }

  private leaveDetail(): void {
    this.dispose()
    this.selectedChild = undefined
    this.childProjection = undefined
    this.loading = false
    this.error = ''
    this.connection = 'idle'
    this.detailOffset = 0
    this.followDetailTail = true
    this.input.focused = this._focused
    this.tui.requestRender()
  }

  private scrollDetail(delta: number): void {
    this.scrollDetailTo(this.detailOffset + delta)
  }

  private scrollDetailTo(target: number, followTail = false): void {
    this.detailOffset = Math.max(0, Math.min(target, this.detailMaxOffset))
    this.followDetailTail = followTail || this.detailOffset >= this.detailMaxOffset
    this.tui.requestRender()
  }

  private panelRowAtTerminalRow(terminalRow: number): number | undefined {
    if (terminalRow < 1 || this.detailPanelHeight < 1) return undefined
    if (!this.detailOnly) {
      // Exclusive primary routes start on the terminal's first rendered row.
      return terminalRow - 1
    }
    // Mirror pi-tui's centered 85%-height overlay calculation so absolute SGR
    // coordinates map back to this popup's local rows.
    const terminalHeight = this.tui.terminal.rows
    const availableHeight = Math.max(1, terminalHeight - 2)
    const maxHeight = Math.max(1, Math.min(Math.floor(terminalHeight * 0.85), availableHeight))
    const effectiveHeight = Math.min(this.detailPanelHeight, maxHeight)
    const overlayTop = 1 + Math.floor((availableHeight - effectiveHeight) / 2)
    const panelRow = terminalRow - 1 - overlayTop
    return panelRow >= 0 && panelRow < effectiveHeight ? panelRow : undefined
  }
}

class CommandPaletteDialog implements Component, Focusable {
  private readonly input = new Input()
  private index = 0
  private _focused = false

  constructor(
    private readonly keymap: TuiKeymap,
    private readonly close: (entry?: TuiCommandDefinition) => void
  ) {}

  get focused(): boolean { return this._focused }
  set focused(value: boolean) { this._focused = value; this.input.focused = value }

  private entries(): readonly TuiCommandDefinition[] {
    const query = this.input.getValue().trim().toLowerCase()
    return TUI_COMMAND_DEFINITIONS.filter((entry) => entry.available && entry.slash && (
      !query || `${entry.title} ${entry.category} ${entry.id} ${entry.slash}`.toLowerCase().includes(query)
    ))
  }

  render(width: number): string[] {
    const inner = Math.max(12, width - 2)
    const entries = this.entries()
    this.index = Math.min(this.index, Math.max(0, entries.length - 1))
    const visible = entries.slice(Math.max(0, this.index - 6), Math.max(0, this.index - 6) + 13)
    const offset = Math.max(0, this.index - 6)
    const rows: string[] = []
    let category = ''
    visible.forEach((entry, visibleIndex) => {
      const selected = offset + visibleIndex === this.index
      const key = entry.keyAction ? this.keymap.display(entry.keyAction) : `/${entry.slash}`
      if (entry.category !== category) {
        category = entry.category
        rows.push(sectionLabel(category, inner))
      }
      rows.push(selectionRow(entry.title, key, inner, selected))
    })
    if (!rows.length) rows.push(dim(' No matching commands.'))
    return pageFrame({
      path: ['KUN', 'Commands'],
      description: 'Search actions by name, category, or slash command.',
      body: [
        ` ${dim('Search')}  ${this.input.render(Math.max(8, inner - 10)).join(' ')}`,
        '',
        ...rows
      ],
      footer: [
        { key: '↑/↓', label: 'choose' },
        { key: 'Enter', label: 'run' },
        { key: 'Esc', label: 'back' }
      ],
      width
    })
  }

  handleInput(data: string): void {
    const entries = this.entries()
    if (isCancelInput(data)) { this.close(); return }
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) this.index = Math.max(0, this.index - 1)
    else if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) this.index = Math.min(Math.max(0, entries.length - 1), this.index + 1)
    else if (matchesKey(data, 'pageUp')) this.index = Math.max(0, this.index - 10)
    else if (matchesKey(data, 'pageDown')) this.index = Math.min(Math.max(0, entries.length - 1), this.index + 10)
    else if (matchesKey(data, 'home')) this.index = 0
    else if (matchesKey(data, 'end')) this.index = Math.max(0, entries.length - 1)
    else if (matchesKey(data, 'enter')) this.close(entries[this.index])
    else { this.input.handleInput(data); this.index = 0 }
  }

  invalidate(): void { this.input.invalidate() }
}

class VariantDialog implements Component, Focusable {
  private index: number
  private _focused = false

  constructor(
    private readonly controller: TuiController,
    private readonly efforts: readonly ModelReasoningEffort[],
    private readonly close: () => void
  ) {
    this.index = Math.max(0, efforts.indexOf(controller.state.reasoningEffort ?? efforts[0]!))
  }

  get focused(): boolean { return this._focused }
  set focused(value: boolean) { this._focused = value }

  render(width: number): string[] {
    const current = this.controller.state.reasoningEffort
    const descriptions: Partial<Record<ModelReasoningEffort, string>> = {
      off: 'No extended reasoning',
      low: 'Faster, lighter reasoning',
      medium: 'Balanced speed and depth',
      high: 'Deeper reasoning',
      max: 'Maximum supported depth'
    }
    return pageFrame({
      path: ['KUN', 'Reasoning effort'],
      description: 'Choose a depth supported by the selected model.',
      body: this.efforts.map((effort, index) => {
        const selected = index === this.index
        const right = [descriptions[effort], effort === current ? 'current' : undefined].filter(Boolean).join(' · ')
        return selectionRow(effort, right, width - 2, selected)
      }),
      footer: [
        { key: '↑/↓', label: 'choose' },
        { key: 'Enter', label: 'select' },
        { key: 'Esc', label: 'back' }
      ],
      width
    })
  }

  handleInput(data: string): void {
    if (isCancelInput(data)) { this.close(); return }
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) this.index = Math.max(0, this.index - 1)
    else if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) this.index = Math.min(this.efforts.length - 1, this.index + 1)
    else if (matchesKey(data, 'home') || matchesKey(data, 'pageUp')) this.index = 0
    else if (matchesKey(data, 'end') || matchesKey(data, 'pageDown')) this.index = this.efforts.length - 1
    else if (matchesKey(data, 'enter')) {
      this.controller.selectReasoningEffort(this.efforts[this.index]!)
      this.close()
    }
  }

  invalidate(): void {}
}

class AgentModeDialog implements Component, Focusable {
  private readonly modes = ['agent', 'plan'] as const
  private index: number
  private _focused = false

  constructor(private readonly controller: TuiController, private readonly close: () => void) {
    const current = controller.state.projection?.thread.mode ?? controller.state.composerMode
    this.index = this.modes.indexOf(current)
  }

  get focused(): boolean { return this._focused }
  set focused(value: boolean) { this._focused = value }

  render(width: number): string[] {
    return pageFrame({
      path: ['KUN', 'Mode'],
      description: 'Choose how Kun approaches the next turn.',
      body: this.modes.map((mode, index) =>
        selectionRow(mode, mode === 'agent' ? 'Build and act' : 'Plan before acting', width - 2, index === this.index)
      ),
      footer: [
        { key: '↑/↓', label: 'choose' },
        { key: 'Enter', label: 'select' },
        { key: 'Esc', label: 'back' }
      ],
      width
    })
  }

  handleInput(data: string): void {
    if (isCancelInput(data)) { this.close(); return }
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) this.index = Math.max(0, this.index - 1)
    else if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) this.index = Math.min(this.modes.length - 1, this.index + 1)
    else if (matchesKey(data, 'home') || matchesKey(data, 'pageUp')) this.index = 0
    else if (matchesKey(data, 'end') || matchesKey(data, 'pageDown')) this.index = this.modes.length - 1
    else if (matchesKey(data, 'enter')) {
      void this.controller.setPlanMode(this.modes[this.index]!)
      this.close()
    }
  }

  invalidate(): void {}
}

class ThreadPickerDialog implements Component, Focusable {
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
      right: `${this.state.threads.length} saved`,
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

class HelpDialog implements Component, Focusable {
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
        '',
        sectionLabel('Terminal', width - 2),
        ` ${dim('Drag to select text; use the terminal copy shortcut.')}`,
        ` ${cyan(bold(this.keymap.display('pointer_mode_toggle')))} ${dim('Pointer mode for Thinking/Subagent clicks')}`,
        ` ${dim('Shift+PgUp/PgDn uses native scrollback. Ctrl+C acts as back in routes.')}`
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

class InspectionDialog implements Component, Focusable {
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

function inspectionDescription(title: string): string {
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

function renderInspectionLine(title: string, value: string, width: number): string[] {
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

function approvalPolicyDescription(value: ApprovalPolicy): string {
  switch (value) {
    case 'never': return 'Run supported actions without asking'
    case 'on-request': return 'Ask when the runtime marks an action sensitive'
    case 'untrusted': return 'Ask outside trusted actions'
    case 'always': return 'Ask before every tool action'
    case 'auto': return 'Let Kun choose from the active safety context'
    case 'suggest': return 'Ask when a tool suggests confirmation'
  }
}

class PermissionDialog implements Component, Focusable {
  private _focused = true
  private approvalIndex: number
  private sandboxIndex: number
  private saving = false
  private error = ''

  constructor(
    private readonly controller: TuiController,
    approvalPolicy: ApprovalPolicy,
    sandboxMode: SandboxMode,
    private readonly close: () => void
  ) {
    this.approvalIndex = Math.max(0, APPROVAL_POLICIES.indexOf(approvalPolicy))
    this.sandboxIndex = Math.max(0, SANDBOX_MODES.indexOf(sandboxMode))
  }

  get focused(): boolean { return this._focused }
  set focused(value: boolean) { this._focused = value }

  render(width: number): string[] {
    return pageFrame({
      path: ['KUN', 'Permissions'],
      description: 'Control approval prompts and workspace isolation for this session.',
      body: [
      sectionLabel('Approval policy', width - 2),
      ...APPROVAL_POLICIES.map((value, index) =>
        selectionRow(value, approvalPolicyDescription(value), width - 2, index === this.approvalIndex)
      ),
      '',
      sectionLabel('Sandbox mode', width - 2),
      SANDBOX_MODES.map((value, index) =>
        index === this.sandboxIndex ? cyan(bold(`[${value}]`)) : dim(value)
      ).join('  '),
      ...(this.error ? ['', red(this.error)] : [])
      ],
      footer: this.saving
        ? [{ key: statusGlyph('running'), label: 'saving' }]
        : [
            { key: '↑/↓', label: 'policy' },
            { key: '←/→', label: 'sandbox' },
            { key: 'Enter', label: 'save' },
            { key: 'Esc', label: 'cancel' }
          ],
      width
    })
  }

  handleInput(data: string): void {
    if (this.saving) return
    if (isCancelInput(data)) { this.close(); return }
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) this.approvalIndex = Math.max(0, this.approvalIndex - 1)
    else if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) this.approvalIndex = Math.min(APPROVAL_POLICIES.length - 1, this.approvalIndex + 1)
    else if (matchesKey(data, 'home') || matchesKey(data, 'pageUp')) this.approvalIndex = 0
    else if (matchesKey(data, 'end') || matchesKey(data, 'pageDown')) this.approvalIndex = APPROVAL_POLICIES.length - 1
    else if (matchesKey(data, 'left')) this.sandboxIndex = Math.max(0, this.sandboxIndex - 1)
    else if (matchesKey(data, 'right')) this.sandboxIndex = Math.min(SANDBOX_MODES.length - 1, this.sandboxIndex + 1)
    else if (matchesKey(data, 'enter')) void this.save()
  }

  invalidate(): void {}

  private async save(): Promise<void> {
    this.saving = true
    try {
      const saved = await this.controller.setPermissions(APPROVAL_POLICIES[this.approvalIndex]!, SANDBOX_MODES[this.sandboxIndex]!)
      if (saved) this.close()
      else this.saving = false
    } catch (error) {
      this.saving = false
      this.error = safeError(error)
    }
  }
}

type TimelineEntry = {
  turnId: string
  ordinal: number
  label: string
  preview: string[]
}

class TimelineDialog implements Component, Focusable {
  private _focused = true
  private index = 0
  private readonly entries: TimelineEntry[]

  constructor(
    private readonly controller: TuiController,
    projection: ThreadProjection,
    query: string | undefined,
    target: string | undefined,
    private readonly close: () => void
  ) {
    const needle = query?.trim().toLowerCase()
    this.entries = projection.thread.turns.flatMap((turn, turnIndex) => {
      const user = turn.items.find((item): item is Extract<TurnItem, { kind: 'user_message' }> => item.kind === 'user_message')
      const assistant = turn.items.filter((item): item is Extract<TurnItem, { kind: 'assistant_text' }> => item.kind === 'assistant_text')
      const text = [user?.displayText ?? user?.text ?? turn.prompt, ...assistant.map((item) => item.text)].join('\n')
      if (needle && !text.toLowerCase().includes(needle) && !turn.id.toLowerCase().includes(needle)) return []
      return [{
        turnId: turn.id,
        ordinal: turnIndex + 1,
        label: `${turnIndex + 1}. ${oneLine(user?.displayText ?? user?.text ?? turn.prompt)}`,
        preview: text.split('\n').filter(Boolean).map((line) => sanitizeTerminalText(line))
      }]
    })
    const numeric = Number(target)
    const selected = Number.isSafeInteger(numeric) && numeric > 0
      ? this.entries.findIndex((entry) => entry.ordinal === numeric)
      : target
        ? this.entries.findIndex((entry) => `${entry.turnId} ${entry.label}`.toLowerCase().includes(target.toLowerCase()))
        : -1
    if (selected >= 0) this.index = selected
  }

  get focused(): boolean { return this._focused }
  set focused(value: boolean) { this._focused = value }

  render(width: number): string[] {
    const selected = this.entries[this.index]
    const start = Math.max(0, this.index - 4)
    const visible = this.entries.slice(start, start + 9)
    return pageFrame({
      path: ['KUN', 'Timeline'],
      right: `${this.entries.length} turns`,
      body: [
      ...(visible.length
        ? visible.map((entry) =>
            selectionRow(
              truncateToWidth(entry.label, Math.max(10, width - 16)),
              entry === selected ? `turn ${entry.ordinal}` : '',
              width - 2,
              entry === selected
            )
          )
        : [dim('No matching turns.')]),
      '',
      ...(selected ? [bold(`Turn ${selected.ordinal} · ${sanitizeTerminalText(selected.turnId)}`), ...selected.preview.slice(0, 6).map(dim)] : []),
      ],
      footer: [
        { key: '↑/↓', label: 'choose' },
        { key: 'f', label: 'fork here' },
        { key: 'Esc', label: 'back' }
      ],
      width
    })
  }

  handleInput(data: string): void {
    if (isCancelInput(data)) { this.close(); return }
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) this.index = Math.max(0, this.index - 1)
    else if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) this.index = Math.min(Math.max(0, this.entries.length - 1), this.index + 1)
    else if (matchesKey(data, 'pageUp')) this.index = Math.max(0, this.index - 8)
    else if (matchesKey(data, 'pageDown')) this.index = Math.min(Math.max(0, this.entries.length - 1), this.index + 8)
    else if (matchesKey(data, 'home')) this.index = 0
    else if (matchesKey(data, 'end')) this.index = Math.max(0, this.entries.length - 1)
    else if (data.toLowerCase() === 'f' && this.entries[this.index]) {
      const entry = this.entries[this.index]!
      this.close()
      void this.controller.forkAtTurn(entry.turnId, `Fork at turn ${entry.ordinal}`)
    }
  }

  invalidate(): void {}
}

class SkillsDialog implements Component, Focusable {
  private _focused = true
  private index = 0
  private readonly entries: SkillsSnapshot['skills']

  constructor(
    private readonly controller: TuiController,
    private readonly snapshot: SkillsSnapshot,
    query: string | undefined,
    private readonly close: () => void
  ) {
    const needle = query?.trim().toLowerCase()
    this.entries = needle
      ? snapshot.skills.filter((skill) => `${skill.id} ${skill.name} ${skill.description ?? ''}`.toLowerCase().includes(needle))
      : snapshot.skills
  }

  get focused(): boolean { return this._focused }
  set focused(value: boolean) { this._focused = value }

  render(width: number): string[] {
    const selected = this.entries[this.index]
    const start = Math.max(0, this.index - 5)
    return pageFrame({
      path: ['KUN', 'Skills'],
      right: `${this.entries.length} visible · ${this.snapshot.enabled ? 'enabled' : 'disabled'}`,
      description: 'Workspace and user skills available to this session.',
      body: [
      ...this.entries.slice(start, start + 11).map((skill) =>
        selectionRow(
          sanitizeTerminalText(skill.id),
          `${skill.source}${skill.description ? ` · ${sanitizeTerminalText(skill.description)}` : ''}`,
          width - 2,
          skill === selected
        )),
      ...(this.snapshot.validationErrors.length
        ? ['', red(`${this.snapshot.validationErrors.length} skill validation error(s)`) ]
        : [])
      ],
      footer: [
        { key: '↑/↓', label: 'choose' },
        { key: 'Enter', label: 'invoke' },
        { key: 'Esc', label: 'back' }
      ],
      width
    })
  }

  handleInput(data: string): void {
    if (isCancelInput(data)) { this.close(); return }
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) this.index = Math.max(0, this.index - 1)
    else if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) this.index = Math.min(Math.max(0, this.entries.length - 1), this.index + 1)
    else if (matchesKey(data, 'pageUp')) this.index = Math.max(0, this.index - 10)
    else if (matchesKey(data, 'pageDown')) this.index = Math.min(Math.max(0, this.entries.length - 1), this.index + 10)
    else if (matchesKey(data, 'home')) this.index = 0
    else if (matchesKey(data, 'end')) this.index = Math.max(0, this.entries.length - 1)
    else if (matchesKey(data, 'enter') && this.entries[this.index]) {
      const skill = this.entries[this.index]!
      this.close()
      void this.controller.invokeSkill(skill.id)
    }
  }

  invalidate(): void {}
}

class ApprovalDialog implements Component, Focusable {
  private _focused = false
  constructor(
    private readonly controller: TuiController,
    private readonly toolName: string,
    private readonly summary: string
  ) {}
  get focused(): boolean { return this._focused }
  set focused(value: boolean) { this._focused = value }
  render(width: number): string[] {
    const workspace = this.controller.state.projection?.thread.workspace
    return pageFrame({
      path: ['KUN', 'Approval required'],
      right: 'Action required',
      description: 'Review the requested action before Kun continues.',
      body: [
        sectionLabel('Request', width - 2),
        ` ${dim('Tool')}       ${bold(sanitizeTerminalText(this.toolName))}`,
        ...(workspace ? [` ${dim('Workspace')}  ${sanitizeTerminalText(workspace)}`] : []),
        ` ${dim('Summary')}    ${sanitizeTerminalText(this.summary)}`,
        '',
        selectionRow('Allow once', 'run this action now', width - 2, true),
        selectionRow('Deny', 'block this action', width - 2, false)
      ],
      footer: [
        { key: 'y', label: 'allow once', tone: 'warning' },
        { key: 'n', label: 'deny', tone: 'danger' }
      ],
      width
    })
  }
  handleInput(data: string): void {
    if (data.toLowerCase() === 'y') void this.controller.decideApproval('allow')
    else if (data.toLowerCase() === 'n') void this.controller.decideApproval('deny')
  }
  invalidate(): void {}
}

class UserInputDialog implements Component, Focusable {
  private readonly editor: Editor
  private _focused = false

  constructor(
    tui: TUI,
    private readonly controller: TuiController,
    private session: UserInputSession
  ) {
    this.editor = new Editor(tui, editorTheme, { paddingX: 1 })
  }

  get focused(): boolean { return this._focused }
  set focused(value: boolean) { this._focused = value; this.editor.focused = value }

  render(width: number): string[] {
    const question = currentUserInputQuestion(this.session)
    const selected = selectedUserInputLabels(this.session)
    const options = question.options.map((option, index) => {
      const mark = question.selectionMode === 'multiple'
        ? (selected.has(option.label) ? '[x]' : '[ ]')
        : `${index + 1}.`
      return selectionRow(
        `${mark} ${sanitizeTerminalText(option.label)}`,
        option.description ? sanitizeTerminalText(option.description) : '',
        width - 2,
        index === this.session.optionIndex
      )
    })
    return pageFrame({
      path: ['KUN', 'Question', question.header],
      right: `Question ${this.session.questionIndex + 1} of ${this.session.questions.length}`,
      body: [
        ` ${bold(sanitizeTerminalText(question.question))}`,
        '',
        ...options,
        '',
        ...this.editor.render(Math.max(10, width - 2))
      ],
      footer: [
        { key: '↑/↓', label: 'choose' },
        ...(question.selectionMode === 'multiple' ? [{ key: 'Space', label: 'toggle' }] : []),
        { key: 'Enter', label: 'confirm' },
        { key: 'Esc', label: 'cancel' }
      ],
      width
    })
  }

  handleInput(data: string): void {
    const question = currentUserInputQuestion(this.session)
    if (isCancelInput(data)) { void this.controller.cancelUserInput(); return }
    if ((matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) && !this.editor.getText() && question.options.length) {
      this.session = moveUserInputOption(this.session, -1); return
    }
    if ((matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) && !this.editor.getText() && question.options.length) {
      this.session = moveUserInputOption(this.session, 1); return
    }
    if (matchesKey(data, 'space') && !this.editor.getText() && question.selectionMode === 'multiple') {
      this.session = toggleCurrentUserInputOption(this.session); return
    }
    if (matchesKey(data, 'enter')) {
      const text = this.editor.getExpandedText().trim()
      this.session = text
        ? answerCurrentUserInputWithText(this.session, text)
        : confirmCurrentUserInput(this.session)
      this.editor.setText('')
      if (isUserInputSessionComplete(this.session)) {
        void this.controller.resolveUserInput(orderedUserInputAnswers(this.session))
      }
      return
    }
    this.editor.handleInput(data)
  }

  invalidate(): void { this.editor.invalidate() }
}

type ConnectionPreset = {
  id: string
  presetSource?: string
  name: string
  category: 'Subscription' | 'API'
  kind: ProviderCatalogKind
  authFlow: ProviderCatalogAuthFlow
  authType: ProviderCatalogAuthType
  baseUrl?: string
  endpointFormat: 'chat_completions' | 'responses' | 'messages' | 'custom_endpoint'
  models: string[]
  docsUrl?: string
  credentialUrl?: string
}

const connectionPresets: ConnectionPreset[] = [
  {
    id: 'custom', name: 'Custom provider', category: 'API', kind: 'http',
    authFlow: 'api-key', authType: 'api-key',
    endpointFormat: 'chat_completions', models: []
  },
  ...providerCatalogEntries().map((entry): ConnectionPreset => ({
    id: entry.profileId,
    presetSource: entry.presetSource,
    name: entry.label,
    category: entry.category === 'subscription' ? 'Subscription' : 'API',
    kind: entry.kind,
    authFlow: entry.authFlow,
    authType: entry.authType,
    ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
    endpointFormat: entry.endpointFormat,
    models: [...entry.models],
    docsUrl: entry.docsUrl,
    credentialUrl: entry.credentialUrl
  }))
]

function connectionPresetForProfile(profile: ModelConnectionProfile): ConnectionPreset | undefined {
  const identities = [profile.presetSource, profile.id].filter((value): value is string => Boolean(value))
  const exact = connectionPresets.find((entry) => identities.includes(entry.id))
  if (exact) return exact
  return [...connectionPresets]
    .filter((entry) => entry.id !== 'custom')
    .sort((left, right) => right.id.length - left.id.length)
    .find((entry) => identities.some((identity) =>
      identity.startsWith(`${entry.id}-`) && /^\d+$/u.test(identity.slice(entry.id.length + 1))
    ))
}

const CONNECT_ENDPOINT_FORMATS = ['chat_completions', 'responses', 'messages', 'custom_endpoint'] as const

type ConnectField = 'id' | 'name' | 'baseUrl' | 'endpointFormat' | 'credential' | 'models'
type ManagementAction = {
  kind: 'rename' | 'credential' | 'probe' | 'disconnect' | 'back'
  label: string
}

function managementActions(profile: ModelConnectionProfile): ManagementAction[] {
  return [
    { kind: 'rename', label: 'Rename connection' },
    ...(profile.kind === 'http' || profile.kind === 'cursor-sdk'
      ? [{ kind: 'credential', label: 'Replace credential' }] satisfies ManagementAction[]
      : []),
    ...(profile.kind === 'http'
      ? [{ kind: 'probe', label: 'Probe connection and models' }] satisfies ManagementAction[]
      : []),
    { kind: 'disconnect', label: 'Disconnect and remove credential' },
    { kind: 'back', label: 'Back to connections' }
  ]
}

class ConnectDialog implements Component, Focusable {
  private readonly search = new Input()
  private _focused = true
  private connectionIndex = 0
  private catalogOpen = false
  private catalogIndex = 0
  private preset?: ConnectionPreset
  private management?: {
    profile: ModelConnectionProfile
    mode: 'menu' | 'rename' | 'credential' | 'confirm-delete'
    index: number
    connectAfterCredential?: boolean
  }
  private fields: ConnectField[] = []
  private fieldIndex = 0
  private value = ''
  private values: Partial<Record<ConnectField, string>> = {}
  private saving = false
  private error = ''
  private notice = ''
  private allowUnprobedSave = false
  private oauth?: ModelConnectionOAuthStatus
  private oauthCode = ''
  private bracketedPaste = false
  private claudeSdk?: ClaudeSdkInstallStatus
  private closed = false

  constructor(
    private readonly tui: TUI,
    private readonly controller: TuiController,
    private snapshot: ModelConnectionSnapshot,
    private readonly close: () => void
  ) {}

  get focused(): boolean { return this._focused }
  set focused(value: boolean) {
    this._focused = value
    this.search.focused = value && this.catalogOpen && !this.preset && !this.management
  }

  updateSnapshot(snapshot: ModelConnectionSnapshot): void {
    if (snapshot.revision <= this.snapshot.revision) return
    this.snapshot = snapshot
    this.connectionIndex = Math.min(this.connectionIndex, snapshot.providers.length)
    if (this.management) {
      const current = snapshot.providers.find((profile) =>
        profile.id === this.management?.profile.id && profile.accountId === this.management.profile.accountId
      )
      if (current) this.management.profile = current
      else {
        this.management = undefined
        this.notice = 'That connection was removed by another client. The list has been refreshed.'
      }
    }
    this.tui.requestRender()
  }

  render(width: number): string[] {
    if (this.management) return this.renderManagement(width)
    if (!this.preset) {
      return this.catalogOpen ? this.renderCatalog(width) : this.renderConnections(width)
    }
    if (this.oauth) {
      const grok = this.preset.authFlow === 'grok-oauth'
      const pending = this.oauth.status === 'pending'
      const body = [
        ` ${statusGlyph(pending ? 'running' : 'success', Math.floor(Date.now() / 200))} ` +
          `${bold(pending ? 'Waiting for browser authorization' : 'Connection authorized')}`,
        this.oauth.userCode ? ` ${dim('Device code')}  ${bold(sanitizeTerminalText(this.oauth.userCode))}` : '',
        this.oauth.url ? ` ${dim('Browser')}      ${cyan(sanitizeTerminalText(this.oauth.url))}` : '',
        this.oauth.message ? ` ${red(sanitizeTerminalText(this.oauth.message))}` : '',
        ...(grok && pending
          ? [
              '',
              ` ${bold('Return from the browser')}`,
              ` ${dim('Paste the authorization code or complete callback URL below.')}`,
              '',
              selectionRow(
                this.oauthCode
                  ? '•'.repeat(Math.min(48, Array.from(this.oauthCode).length))
                  : dim('authorization code or callback URL'),
                '',
                width,
                true
              )
            ]
          : [
              '',
              ` ${dim('Complete the sign-in in your browser, then return here.')}`
            ]),
        this.error ? ` ${red(this.error)}` : ''
      ].filter((line): line is string => Boolean(line))
      return pageFrame({
        path: ['KUN', 'Connect', this.preset.name],
        right: pending ? 'Authorizing' : 'Connected',
        description: grok && pending
          ? 'Grok returns an authorization value that must be pasted back into Kun.'
          : 'Credentials are stored by the shared runtime and are never printed.',
        body,
        footer: grok && pending
          ? [
              { key: 'Enter', label: this.saving ? 'exchanging…' : 'submit' },
              { key: 'Ctrl+R', label: 'refresh' },
              { key: 'Esc', label: 'cancel' }
            ]
          : [
              { key: 'Enter', label: 'refresh' },
              { key: 'Esc', label: 'cancel' }
            ],
        width
      })
    }
    if (this.claudeSdk) {
      const total = this.claudeSdk.totalBytes
      const progress = total > 0 ? Math.min(100, Math.round(this.claudeSdk.receivedBytes / total * 100)) : 0
      const installed = this.claudeSdk.installed
      return pageFrame({
        path: ['KUN', 'Connect', this.preset.name],
        right: installed ? 'Ready' : 'Installing',
        description: 'Claude Code is installed once by the shared runtime and reused by GUI and TUI.',
        body: [
          ` ${statusGlyph(installed ? 'success' : 'running', Math.floor(Date.now() / 200))} ` +
            `${bold(installed ? 'Claude Code is ready' : 'Downloading Claude Code')}`,
          this.claudeSdk.status === 'downloading'
            ? ` ${dim('Progress')}  ${formatBytes(this.claudeSdk.receivedBytes)} / ` +
              `${total ? formatBytes(total) : 'unknown'}${total ? ` · ${progress}%` : ''}`
            : '',
          this.claudeSdk.message ? ` ${red(sanitizeTerminalText(this.claudeSdk.message))}` : ''
        ].filter((line): line is string => Boolean(line)),
        footer: [{ key: 'Esc', label: 'close; download continues' }],
        width
      })
    }
    const field = this.fields[this.fieldIndex]
    const label = fieldLabel(field, this.preset)
    const display = field === 'credential'
      ? '•'.repeat(Math.min(48, Array.from(this.value).length))
      : sanitizeTerminalText(this.value)
    const step = this.fieldIndex + 1
    const body = [
      ` ${dim('Step')}  ${bold(`${step} of ${this.fields.length}`)}  ${dim(label)}`,
      '',
      selectionRow(
        display || dim(fieldPlaceholder(field)),
        field === 'endpointFormat' ? '←/→ choose' : '',
        width,
        true
      ),
      ...(field === 'credential' && this.preset.credentialUrl
        ? [
            '',
            ` ${dim('Need a credential?')} ${cyan('Ctrl+O')} ${dim('opens the provider page.')}`
          ]
        : []),
      this.notice ? ` ${green(this.notice)}` : '',
      this.error ? ` ${red(this.error)}` : '',
      this.allowUnprobedSave
        ? ` ${yellow('Probe failed. Ctrl+S saves these model IDs without marking the probe successful.')}`
        : '',
      this.saving
        ? ` ${statusGlyph('running', Math.floor(Date.now() / 200))} ${yellow('Probing and saving…')}`
        : ''
    ].filter((line): line is string => Boolean(line))
    return pageFrame({
      path: ['KUN', 'Connect', this.preset.name],
      right: `Step ${step}/${this.fields.length}`,
      description: field === 'credential'
        ? 'Secret input is masked and never written to terminal history or logs.'
        : 'Review one value at a time. Nothing is saved until verification succeeds.',
      body,
      footer: [
        { key: field === 'endpointFormat' ? '←/→' : 'Enter', label: field === 'endpointFormat' ? 'choose' : 'next' },
        ...(field === 'endpointFormat' ? [{ key: 'Enter', label: 'next' }] : []),
        { key: 'Ctrl+U', label: 'clear' },
        { key: 'Esc', label: 'previous' }
      ],
      width
    })
  }

  handleInput(data: string): void {
    if (this.management) {
      this.handleManagementInput(data)
      return
    }
    if (isCancelInput(data)) {
      this.navigateBack()
      return
    }
    if (this.saving) return
    if (this.oauth) {
      if (this.preset?.authFlow === 'grok-oauth' && this.oauth.status === 'pending') {
        if (matchesKey(data, 'backspace')) {
          this.oauthCode = Array.from(this.oauthCode).slice(0, -1).join('')
        } else if (matchesKey(data, 'ctrl+u')) {
          this.oauthCode = ''
        } else if (matchesKey(data, 'ctrl+r')) {
          void this.refreshOAuth()
          return
        } else if (matchesKey(data, 'enter')) {
          if (this.oauthCode.trim()) void this.submitOAuthCode()
          else void this.refreshOAuth()
          return
        } else {
          const text = this.textInput(data)
          if (text) this.oauthCode += text.replace(/[\r\n]/gu, '')
        }
        this.error = ''
        this.tui.requestRender()
      } else if (matchesKey(data, 'enter')) {
        void this.refreshOAuth()
      }
      return
    }
    if (!this.preset) {
      if (this.catalogOpen) this.handleCatalogInput(data)
      else this.handleConnectionListInput(data)
      return
    }
    if (this.allowUnprobedSave && matchesKey(data, 'ctrl+s')) {
      void this.saveConnection(false)
      return
    }
    const field = this.fields[this.fieldIndex]
    if (field === 'endpointFormat' && (
      matchesKey(data, 'left') ||
      matchesKey(data, 'right') ||
      matchesKey(data, 'up') ||
      matchesKey(data, 'down') ||
      matchesKey(data, 'tab')
    )) {
      const direction = matchesKey(data, 'left') || matchesKey(data, 'up') ? -1 : 1
      const current = Math.max(0, CONNECT_ENDPOINT_FORMATS.indexOf(endpointFormat(this.value)))
      this.value = CONNECT_ENDPOINT_FORMATS[
        (current + direction + CONNECT_ENDPOINT_FORMATS.length) % CONNECT_ENDPOINT_FORMATS.length
      ]!
      this.error = ''
      this.allowUnprobedSave = false
      this.tui.requestRender()
      return
    }
    if (field === 'endpointFormat') {
      if (matchesKey(data, 'enter')) void this.next()
      else if (matchesKey(data, 'ctrl+u')) {
        this.value = 'chat_completions'
        this.error = ''
        this.allowUnprobedSave = false
        this.tui.requestRender()
      }
      return
    }
    if (field === 'credential' && matchesKey(data, 'ctrl+o') && this.preset.credentialUrl) {
      openBrowser(this.preset.credentialUrl)
      this.notice = 'Opened the credential page in your browser.'
    } else if (matchesKey(data, 'backspace')) {
      this.value = Array.from(this.value).slice(0, -1).join('')
    } else if (matchesKey(data, 'ctrl+u')) {
      this.value = ''
    } else if (matchesKey(data, 'enter')) {
      void this.next()
      return
    } else {
      const text = this.textInput(data)
      if (text) this.value += text.replace(/[\r\n]/gu, '')
    }
    this.error = ''
    this.allowUnprobedSave = false
    this.tui.requestRender()
  }

  invalidate(): void { this.search.invalidate() }

  private renderConnections(width: number): string[] {
    const body = [
      sectionLabel('Connections', width, `${this.snapshot.providers.length} configured`),
      selectionRow(
        `${cyan('+')} ${bold('Add a provider')}`,
        'subscriptions or API',
        width,
        this.connectionIndex === 0
      )
    ]
    this.snapshot.providers.forEach((profile, index) => {
      const selected = this.connectionIndex === index + 1
      const defaultConnection = profile.id === this.snapshot.defaultProviderId &&
        profile.accountId === this.snapshot.defaultAccountId
      body.push(
        selectionRow(
          `${statusGlyph(profile.configured ? 'success' : 'warning')} ${sanitizeTerminalText(profile.name)}`,
          [
            profile.selectedModel ? sanitizeTerminalText(profile.selectedModel) : 'needs configuration',
            defaultConnection ? 'default' : ''
          ].filter(Boolean).join(' · '),
          width,
          selected
        )
      )
    })
    if (!this.snapshot.providers.length) body.push(` ${dim('No providers configured. Add one to start chatting.')}`)
    body.push(
      this.notice ? ` ${green(this.notice)}` : '',
      this.error ? ` ${red(this.error)}` : ''
    )
    return pageFrame({
      path: ['KUN', 'Connect'],
      right: this.snapshot.defaultModel ? `Default · ${this.snapshot.defaultModel}` : 'No default',
      description: 'Providers, accounts, credentials, and defaults are shared with the GUI and every TUI.',
      body: body.filter((line): line is string => Boolean(line)),
      footer: [
        { key: 'Enter', label: 'add or manage' },
        { key: '↑/↓', label: 'choose' },
        { key: 'Esc', label: 'back' }
      ],
      width
    })
  }

  private renderCatalog(width: number): string[] {
    const entries = this.catalogEntries()
    this.catalogIndex = Math.min(this.catalogIndex, Math.max(0, entries.length - 1))
    const body = [
      ` ${dim('Search')}  ${this.search.render(Math.max(12, width - 12)).join(' ')}`,
      '',
      ...(entries.some((entry) => entry.id === 'custom')
        ? [selectionRow(
            `${cyan('+')} ${bold('Custom provider')}`,
            'ID, URL, protocol, key, models',
            width,
            entries[this.catalogIndex]?.id === 'custom'
          )]
        : [])
    ]
    let category = ''
    visibleWindow(entries, this.catalogIndex, 14).forEach(({ value: preset, index }) => {
      if (preset.id === 'custom') return
      if (preset.category !== category) {
        category = preset.category
        body.push('', sectionLabel(category, width))
      }
      body.push(selectionRow(
        sanitizeTerminalText(preset.name),
        preset.models.length ? `${preset.models.length} model${preset.models.length === 1 ? '' : 's'}` : preset.authType,
        width,
        index === this.catalogIndex
      ))
    })
    if (!entries.length) body.push('', ` ${dim(`No providers match “${sanitizeTerminalText(this.search.getValue())}”.`)}`)
    body.push(
      entries.length > 14 ? ` ${dim(`${this.catalogIndex + 1}/${entries.length}`)}` : ''
    )
    const subscriptions = entries.filter((entry) => entry.category === 'Subscription').length
    const apis = entries.filter((entry) => entry.category === 'API' && entry.id !== 'custom').length
    return pageFrame({
      path: ['KUN', 'Connect', 'Add provider'],
      right: `${subscriptions} subscriptions · ${apis} APIs`,
      description: 'Choose the same built-in provider catalog available in GUI, or define a compatible endpoint.',
      body: body.filter((line): line is string => line !== ''),
      footer: [
        { key: 'Type', label: 'search' },
        { key: 'Enter', label: 'continue' },
        { key: 'Esc', label: 'back' }
      ],
      width
    })
  }

  private handleConnectionListInput(data: string): void {
    const maxIndex = this.snapshot.providers.length
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) {
      this.connectionIndex = Math.max(0, this.connectionIndex - 1)
    } else if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) {
      this.connectionIndex = Math.min(maxIndex, this.connectionIndex + 1)
    } else if (matchesKey(data, 'pageUp') || matchesKey(data, 'home')) {
      this.connectionIndex = 0
    } else if (matchesKey(data, 'pageDown') || matchesKey(data, 'end')) {
      this.connectionIndex = maxIndex
    } else if (matchesKey(data, 'enter')) {
      if (this.connectionIndex === 0) {
        this.catalogOpen = true
        this.catalogIndex = 0
        this.search.setValue('')
        this.search.focused = this._focused
      } else {
        const profile = this.snapshot.providers[this.connectionIndex - 1]
        const preset = profile ? connectionPresetForProfile(profile) : undefined
        if (profile?.configured) this.management = { profile, mode: 'menu', index: 0 }
        else if (
          preset &&
          (
            preset.authFlow === 'chatgpt-oauth' ||
            preset.authFlow === 'grok-oauth' ||
            preset.authFlow === 'claude-subscription' ||
            preset.authFlow === 'gemini-subscription'
          )
        ) {
          this.choosePreset(preset)
        } else if (profile?.kind === 'http') {
          this.management = {
            profile,
            mode: 'credential',
            index: 0,
            connectAfterCredential: true
          }
          this.value = ''
        } else if (profile) {
          if (preset) this.choosePreset(preset)
          else this.error = 'This subscription requires a current provider preset.'
        }
      }
    }
    this.tui.requestRender()
  }

  private handleCatalogInput(data: string): void {
    const entries = this.catalogEntries()
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) {
      this.catalogIndex = Math.max(0, this.catalogIndex - 1)
    } else if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) {
      this.catalogIndex = Math.min(Math.max(0, entries.length - 1), this.catalogIndex + 1)
    } else if (matchesKey(data, 'pageUp') || matchesKey(data, 'home')) {
      this.catalogIndex = 0
    } else if (matchesKey(data, 'pageDown') || matchesKey(data, 'end')) {
      this.catalogIndex = Math.max(0, entries.length - 1)
    } else if (matchesKey(data, 'enter')) {
      const preset = entries[this.catalogIndex]
      if (preset) this.choosePreset(preset)
    } else {
      this.search.handleInput(data)
      this.catalogIndex = 0
    }
    this.tui.requestRender()
  }

  private catalogEntries(): ConnectionPreset[] {
    const custom = connectionPresets.find((preset) => preset.id === 'custom')!
    const ordered = [custom, ...connectionPresets.filter((preset) => preset.id !== 'custom')]
    const query = this.search.getValue().trim().toLowerCase()
    return query
      ? ordered.filter((preset) => `${preset.name} ${preset.id} ${preset.category}`.toLowerCase().includes(query))
      : ordered
  }

  private navigateBack(): void {
    if (this.oauth?.status === 'pending') {
      void this.controller.client.cancelModelOAuth(this.oauth.sessionId)
      this.oauth = undefined
      this.resetPreset()
    } else if (this.claudeSdk) {
      this.closed = true
      this.clearSensitiveDraft()
      this.close()
      return
    } else if (this.preset) {
      if (this.fieldIndex > 0) {
        this.value = ''
        this.fieldIndex -= 1
        this.value = this.values[this.fields[this.fieldIndex]!] ?? ''
        this.error = ''
        this.allowUnprobedSave = false
      } else {
        this.resetPreset()
      }
    } else if (this.catalogOpen) {
      this.catalogOpen = false
      this.search.focused = false
      this.search.setValue('')
      this.catalogIndex = 0
    } else {
      this.closed = true
      this.clearSensitiveDraft()
      this.close()
      return
    }
    this.tui.requestRender()
  }

  private renderManagement(width: number): string[] {
    const management = this.management!
    const profile = management.profile
    if (management.mode === 'menu') {
      const actions = managementActions(profile)
      return pageFrame({
        path: ['KUN', 'Connect', profile.name],
        right: profile.configured ? 'Connected' : 'Needs configuration',
        description: [
          profile.selectedModel ? `Model ${profile.selectedModel}.` : 'No model selected.',
          this.snapshot.defaultProviderId === profile.id ? ' This is the shared default.' : ''
        ].join(''),
        body: [
          ...actions.map((action, index) => selectionRow(
            sanitizeTerminalText(action.label),
            action.kind === 'disconnect' ? 'removes protected credential' : '',
            width,
            index === management.index
          )),
          this.notice ? ` ${green(this.notice)}` : '',
          this.error ? ` ${red(this.error)}` : '',
          this.saving ? ` ${statusGlyph('running', Math.floor(Date.now() / 200))} ${yellow('Working…')}` : ''
        ].filter((line): line is string => Boolean(line)),
        footer: [
          { key: 'Enter', label: 'continue' },
          { key: '↑/↓', label: 'choose' },
          { key: 'Esc', label: 'back' }
        ],
        width
      })
    }
    if (management.mode === 'confirm-delete') {
      const fallback = this.snapshot.defaultProviderId === profile.id
        ? 'The next available connection becomes the shared default.'
        : 'Other clients will be notified immediately.'
      return pageFrame({
        path: ['KUN', 'Connect', profile.name, 'Disconnect'],
        right: 'Confirmation required',
        body: [
          ` ${red(bold('Remove this connection and its protected credential?'))}`,
          ` ${dim(fallback)}`,
          this.error ? ` ${red(this.error)}` : '',
          this.saving ? ` ${statusGlyph('running', Math.floor(Date.now() / 200))} ${yellow('Disconnecting…')}` : ''
        ].filter((line): line is string => Boolean(line)),
        footer: [
          { key: 'Y', label: 'disconnect', tone: 'danger' },
          { key: 'N / Esc', label: 'keep connection' }
        ],
        width
      })
    }
    const credential = management.mode === 'credential'
    return pageFrame({
      path: ['KUN', 'Connect', profile.name, credential ? 'Credential' : 'Rename'],
      description: credential
        ? 'The replacement secret is masked and committed atomically.'
        : 'This changes the account label shown in both GUI and TUI.',
      body: [
        ` ${dim(credential ? 'New API key / token plan key' : 'New connection name')}`,
        '',
        selectionRow(
          credential
            ? ('•'.repeat(Math.min(48, Array.from(this.value).length)) || dim('secret value'))
            : (sanitizeTerminalText(this.value) || dim('connection name')),
          '',
          width,
          true
        ),
        this.error ? ` ${red(this.error)}` : '',
        this.saving ? ` ${statusGlyph('running', Math.floor(Date.now() / 200))} ${yellow('Saving…')}` : ''
      ].filter((line): line is string => Boolean(line)),
      footer: [
        { key: 'Enter', label: 'save' },
        { key: 'Ctrl+U', label: 'clear' },
        { key: 'Esc', label: 'cancel' }
      ],
      width
    })
  }

  private handleManagementInput(data: string): void {
    const management = this.management!
    if (this.saving) return
    if (isCancelInput(data)) {
      if (management.mode === 'menu') this.management = undefined
      else {
        management.mode = 'menu'
        this.value = ''
        this.error = ''
      }
      this.tui.requestRender()
      return
    }
    if (management.mode === 'menu') {
      const actions = managementActions(management.profile)
      if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) management.index = Math.max(0, management.index - 1)
      else if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) management.index = Math.min(actions.length - 1, management.index + 1)
      else if (matchesKey(data, 'home') || matchesKey(data, 'pageUp')) management.index = 0
      else if (matchesKey(data, 'end') || matchesKey(data, 'pageDown')) management.index = actions.length - 1
      else if (matchesKey(data, 'enter')) void this.beginManagementAction(actions[management.index]!.kind)
      this.tui.requestRender()
      return
    }
    if (management.mode === 'confirm-delete') {
      if (data.toLowerCase() === 'y') void this.disconnectManagedConnection()
      else if (data.toLowerCase() === 'n') management.mode = 'menu'
      this.tui.requestRender()
      return
    }
    if (matchesKey(data, 'backspace')) this.value = Array.from(this.value).slice(0, -1).join('')
    else if (matchesKey(data, 'ctrl+u')) this.value = ''
    else if (matchesKey(data, 'enter')) void this.commitManagementInput()
    else {
      const text = this.textInput(data)
      if (text) this.value += text.replace(/[\r\n]/gu, '')
    }
    this.error = ''
    this.notice = ''
    this.tui.requestRender()
  }

  private async beginManagementAction(action: ManagementAction['kind']): Promise<void> {
    const management = this.management
    if (!management) return
    this.error = ''
    this.notice = ''
    if (action === 'back') {
      this.management = undefined
    } else if (action === 'rename') {
      management.mode = 'rename'
      this.value = management.profile.name
    } else if (action === 'credential') {
      management.mode = 'credential'
      this.value = ''
    } else if (action === 'disconnect') {
      management.mode = 'confirm-delete'
    } else {
      this.saving = true
      try {
        const result = await this.controller.client.probeModel(management.profile.id)
        this.notice = `Connection OK · ${result.models.length} model${result.models.length === 1 ? '' : 's'}`
      } catch (error) {
        this.error = safeError(error)
      } finally {
        this.saving = false
      }
    }
    this.tui.requestRender()
  }

  private async commitManagementInput(): Promise<void> {
    const management = this.management
    if (!management || (management.mode !== 'rename' && management.mode !== 'credential')) return
    const mode = management.mode
    const value = this.value.trim()
    if (!value) {
      this.error = management.mode === 'credential' ? 'Credential is required.' : 'Connection name is required.'
      this.tui.requestRender()
      return
    }
    this.saving = true
    try {
      if (mode === 'credential') {
        this.snapshot = await this.controller.client.replaceModelCredential(management.profile.id, {
          expectedRevision: this.snapshot.revision,
          credential: value
        })
      } else {
        this.snapshot = await this.controller.client.patchModel(management.profile.id, {
          expectedRevision: this.snapshot.revision,
          name: value
        })
      }
      if (mode === 'credential' && management.connectAfterCredential) {
        const connected = this.snapshot.providers.find((profile) => profile.id === management.profile.id)
        const model = connected?.selectedModel ?? connected?.models[0]
        if (connected && model) {
          this.snapshot = await this.controller.client.selectModel({
            expectedRevision: this.snapshot.revision,
            providerId: connected.id,
            accountId: connected.accountId,
            model
          })
        }
      }
      const updated = this.snapshot.providers.find((profile) => profile.id === management.profile.id)
      if (updated) management.profile = updated
      management.mode = 'menu'
      this.value = ''
      this.notice = mode === 'credential' ? 'Credential replaced.' : 'Connection updated.'
      this.controller.applyModelSelection(this.snapshot)
    } catch (error) {
      this.error = await this.mutationError(error)
    } finally {
      this.value = ''
      this.saving = false
      this.tui.requestRender()
    }
  }

  private async disconnectManagedConnection(): Promise<void> {
    const management = this.management
    if (!management) return
    this.saving = true
    this.error = ''
    try {
      this.snapshot = await this.controller.client.deleteModel(
        management.profile.id,
        this.snapshot.revision
      )
      this.management = undefined
      this.connectionIndex = Math.min(this.connectionIndex, this.snapshot.providers.length)
      this.controller.applyModelSelection(this.snapshot)
    } catch (error) {
      this.error = await this.mutationError(error)
    } finally {
      this.saving = false
      this.tui.requestRender()
    }
  }

  private choosePreset(preset: ConnectionPreset): void {
    this.preset = preset
    this.search.focused = false
    this.error = ''
    this.notice = ''
    this.allowUnprobedSave = false
    if (preset.authFlow === 'claude-subscription') {
      void this.beginClaude(preset)
      return
    }
    if (preset.authFlow === 'chatgpt-oauth' || preset.authFlow === 'grok-oauth') {
      void this.beginOAuth(preset)
      return
    }
    const customId = preset.id === 'custom' ? this.suggestCustomProviderId() : undefined
    this.fields = [
      ...(preset.id === 'custom' ? ['id', 'name', 'baseUrl', 'endpointFormat'] as ConnectField[] : []),
      ...(preset.kind === 'http' || preset.kind === 'cursor-sdk'
        ? ['credential'] as ConnectField[]
        : []),
      'models'
    ]
    this.values = {
      id: customId,
      name: preset.id === 'custom'
        ? `Custom provider ${this.snapshot.providers.length + 1}`
        : preset.name,
      baseUrl: preset.baseUrl ?? (preset.id === 'custom' ? 'https://api.example.com/v1' : undefined),
      endpointFormat: preset.endpointFormat,
      models: preset.models.join(', ')
    }
    this.fieldIndex = 0
    this.value = this.values[this.fields[0]!] ?? ''
  }

  private async beginClaude(preset: ConnectionPreset): Promise<void> {
    this.saving = true
    this.error = ''
    this.tui.requestRender()
    try {
      this.claudeSdk = await this.controller.client.claudeSdkStatus()
      if (!this.claudeSdk.installed) this.claudeSdk = await this.controller.client.installClaudeSdk()
      this.tui.requestRender()
      while (!this.closed && !this.claudeSdk.installed && this.claudeSdk.status === 'downloading') {
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        this.claudeSdk = await this.controller.client.claudeSdkStatus()
        this.tui.requestRender()
      }
      if (this.closed) return
      if (!this.claudeSdk.installed) throw new Error(this.claudeSdk.message || 'Claude Code installation failed')
      this.claudeSdk = undefined
      this.oauth = await this.controller.client.startModelOAuth({
        expectedRevision: this.snapshot.revision,
        provider: 'claude',
        model: preset.models[0],
        select: true
      })
      this.saving = false
      this.tui.requestRender()
      void this.pollOAuth()
    } catch (error) {
      this.saving = false
      this.error = await this.mutationError(error)
      this.claudeSdk = this.claudeSdk?.status === 'error' ? this.claudeSdk : undefined
      this.tui.requestRender()
    }
  }

  private async beginOAuth(preset: ConnectionPreset): Promise<void> {
    this.saving = true
    this.error = ''
    this.tui.requestRender()
    try {
      this.oauth = await this.controller.client.startModelOAuth({
        expectedRevision: this.snapshot.revision,
        provider: preset.authFlow === 'chatgpt-oauth' ? 'chatgpt' : 'grok',
        model: preset.models[0],
        select: true
      })
      this.saving = false
      if (this.oauth.url) openBrowser(this.oauth.url)
      this.tui.requestRender()
      void this.pollOAuth()
    } catch (error) {
      this.saving = false
      this.error = await this.mutationError(error)
      this.tui.requestRender()
    }
  }

  private async refreshOAuth(): Promise<void> {
    if (!this.oauth || this.oauth.status !== 'pending') return
    try {
      this.oauth = await this.controller.client.modelOAuthStatus(this.oauth.sessionId)
      this.finishOAuthIfConnected()
    } catch (error) {
      this.error = safeError(error)
    }
    this.tui.requestRender()
  }

  private async submitOAuthCode(): Promise<void> {
    if (!this.oauth || this.oauth.provider !== 'grok' || this.oauth.status !== 'pending') return
    const sessionId = this.oauth.sessionId
    const code = this.oauthCode.trim()
    if (!code) return
    this.oauthCode = ''
    this.saving = true
    this.error = ''
    this.tui.requestRender()
    try {
      this.oauth = await this.controller.client.submitModelOAuth(sessionId, code)
      this.finishOAuthIfConnected()
    } catch (error) {
      this.error = redactExactSecret(safeError(error), code)
    } finally {
      this.saving = false
      this.tui.requestRender()
    }
  }

  private finishOAuthIfConnected(): void {
    if (this.oauth?.status !== 'connected' || !this.oauth.snapshot) return
    this.snapshot = this.oauth.snapshot
    this.controller.applyModelSelection(this.snapshot)
    this.oauthCode = ''
    this.closed = true
    this.close()
  }

  private async pollOAuth(): Promise<void> {
    while (!this.closed && this.oauth?.status === 'pending') {
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, this.oauth?.interval ?? 2) * 1000))
      if (this.closed) return
      await this.refreshOAuth()
    }
  }

  private async next(): Promise<void> {
    const field = this.fields[this.fieldIndex]!
    const trimmed = this.value.trim()
    if (field !== 'credential' && !trimmed) {
      this.error = `${fieldLabel(field, this.preset!)} is required.`
      this.tui.requestRender()
      return
    }
    if (field === 'id') {
      const normalized = normalizeConnectionProviderId(trimmed)
      if (!normalized) {
        this.error = 'Provider ID must contain letters, numbers, dots, underscores, or dashes.'
        this.tui.requestRender()
        return
      }
      if (this.snapshot.providers.some((profile) => profile.id === normalized)) {
        this.error = `Provider ID “${normalized}” already exists. Choose a unique ID.`
        this.tui.requestRender()
        return
      }
      this.value = normalized
    }
    if (field === 'baseUrl') {
      try {
        const url = new URL(trimmed)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol')
      } catch {
        this.error = 'Base URL must be a valid HTTP or HTTPS URL.'
        this.tui.requestRender()
        return
      }
    }
    if (
      field === 'credential' &&
      !trimmed &&
      (this.preset!.kind === 'http' || this.preset!.kind === 'cursor-sdk')
    ) {
      this.error = 'Credential is required and is never echoed or logged.'
      this.tui.requestRender()
      return
    }
    this.values[field] = this.value.trim()
    if (this.fieldIndex < this.fields.length - 1) {
      this.fieldIndex += 1
      this.value = this.values[this.fields[this.fieldIndex]!] ?? ''
      this.allowUnprobedSave = false
      this.tui.requestRender()
      return
    }
    await this.saveConnection(true)
  }

  private async saveConnection(probe: boolean): Promise<void> {
    const preset = this.preset
    if (!preset) return
    this.saving = true
    this.error = ''
    this.allowUnprobedSave = false
    this.tui.requestRender()
    try {
      const models = (this.values.models ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
      const snapshot = await this.controller.client.connectModel({
        expectedRevision: this.snapshot.revision,
        ...(preset.id !== 'custom'
          ? { id: preset.id, presetSource: preset.presetSource ?? preset.id }
          : this.values.id ? { id: normalizeConnectionProviderId(this.values.id) } : {}),
        name: this.values.name ?? preset.name,
        kind: preset.kind,
        authType: preset.authType,
        ...(this.values.baseUrl ? { baseUrl: this.values.baseUrl } : {}),
        endpointFormat: endpointFormat(this.values.endpointFormat),
        ...(this.values.credential ? { credential: this.values.credential } : {}),
        models,
        ...(models[0] ? { selectedModel: models[0] } : {}),
        probe: preset.kind === 'http' && probe,
        select: true
      })
      this.snapshot = snapshot
      this.controller.applyModelSelection(snapshot)
      this.clearSensitiveDraft()
      this.closed = true
      this.close()
    } catch (error) {
      this.saving = false
      const message = await this.mutationError(error)
      const models = (this.values.models ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
      this.allowUnprobedSave = probe && preset.kind === 'http' && models.length > 0 && isModelProbeFailure(error)
      this.error = this.allowUnprobedSave
        ? `${message} Review the endpoint, or press Ctrl+S to save the supplied models without probing.`
        : message
      this.tui.requestRender()
    }
  }

  private suggestCustomProviderId(): string {
    const used = new Set(this.snapshot.providers.map((profile) => profile.id))
    let index = this.snapshot.providers.length + 1
    let id = `custom-provider-${index}`
    while (used.has(id)) {
      index += 1
      id = `custom-provider-${index}`
    }
    return id
  }

  private resetPreset(): void {
    this.clearSensitiveDraft()
    this.preset = undefined
    this.oauth = undefined
    this.oauthCode = ''
    this.claudeSdk = undefined
    this.fields = []
    this.fieldIndex = 0
    this.error = ''
    this.notice = ''
    this.allowUnprobedSave = false
    this.catalogOpen = true
    this.search.focused = this._focused
  }

  private clearSensitiveDraft(): void {
    if (this.values.credential) this.values.credential = ''
    this.values = {}
    this.value = ''
    this.oauthCode = ''
    this.bracketedPaste = false
  }

  private textInput(data: string): string | undefined {
    const start = '\x1b[200~'
    const end = '\x1b[201~'
    let text = data
    let pasted = this.bracketedPaste
    const startIndex = text.indexOf(start)
    if (startIndex >= 0) {
      pasted = true
      this.bracketedPaste = true
      text = text.slice(startIndex + start.length)
    }
    const endIndex = text.indexOf(end)
    if (endIndex >= 0) {
      pasted = true
      this.bracketedPaste = false
      text = text.slice(0, endIndex)
    }
    return pasted ? stripTerminalControls(text) : printableInput(data)
  }

  private async mutationError(error: unknown): Promise<string> {
    if (!(error instanceof TuiClientError) || error.status !== 409) return safeError(error)
    try {
      const snapshot = await this.controller.client.modelConnections()
      this.updateSnapshot(snapshot)
      this.controller.applyModelSelection(snapshot, false)
      return 'Connections changed in another client. The latest list is loaded; review and retry.'
    } catch (refreshError) {
      return safeError(refreshError)
    }
  }
}

class ModelDialog implements Component, Focusable {
  private readonly input = new Input()
  private _focused = false
  private index = 0
  private saving = false
  private error = ''
  private mode: 'models' | 'providers' = 'models'
  private providerFilter?: string
  private allEntries: Array<{
    providerId: string
    accountId: string
    model: string
    label: string
    configured: boolean
  }> = []

  constructor(
    private readonly tui: TUI,
    private readonly controller: TuiController,
    private readonly keymap: TuiKeymap,
    private snapshot: ModelConnectionSnapshot,
    private readonly close: () => void
  ) {
    this.rebuildEntries()
  }

  get focused(): boolean { return this._focused }
  set focused(value: boolean) { this._focused = value; this.input.focused = value }

  updateSnapshot(snapshot: ModelConnectionSnapshot): void {
    if (snapshot.revision <= this.snapshot.revision) return
    const selected = this.entries()[this.index]
    this.snapshot = snapshot
    this.rebuildEntries(selected)
    if (this.providerFilter && !snapshot.providers.some((profile) =>
      `${profile.id}\0${profile.accountId}` === this.providerFilter
    )) {
      this.providerFilter = undefined
      this.mode = 'models'
    }
    this.error = ''
    this.tui.requestRender()
  }

  private rebuildEntries(preferred?: { providerId: string; accountId: string; model: string }): void {
    const entries = new Map<string, {
      providerId: string
      accountId: string
      model: string
      label: string
      configured: boolean
    }>()
    for (const provider of this.snapshot.providers) {
      const models = new Set(provider.models)
      if (provider.selectedModel) models.add(provider.selectedModel)
      if (provider.id === this.snapshot.defaultProviderId && this.snapshot.defaultModel) models.add(this.snapshot.defaultModel)
      for (const model of models) {
        const key = `${provider.id}\0${provider.accountId}\0${model}`
        entries.set(key, {
          providerId: provider.id,
          accountId: provider.accountId,
          model,
          label: `${provider.name} · ${model}`,
          configured: provider.configured
        })
      }
    }
    this.allEntries = [...entries.values()]
      .sort((a, b) => Number(this.controller.isModelFavorite(b.providerId, b.accountId, b.model)) - Number(this.controller.isModelFavorite(a.providerId, a.accountId, a.model)))
    const target = preferred ?? {
      providerId: this.snapshot.defaultProviderId ?? '',
      accountId: this.snapshot.defaultAccountId ?? '',
      model: this.snapshot.defaultModel ?? ''
    }
    const selected = this.allEntries.findIndex((entry) =>
      entry.providerId === target.providerId &&
      entry.accountId === target.accountId &&
      entry.model === target.model
    )
    this.index = Math.max(0, selected)
  }

  private entries(): Array<{
    providerId: string
    accountId: string
    model: string
    label: string
    configured: boolean
  }> {
    const query = this.input.getValue().trim().toLowerCase()
    const entries = this.providerFilter
      ? this.allEntries.filter((entry) => `${entry.providerId}\0${entry.accountId}` === this.providerFilter)
      : this.allEntries
    return query
      ? entries.filter((entry) => `${entry.label} ${entry.providerId} ${entry.accountId}`.toLowerCase().includes(query))
      : entries
  }

  private providers(): ModelConnectionProfile[] {
    const query = this.input.getValue().trim().toLowerCase()
    return this.snapshot.providers.filter((provider) => {
      if (!provider.models.length && !provider.selectedModel) return false
      return !query || `${provider.name} ${provider.id} ${provider.accountId}`.toLowerCase().includes(query)
    })
  }

  render(width: number): string[] {
    const inner = Math.max(16, width - 2)
    const title = this.mode === 'providers' ? 'Providers & accounts' : 'Models'
    const current = this.snapshot.defaultProviderId && this.snapshot.defaultModel
      ? `${this.snapshot.defaultProviderId} / ${this.snapshot.defaultModel}`
      : 'not selected'
    const lead = [
      ` ${dim('Search')}  ${this.input.render(Math.max(10, inner - 10)).join(' ')}`,
      ''
    ]
    if (this.mode === 'providers') {
      const providers = this.providers()
      this.index = Math.min(this.index, Math.max(0, providers.length - 1))
      const rows = visibleWindow(providers, this.index, 14).map(({ value: provider, index }) => {
        const selected = index === this.index
        const count = new Set([...provider.models, ...(provider.selectedModel ? [provider.selectedModel] : [])]).size
        return selectionRow(
          `${statusGlyph(provider.configured ? 'success' : 'warning')} ${sanitizeTerminalText(provider.name)}  ${dim(provider.accountId)}`,
          `${count} model${count === 1 ? '' : 's'}${provider.configured ? '' : ' · connect'}`,
          inner,
          selected
        )
      })
      return pageFrame({
        path: ['KUN', title],
        right: `Current · ${sanitizeTerminalText(current)}`,
        description: 'Choose an account to filter the shared model catalog.',
        body: [
          ...lead,
          ...(rows.length ? rows : [` ${dim('No providers with model catalogs. Run /connect first.')}`])
        ],
        footer: [
          { key: 'Enter', label: 'open' },
          { key: this.keymap.display('model_provider_list'), label: 'all models' },
          { key: 'Esc', label: 'back' }
        ],
        width
      })
    }
    const entries = this.entries()
    this.index = Math.min(this.index, Math.max(0, entries.length - 1))
    const rows: string[] = []
    let group = ''
    visibleWindow(entries, this.index, 14).forEach(({ value: entry, index }) => {
      const selected = index === this.index
      const active = entry.providerId === this.snapshot.defaultProviderId &&
        entry.accountId === this.snapshot.defaultAccountId &&
        entry.model === this.snapshot.defaultModel
      const favorite = this.controller.isModelFavorite(entry.providerId, entry.accountId, entry.model)
      const nextGroup = `${entry.providerId} · ${entry.accountId}`
      if (nextGroup !== group) {
        group = nextGroup
        rows.push(sectionLabel(group, inner))
      }
      rows.push(selectionRow(
        `${favorite ? yellow('★') : dim('☆')} ${sanitizeTerminalText(entry.label)}`,
        `${entry.providerId}${active ? ' · current' : ''}${entry.configured ? '' : ' · connect'}`,
        inner,
        selected
      ))
    })
    const selected = entries[this.index]
    return pageFrame({
      path: ['KUN', title],
      right: `Current · ${sanitizeTerminalText(current)}`,
      description: 'Choose the shared default model.',
      body: [
        ...lead,
        ...(rows.length ? rows : [` ${dim('No model catalogs. Run /connect first.')}`]),
        ...(selected && visualDensity(width) === 'wide'
          ? [
              '',
              ` ${dim('Selected')}  ${sanitizeTerminalText(selected.providerId)} / ${cyan(sanitizeTerminalText(selected.model))}`
            ]
          : []),
        ...(this.error ? [` ${red(this.error)}`] : [])
      ],
      footer: this.saving
        ? [{ key: statusGlyph('running'), label: 'saving' }]
        : [
            { key: 'Enter', label: 'select' },
            { key: this.keymap.display('model_provider_list'), label: 'providers' },
            { key: this.keymap.display('model_favorite_toggle'), label: 'favorite' },
            { key: 'Esc', label: 'back' }
          ],
      width
    })
  }

  handleInput(data: string): void {
    if (this.saving) return
    if (isCancelInput(data)) { this.close(); return }
    if (this.keymap.matches('model_provider_list', data)) {
      this.mode = this.mode === 'models' ? 'providers' : 'models'
      this.index = 0
      this.tui.requestRender()
      return
    }
    const entries = this.entries()
    const max = this.mode === 'providers' ? this.providers().length - 1 : entries.length - 1
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) this.index = Math.max(0, this.index - 1)
    else if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) this.index = Math.min(Math.max(0, max), this.index + 1)
    else if (matchesKey(data, 'pageUp')) this.index = Math.max(0, this.index - 10)
    else if (matchesKey(data, 'pageDown')) this.index = Math.min(Math.max(0, max), this.index + 10)
    else if (matchesKey(data, 'home')) this.index = 0
    else if (matchesKey(data, 'end')) this.index = Math.max(0, max)
    else if (this.keymap.matches('model_favorite_toggle', data) && this.mode === 'models' && entries[this.index]) {
      const entry = entries[this.index]!
      this.controller.toggleModelFavorite(entry.providerId, entry.accountId, entry.model)
    } else if (matchesKey(data, 'enter') && this.mode === 'providers') {
      const provider = this.providers()[this.index]
      if (provider) {
        this.providerFilter = `${provider.id}\0${provider.accountId}`
        this.mode = 'models'
        this.index = 0
      }
    } else if (matchesKey(data, 'enter') && entries[this.index]) void this.select(entries[this.index]!)
    else {
      this.input.handleInput(data)
      this.index = 0
    }
    this.tui.requestRender()
  }

  invalidate(): void { this.input.invalidate() }

  private async select(entry: {
    providerId: string
    accountId: string
    model: string
    configured: boolean
  }): Promise<void> {
    if (!entry.configured) {
      this.error = `${entry.providerId} is not connected. Run /connect to configure it before selecting this model.`
      this.tui.requestRender()
      return
    }
    this.saving = true
    try {
      this.snapshot = await this.controller.selectModel({
        providerId: entry.providerId,
        accountId: entry.accountId,
        model: entry.model
      })
      this.close()
    } catch (error) {
      this.saving = false
      this.error = safeError(error)
      this.tui.requestRender()
    }
  }
}

function visibleWindow<T>(values: readonly T[], selected: number, size: number): Array<{ value: T; index: number }> {
  const start = Math.max(0, Math.min(selected - Math.floor(size / 2), Math.max(0, values.length - size)))
  return values.slice(start, start + size).map((value, offset) => ({ value, index: start + offset }))
}

function fieldLabel(field: ConnectField | undefined, preset: ConnectionPreset): string {
  switch (field) {
    case 'id': return 'Provider ID'
    case 'name': return 'Provider name'
    case 'baseUrl': return 'Base URL'
    case 'endpointFormat': return 'Endpoint format'
    case 'credential': return preset.authType === 'oauth' ? 'OAuth credential' : 'API key / token plan key'
    case 'models': return 'Models (comma separated)'
    default: return ''
  }
}

function fieldPlaceholder(field: ConnectField | undefined): string {
  if (field === 'credential') return 'hidden input'
  if (field === 'id') return 'for example: company-proxy'
  if (field === 'name') return 'display name'
  if (field === 'baseUrl') return 'https://api.example.com/v1'
  if (field === 'models') return 'model-a, model-b'
  return 'type a value'
}

function endpointFormat(value: string | undefined): 'chat_completions' | 'responses' | 'messages' | 'custom_endpoint' {
  return value === 'responses' || value === 'messages' || value === 'custom_endpoint'
    ? value
    : 'chat_completions'
}

function normalizeConnectionProviderId(value: string): string {
  return value.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 100)
}

function isModelProbeFailure(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return message.includes('provider probe failed') ||
    message.includes('model probe failed') ||
    message.includes('fetch failed') ||
    message.includes('failed to fetch') ||
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('/models')
}

function openBrowser(url: string): void {
  const launch = process.platform === 'darwin'
    ? { command: 'open', args: [url] }
    : process.platform === 'win32'
      ? { command: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '', url] }
      : { command: 'xdg-open', args: [url] }
  try {
    const child = spawn(launch.command, launch.args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
  } catch {
    // The URL remains visible and copyable when no desktop opener exists.
  }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}

function safeError(error: unknown): string {
  return sanitizeTerminalText(error instanceof Error ? error.message : String(error)).slice(0, 300)
}

function redactExactSecret(value: string, secret: string): string {
  return secret ? value.split(secret).join('<redacted>') : value
}

function renderContextBar(state: TuiControllerState, controller: TuiController, width: number): string {
  const workspace = currentWorkspace(state, controller)
  const workspaceLabel = width >= 68
    ? displayWorkspace(workspace)
    : basename(workspace) || workspace
  const connection = state.connection === 'connected'
    ? ''
    : state.connection === 'disconnected'
      ? red('disconnected')
      : yellow(state.connection)
  return joinSides(
    ` ${cyan(bold('KUN'))}  ${dim(sanitizeTerminalText(workspaceLabel))}`,
    connection,
    width
  )
}

function renderConversationContext(
  state: TuiControllerState,
  controller: TuiController,
  width: number
): string {
  const thread = state.projection?.thread
  if (!thread) return ''
  const left = ` ${cyan(bold('KUN'))}${dim(' / ')}${bold(sanitizeTerminalText(thread.title || 'Untitled'))}`
  const right = state.connection === 'connected'
    ? ''
    : state.connection === 'disconnected'
      ? red('disconnected')
      : yellow(state.connection)
  return joinSides(left, right, width)
}

export function renderKunWelcome(
  state: TuiControllerState,
  controller: TuiController,
  width: number,
  height: number
): string[] {
  const contentWidth = Math.max(20, Math.min(width - (width >= 36 ? 4 : 0), 76))
  const compactHeight = height < 24
  const threadCount = state.threads.length
  const version = sanitizeTerminalText(controller.runtime.runtimeInfo.serviceVersion)
  const workspace = displayWorkspace(currentWorkspace(state, controller))
  const effort = state.reasoningEffort ?? 'default'
  const metadata = width < 60
    ? [
        `${dim('Workspace')}  ${sanitizeTerminalText(workspace)}`,
        `${dim('Model')}      ${sanitizeTerminalText(currentModel(state, controller))}`,
        `${dim('Mode')}       ${currentMode(state)} · ${effort}`
      ]
    : [
        joinSides(`${dim('Workspace')}  ${sanitizeTerminalText(workspace)}`, `${dim('Model')}  ${sanitizeTerminalText(currentModel(state, controller))}`, contentWidth),
        joinSides(`${dim('Mode')}       ${currentMode(state)} · ${effort}`, `${dim('Version')}  ${version}`, contentWidth)
      ]
  const body = [
    renderContextBar(state, controller, contentWidth),
    ...(compactHeight ? [] : ['']),
    ` ${cyan(bold('Welcome to Kun'))}`,
    ...(compactHeight ? [] : [` ${dim('A focused terminal agent that keeps working with you.')}`]),
    '',
    ...metadata,
    '',
    ` ${cyan('›')} ${bold('Type a task')} ${dim('and press Enter')}`,
    ` ${cyan('›')} ${bold('/connect')} ${dim('add or manage a provider')}`,
    ` ${cyan('›')} ${bold('/sessions')} ${dim(threadCount ? `resume previous work · ${threadCount} saved` : 'resume previous work')}`
  ]
  const padding = ' '.repeat(Math.max(0, Math.floor((width - contentWidth) / 2)))
  return body.map((line) => `${padding}${line}`)
}

export function renderActivityRow(
  state: TuiControllerState,
  controller: TuiController,
  width: number,
  animationFrame = 0,
  transientHint?: string
): string {
  const notice = state.notification
  const activity = state.projection?.activity
  const projection = state.projection
  const activeChild = [...(projection?.childRuns ?? [])].reverse().find((run) =>
    run.parentTurnId === projection?.runningTurnId && (run.status === 'queued' || run.status === 'running')
  )
  const reconnecting = state.connection === 'reconnecting'
  const connectionPending = reconnecting ||
    state.connection === 'connecting' && !projection?.runningTurnId
  const waitingForApproval = Boolean(projection?.pendingApproval) && !state.busy
  const waitingForInput = Boolean(projection?.pendingUserInput) && !state.busy
  const active = Boolean(
    state.busy || projection?.runningTurnId || activeChild ||
    connectionPending
  )
  if (!active && !transientHint && !notice) return ''
  const activityText = state.busy
    ? state.busyLabel ?? 'Working'
    : reconnecting && projection?.runningTurnId
      ? 'Reconnecting to live stream'
      : projection?.pendingApproval
        ? `Approval required · ${projection.pendingApproval.toolName}`
        : projection?.pendingUserInput
          ? 'Your input is required'
          : activeChild
            ? `Subagent · ${activeChild.label || activeChild.profile || activeChild.childId}`
            : connectionPending
              ? 'Connecting to runtime'
              : activityLabel(activity)
  const activitySince = state.busy
    ? state.busyStartedAt
    : activeChild?.startedAt ?? activity?.startedAt
  const runningTurn = projection?.thread.turns.find((turn) => turn.id === projection.runningTurnId)
  const turnSince = activity?.turnStartedAt ?? runningTurn?.startedAt ?? runningTurn?.createdAt
  const phaseElapsed = elapsedDuration(activitySince, undefined, true)
  const turnElapsed = projection?.runningTurnId
    ? elapsedDuration(turnSince, undefined, true)
    : ''
  const elapsedText = turnElapsed && turnElapsed !== phaseElapsed && width >= 84
    ? `· ${phaseElapsed} · total ${turnElapsed}`
    : `· ${phaseElapsed}`
  const visualKind: ActivityVisualKind = waitingForApproval || waitingForInput
    ? 'attention'
    : activity?.phase === 'retrying' || connectionPending
      ? 'retrying'
      : activeChild
        ? 'subagent'
        : state.busy || !activity
          ? 'waiting'
          : activity.phase === 'thinking'
            ? 'thinking'
            : activity.phase === 'responding'
              ? 'responding'
              : activity.phase === 'tool'
                ? 'tool'
                : 'waiting'
  const rawGlyph = activityFrame(visualKind, animationFrame)
  const activeGlyph = visualKind === 'attention' || visualKind === 'retrying'
    ? yellow(` ${rawGlyph}`)
    : cyan(` ${rawGlyph}`)
  const left = active
    ? `${activeGlyph} ${bold(sanitizeTerminalText(activityText))} ${dim(elapsedText)}`
    : transientHint
      ? yellow(` ! ${sanitizeTerminalText(transientHint)}`)
    : notice
      ? (notice.kind === 'error' ? red(` ! ${notice.message}`) : green(` ✓ ${notice.message}`))
      : `${dim(' Enter send · Ctrl+J newline')}`
  const usage = projection?.usage
  const contextWindow = controller.runtime.runtimeInfo.capabilities?.model?.contextWindowTokens
  const usageText = usage
    ? contextWindow
      ? formatContextGauge(usage.totalTokens, contextWindow)
      : `${formatTokenCount(usage.totalTokens)} tok`
    : undefined
  const status = waitingForApproval
    ? yellow('Action required')
    : waitingForInput
      ? magenta('Action required')
      : connectionPending
        ? yellow('Reconnecting')
        : active && notice
          ? (notice.kind === 'error'
              ? red(`! ${sanitizeTerminalText(notice.message)}`)
              : green(`✓ ${sanitizeTerminalText(notice.message)}`))
        : projection?.runningTurnId
          ? [
              ...(usageText ? [dim(usageText)] : []),
              ...(width >= 62 ? [dim('Esc stop')] : [])
            ].join(dim(' · '))
          : state.busy
            ? cyan('Working')
            : usageText
              ? dim(usageText)
              : state.connection === 'connected'
                ? green('Ready')
                : yellow(state.connection)
  return joinSides(left, ` ${status}`, width)
}

function activityLabel(activity: ProjectedTurnActivity | undefined): string {
  if (!activity) return 'Kun is working'
  if (activity.label) return activity.label
  switch (activity.phase) {
    case 'starting': return 'Starting'
    case 'thinking': return 'Thinking'
    case 'responding': return 'Responding'
    case 'tool': return activity.toolName ? `Running ${humanizeToolName(activity.toolName)}` : 'Running tool'
    case 'retrying': return 'Retrying model request'
    case 'compacting': return 'Compacting context'
    case 'waiting': return 'Waiting'
  }
}

export function renderKunComposerFrame(
  editorLines: string[],
  state: TuiControllerState,
  controller: TuiController,
  width: number,
  keymap?: TuiKeymap
): string[] {
  const safeWidth = Math.max(20, width)
  const borderIndex = editorLines.findIndex((line, index) =>
    index > 0 && /^─+(?:\s+[↑↓].*)?$/u.test(stripTerminalControls(line))
  )
  const split = borderIndex >= 0 ? borderIndex : Math.max(1, editorLines.length)
  const content = editorLines.slice(1, split)
  const autocomplete = editorLines.slice(Math.min(editorLines.length, split + 1))
  const topLabel = editorRuleLabel(editorLines[0])
  const dividerLabel = borderIndex >= 0 ? editorRuleLabel(editorLines[borderIndex]) : ''
  const lines = [
    composerRule('┌', '┐', safeWidth, topLabel),
    ...content.map((line, index) => composerContent(line, safeWidth, index === 0 ? ` ${yellow('›')} ` : '   ')),
    composerRule('├', '┤', safeWidth, dividerLabel),
    ...autocomplete.map((line) => composerContent(line, safeWidth, '   '))
  ]
  if (autocomplete.length) lines.push(composerRule('├', '┤', safeWidth))
  lines.push(
    composerContent(renderComposerMetadata(state, controller, safeWidth - 4, keymap), safeWidth, ' '),
    composerRule('└', '┘', safeWidth)
  )
  return lines
}

function editorRuleLabel(line: string | undefined): string {
  if (!line) return ''
  return stripTerminalControls(line).replaceAll('─', '').trim()
}

function composerRule(left: string, right: string, width: number, label = ''): string {
  if (!label) return cyan(`${left}${'─'.repeat(Math.max(0, width - 2))}${right}`)
  const safeLabel = truncateToWidth(sanitizeTerminalText(label), Math.max(1, width - 6))
  const prefix = `─ ${safeLabel} `
  return cyan(`${left}${prefix}${'─'.repeat(Math.max(0, width - visibleWidth(prefix) - 2))}${right}`)
}

function composerContent(line: string, width: number, prefix: string): string {
  const inner = width - 2
  const value = truncateToWidth(`${prefix}${line}`, inner)
  return `${cyan('│')}${value}${' '.repeat(Math.max(0, inner - visibleWidth(value)))}${cyan('│')}`
}

function renderComposerMetadata(
  state: TuiControllerState,
  controller: TuiController,
  width: number,
  _keymap?: TuiKeymap
): string {
  const mode = currentMode(state)
  const metadata = [
    dim(currentModel(state, controller)),
    dim('·'),
    cyan(state.reasoningEffort ?? 'default'),
    dim('·'),
    mode === 'plan' ? yellow(bold(mode)) : dim(mode)
  ].join(' ')
  return truncateToWidth(` ${metadata}`, width)
}

function renderShortcutFooter(
  state: TuiControllerState,
  keymap: TuiKeymap,
  width: number,
  leaderHint?: Array<{ action: TuiKeyAction; key: string }>,
  pointerMode = false
): string {
  if (leaderHint) {
    const labels: Partial<Record<TuiKeyAction, string>> = {
      session_new: 'new', session_list: 'sessions', session_timeline: 'timeline',
      session_compact: 'compact', session_export: 'export', session_status: 'status',
      messages_copy: 'copy', model_list: 'models', agent_list: 'mode',
      pointer_mode_toggle: 'pointer', session_undo: 'undo', session_redo: 'redo', app_exit: 'quit'
    }
    const text = leaderHint
      .filter((entry) => labels[entry.action])
      .slice(0, width >= 94 ? 11 : width >= 54 ? 6 : 3)
      .map((entry) => `${cyan(bold(entry.key))} ${dim(labels[entry.action]!)}`)
      .join(dim('  ·  '))
    return ` ${yellow(bold('Leader'))}  ${text}`
  }
  if (pointerMode) {
    return truncateToWidth(
      ` ${cyan(bold('Pointer mode'))}  ${dim('click Thinking/Subagent · Esc/Ctrl+C text selection')}`,
      width
    )
  }
  const running = Boolean(state.projection?.runningTurnId)
  const actions = [
    `${cyan(bold(running ? 'Esc' : 'Enter'))} ${dim(running ? 'stop' : 'send')}`,
    ...(running && width >= 54 ? [`${cyan(bold(keymap.display('input_steer')))} ${dim('steer')}`] : []),
    `${cyan(bold(keymap.display('command_list')))} ${dim('commands')}`
  ]
  return truncateToWidth(` ${actions.join(dim('  ·  '))}`, width)
}

export function renderKunWordmark(width: number, version: string): string[] {
  return [truncateToWidth(
    ` ${blue(bold('KUN'))}  ${dim(`terminal agent · v${version}`)}`,
    Math.max(1, width)
  )]
}

function currentWorkspace(state: TuiControllerState, controller: TuiController): string {
  return sanitizeTerminalText(state.projection?.thread.workspace ?? controller.options.workspace)
}

function displayWorkspace(workspace: string): string {
  const home = homedir()
  const displayed = workspace === home
    ? '~'
    : workspace.startsWith(`${home}${sep}`)
      ? `~${workspace.slice(home.length)}`
      : workspace
  return sanitizeTerminalText(displayed)
}

function currentModel(state: TuiControllerState, controller: TuiController): string {
  const latestTurn = [...(state.projection?.thread.turns ?? [])].reverse().find((turn) => turn.model || turn.providerId)
  const model = controller.options.model ?? latestTurn?.model ?? state.projection?.thread.model ?? controller.runtime.runtimeInfo.model
  const provider = controller.options.providerId ?? latestTurn?.providerId ?? state.projection?.thread.providerId
  if (!model) return 'not selected · /connect'
  return sanitizeTerminalText(provider ? `${provider} / ${model}` : model)
}

function currentMode(state: TuiControllerState): 'agent' | 'plan' {
  const latestTurn = [...(state.projection?.thread.turns ?? [])].reverse().find((turn) => turn.mode)
  return latestTurn?.mode ?? state.projection?.thread.mode ?? state.composerMode
}

function joinSides(left: string, right: string, width: number): string {
  if (!right) return truncateToWidth(left, width)
  const rightLimit = Math.max(8, Math.floor(width * 0.55))
  const clippedRight = truncateToWidth(right, rightLimit)
  const leftLimit = Math.max(1, width - visibleWidth(clippedRight) - 1)
  const clippedLeft = truncateToWidth(left, leftLimit)
  const gap = ' '.repeat(Math.max(1, width - visibleWidth(clippedLeft) - visibleWidth(clippedRight)))
  return `${clippedLeft}${gap}${clippedRight}`
}

// The only outlined container left in Kun is the explicitly requested,
// centered child-transcript popup. Full-page routes use pageFrame instead.
function popupFrame(title: string, body: string[], width: number): string[] {
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

function plainLines(value: string, width: number, padding: number): string[] {
  const safe = sanitizeTerminalText(value || '')
  return safe.split('\n').map((line) => `${' '.repeat(padding)}${truncateToWidth(line, Math.max(1, width - padding))}`)
}

function summarize(value: unknown): string {
  try {
    return truncateToWidth(JSON.stringify(redactSecrets(value)), 100)
  } catch {
    return String(value)
  }
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return sanitizeTerminalText(value)
  try { return sanitizeTerminalText(JSON.stringify(redactSecrets(value))) } catch { return sanitizeTerminalText(String(value)) }
}

function elapsedDuration(start: string | undefined, end: string | undefined, live: boolean): string {
  if (!start) return live ? '0.0s' : ''
  if (!end && !live) return ''
  const startMs = Date.parse(start)
  const endMs = end ? Date.parse(end) : Date.now()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return ''
  return formatDurationMs(Math.max(0, endMs - startMs))
}

function formatDurationMs(durationMs: number): string {
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`
  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.floor((durationMs % 60_000) / 1_000)
  return `${minutes}m ${seconds}s`
}

function itemDuration(item: TurnItem, live: boolean, inferredEnd?: string): string {
  return elapsedDuration(item.createdAt, item.finishedAt ?? inferredEnd, live)
}

function resolveReasoningEndAt(
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

function childIdFromToolResult(
  result: Extract<TurnItem, { kind: 'tool_result' }> | undefined
): string | undefined {
  if (!result || !result.output || typeof result.output !== 'object') return undefined
  const value = result.output as Record<string, unknown>
  return typeof value.childId === 'string' ? value.childId : undefined
}

function humanizeToolName(name: string): string {
  const normalized = sanitizeTerminalText(name).replaceAll('_', ' ').trim()
  return normalized ? `${normalized[0]!.toUpperCase()}${normalized.slice(1)}` : 'Tool'
}

function toolAction(item: Extract<TurnItem, { kind: 'tool_call' }>): { verb: string; subject: string } {
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

function toolResultSummary(value: unknown): string {
  return conciseToolResultSummary(value) ?? outputText(value)
}

function toolTreeSection(
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

function conciseToolResultSummary(value: unknown): string | undefined {
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

function isModelConnectionError(item: Extract<TurnItem, { kind: 'error' }>): boolean {
  return item.code === 'http_401' || item.code === 'unauthorized' ||
    /\b401\b|invalid or expired credentials|no auth context|authentication|unauthori[sz]ed/iu.test(item.message)
}

function friendlyRuntimeError(message: string): string {
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

function oneLine(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/gu, ' ').trim().slice(0, 160) || '(empty)'
}

/** Decode plain and Kitty printable input without treating escape sequences as text. */
export function printableInput(data: string): string | undefined {
  const kitty = decodeKittyPrintable(data)
  if (kitty) return kitty
  if (!data.includes('\x1b') && Array.from(data).every((value) => value.codePointAt(0)! >= 0x20)) return data
  return undefined
}
