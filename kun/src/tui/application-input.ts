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
import { PiTuiApplicationBase } from './application-base.js'
import { isActiveChildRun } from './subagent-components.js'
import { safeError } from './render-layout.js'

export abstract class PiTuiApplicationInput extends PiTuiApplicationBase {
  protected override syncAnimation(state: TuiControllerState): void {
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

  /**
   * Real PTYs are allowed to coalesce consecutive writes into one data event.
   * In particular, a Leader chord can arrive as "\x18n" instead of two
   * callbacks. pi-tui forwards the raw chunk, so recognize a complete combined
   * Leader sequence before it can fall through into the editor as text.
   */
  protected override handleTerminalInput(data: string): { consume?: boolean } | undefined {
    if (data.length > 1) {
      for (let leaderEnd = 1; leaderEnd < data.length; leaderEnd += 1) {
        const leader = data.slice(0, leaderEnd)
        if (!this.keymap.matchesLeader(leader)) continue
        const actionKey = data.slice(leaderEnd)
        if (!this.keymap.leaderMatch(actionKey)) continue
        this.handleGlobalInput(leader)
        this.handleGlobalInput(actionKey)
        return { consume: true }
      }
    }
    return this.handleGlobalInput(data)
  }

  protected handleGlobalInput(data: string): { consume?: boolean } | undefined {
    const mouse = parseSgrMouseEvent(data)
    if (mouse) {
      this.clearPendingGestures()
      if (!this.pointerModeEnabled) return { consume: true }
      if (this.subagentPopup) {
        this.subagentPopup.component.handleMouse(mouse)
        return { consume: true }
      }
      if (this.graphPopup) {
        this.graphPopup.component.handleMouse(mouse)
        return { consume: true }
      }
      if (this.tui.hasOverlay()) return { consume: true }
      if (this.subagentRoute) {
        this.subagentRoute.handleMouse(mouse)
        return { consume: true }
      }
      if (mouse.pressed && (mouse.button & 3) === 0) {
        if (this.root.graphProgressAtTerminalRow(mouse.y)) {
          void this.controller.showGraphStatus()
          return { consume: true }
        }
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
    if (this.keymap.matches('subagent_detach', data)) {
      const child = [...(this.controller.state.projection?.childRuns ?? [])].reverse().find((run) =>
        !run.detached && isActiveChildRun(run)
      )
      // Match Kimi's contextual Ctrl+B: it backgrounds a live foreground
      // agent, but remains the editor's normal cursor-left key otherwise.
      if (child) {
        void this.controller.manageSubagents(`background ${child.childId}`)
        return this.keyConsumption('subagent_detach', data)
      }
      return undefined
    }
    if (this.keymap.matches('input_newline', data)) {
      this.root.insertNewline()
      return this.keyConsumption('input_newline', data)
    }
    if (
      this.root.editorEmpty() &&
      this.controller.state.pendingAttachments.length > 0 &&
      (
        matchesKey(data, 'backspace') ||
        matchesKey(data, 'ctrl+backspace') ||
        matchesKey(data, 'delete')
      )
    ) {
      this.clearPendingGestures()
      this.controller.removeLastPendingAttachment()
      return { consume: true }
    }
    if (this.keymap.matches('input_clear', data) && !this.root.composerEmpty()) {
      this.clearPendingGestures()
      this.root.clearComposer()
      return this.keyConsumption('input_clear', data)
    }
    if (this.keymap.matches('app_exit', data)) {
      if (this.root.composerEmpty()) {
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
      if (matchesKey(data, 'escape') && this.root.composerEmpty() && this.controller.state.projection) {
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
    if (this.root.composerEmpty() && this.controller.state.projection) {
      if (matchesKey(data, 'left')) {
        void this.controller.navigateSessionRelation('previous-sibling')
        return { consume: true }
      }
      if (matchesKey(data, 'right')) {
        void this.controller.navigateSessionRelation('next-sibling')
        return { consume: true }
      }
    }
    if (this.keymap.matches('session_rename', data) && this.root.composerEmpty()) {
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

  protected cancelPendingGesturesForDifferentInput(data: string): void {
    if (this.pendingExit && !matchesKey(data, this.pendingExit.key)) this.clearPendingExit()
    if (this.pendingUndoTimer && !matchesKey(data, 'escape')) this.clearPendingUndo()
  }

  protected armPendingExit(key: 'ctrl+c' | 'ctrl+d'): void {
    this.clearPendingExit()
    const label = key === 'ctrl+c' ? 'Ctrl+C' : 'Ctrl+D'
    this.root.setTransientHint(`Press ${label} again to exit`)
    this.pendingExit = {
      key,
      timer: setTimeout(() => this.clearPendingExit(), EXIT_CONFIRM_WINDOW_MS)
    }
    this.tui.requestRender()
  }

  protected override clearPendingExit(): void {
    if (!this.pendingExit) return
    clearTimeout(this.pendingExit.timer)
    this.pendingExit = undefined
    this.root.setTransientHint(undefined)
    this.tui.requestRender()
  }

  protected armPendingUndo(): void {
    this.clearPendingUndo()
    this.root.setTransientHint('Press Esc again to undo the last turn')
    this.pendingUndoTimer = setTimeout(() => this.clearPendingUndo(), UNDO_ESCAPE_WINDOW_MS)
    this.tui.requestRender()
  }

  protected override clearPendingUndo(): void {
    if (!this.pendingUndoTimer) return
    clearTimeout(this.pendingUndoTimer)
    this.pendingUndoTimer = undefined
    this.root.setTransientHint(undefined)
    this.tui.requestRender()
  }

  protected clearPendingGestures(): void {
    this.clearPendingExit()
    this.clearPendingUndo()
  }

  protected keyConsumption(action: TuiKeyAction, data: string): { consume?: boolean } | undefined {
    const binding = this.keymap.match(action, data)
    return binding?.preventDefault !== false && !binding?.fallthrough ? { consume: true } : undefined
  }

  protected beginLeader(): void {
    this.cancelLeader()
    this.leaderPending = true
    this.root.setLeaderHint(this.keymap.leaderActions())
    this.leaderTimer = setTimeout(() => {
      this.cancelLeader()
      this.controller.notify('Leader timed out.')
    }, this.keymap.leaderTimeoutMs)
    this.tui.requestRender()
  }

  protected override cancelLeader(): void {
    if (this.leaderTimer) clearTimeout(this.leaderTimer)
    this.leaderTimer = undefined
    this.leaderPending = false
    this.root.setLeaderHint(undefined)
  }

  protected executeKeyAction(action: TuiKeyAction): void {
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
      case 'subagent_detach': {
        const child = [...(this.controller.state.projection?.childRuns ?? [])].reverse().find((run) =>
          !run.detached && isActiveChildRun(run)
        )
        if (child) void this.controller.manageSubagents(`background ${child.childId}`)
        else this.controller.notify('No foreground subagent is available to move into the background.', 'error')
        break
      }
      case 'input_editor': void this.root.openExternalEditor(); break
      case 'input_steer': void this.root.steerEditor(); break
      case 'input_paste': void this.pasteClipboardImage(); break
      case 'app_exit': this.requestQuit(); break
      case 'command_list': this.showCommandPalette(); break
      case 'variant_cycle': this.controller.cycleReasoningEffort(); break
      case 'sidebar_toggle': this.controller.showThreads(); break
      case 'theme_list': this.controller.setTheme(); break
      case 'session_share':
      case 'share': void this.shareThread(); break
      case 'session_unshare': void this.unshareThread(); break
      case 'plugin_list': void this.controller.manageExtensions(); break
      case 'console_toggle': void this.controller.showRuntimeConsole(); break
      case 'diff_toggle': void this.controller.showWorkspaceDiff(); break
      case 'terminal_toggle': void this.openInteractiveTerminal(); break
      default: this.controller.notify(`Action ${action} is unavailable in this context.`, 'error')
    }
  }

  protected override async pasteClipboardImage(): Promise<void> {
    if (this.clipboardPastePending) {
      this.controller.notify('Kun is already reading the clipboard.')
      return
    }
    this.clipboardPastePending = true
    this.controller.notify('Reading image from the system clipboard…')
    try {
      const image = await this.clipboardImageReader()
      if (!image) {
        this.controller.notify(clipboardImageEmptyHint(), 'error')
        return
      }
      await this.controller.attachClipboardImage(image)
    } catch (error) {
      this.controller.notify(
        error instanceof ClipboardImageError ? error.message : safeError(error),
        'error'
      )
    } finally {
      this.clipboardPastePending = false
      this.tui.requestRender()
    }
  }

  protected suspendProcess(): void {
    if (process.platform === 'win32') {
      this.controller.notify('Process suspend is only available on Unix terminals.', 'error')
      return
    }
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
}
