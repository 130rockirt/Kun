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
import { PiTuiApplicationOverlays } from './application-overlays.js'
import { ConnectDialog } from './connect-dialog.js'
import { ModelDialog } from './model-dialog.js'
import { SubagentDialog } from './subagent-dialog.js'
import { CommandPaletteDialog, VariantDialog, AgentModeDialog, GoalDialog } from './command-dialogs.js'
import { safeError } from './render-layout.js'

export class PiTuiApplication extends PiTuiApplicationOverlays {
  protected override async openInteractiveTerminal(): Promise<void> {
    const shell = process.platform === 'win32'
      ? process.env.COMSPEC || 'cmd.exe'
      : process.env.SHELL || '/bin/sh'
    this.writeMouseTracking(false)
    this.tui.stop()
    this.terminalActive = false
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const child = spawn(shell, [], {
          cwd: this.controller.state.projection?.thread.workspace ?? this.controller.options.workspace,
          stdio: 'inherit',
          windowsHide: false
        })
        child.once('error', reject)
        child.once('close', () => resolvePromise())
      })
    } catch (error) {
      this.controller.notify(safeError(error), 'error')
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

  protected async authenticateOfficialProvider(provider: OfficialProviderCliId): Promise<void> {
    if (this.officialProviderAuthenticator) {
      await this.officialProviderAuthenticator(provider)
      return
    }
    let command = provider === 'gemini-cli'
      ? resolveGeminiCliCommand()
      : resolveAntigravityCliCommand(this.controller.options.dataDir)
    if (!command && provider === 'antigravity') {
      this.controller.notify('Installing the official Antigravity CLI…')
      command = await installAntigravityCli({
        dataDir: this.controller.options.dataDir
      })
    }
    if (!command) {
      throw new Error(
        'The official Gemini CLI is unavailable. Install @google/gemini-cli or use a current standalone Kun TUI build.'
      )
    }
    this.writeMouseTracking(false)
    this.tui.stop()
    this.terminalActive = false
    this.terminal.write([
      '',
      `Kun opened ${command.displayName} for provider-owned authentication.`,
      provider === 'gemini-cli'
        ? 'Use /auth to sign in again if needed, then use /quit to return to Kun.'
        : 'Complete Google sign-in, then use /quit to return to Kun.',
      ''
    ].join('\r\n'))
    try {
      await runInteractiveProviderCli(command, {
        cwd: this.controller.state.projection?.thread.workspace ?? this.controller.options.workspace
      })
    } finally {
      if (!this.stopped) {
        this.tui.start()
        this.terminalActive = true
        this.writeMouseTracking(this.mouseTrackingWanted)
        this.terminal.setTitle('Kun')
        this.tui.setFocus(this.connectRoute ?? this.root)
        this.tui.requestRender(true)
      }
    }
  }

  protected override async showConnect(): Promise<void> {
    this.closeModelRoute()
    this.closeUsageRoute()
    this.closeQuotaRoute()
    this.closeSubagentRoute()
    if (this.connectRoute) return
    try {
      const snapshot = await this.controller.client.modelConnections()
      const component = new ConnectDialog(
        this.tui,
        this.controller,
        snapshot,
        (provider) => this.authenticateOfficialProvider(provider),
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

  protected override async showModels(): Promise<void> {
    this.closeConnectRoute()
    this.closeUsageRoute()
    this.closeQuotaRoute()
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

  protected closeModelRoute(): void {
    if (!this.modelRoute) return
    const route = this.modelRoute
    this.modelRoute = undefined
    this.root.hidePrimaryRoute(route)
    this.tui.setFocus(this.root)
    this.tui.requestRender()
  }

  protected closeConnectRoute(): void {
    if (!this.connectRoute) return
    const route = this.connectRoute
    this.connectRoute = undefined
    this.root.hidePrimaryRoute(route)
    this.tui.setFocus(this.root)
    this.tui.requestRender()
  }

  protected override showQuota(): void {
    this.closeConnectRoute()
    this.closeModelRoute()
    this.closeUsageRoute()
    this.closeSubagentRoute()
    if (this.quotaRoute) return
    const component = new ProviderQuotaDialog(
      this.tui,
      () => this.controller.client.providerQuotas(),
      () => this.closeQuotaRoute(),
      () => this.terminal.rows
    )
    this.quotaRoute = component
    this.root.showPrimaryRoute('provider-quota', component)
    this.tui.setFocus(component)
    this.tui.requestRender()
    void component.refresh()
  }

  protected closeQuotaRoute(): void {
    if (!this.quotaRoute) return
    const route = this.quotaRoute
    this.quotaRoute = undefined
    this.root.hidePrimaryRoute(route)
    this.tui.setFocus(this.root)
    this.tui.requestRender()
  }

  protected override showUsage(): void {
    this.closeConnectRoute()
    this.closeModelRoute()
    this.closeQuotaRoute()
    this.closeSubagentRoute()
    if (this.usageRoute) return
    const component = new UsageDialog(
      this.tui,
      async () => ({
        usage: await this.controller.client.usage(),
        ...(this.controller.state.projection?.thread.id
          ? { activeThreadId: this.controller.state.projection.thread.id }
          : {}),
        threadTitles: Object.fromEntries(
          this.controller.state.threads.map((thread) => [thread.id, thread.title || thread.id])
        )
      }),
      () => this.closeUsageRoute(),
      () => this.terminal.rows
    )
    this.usageRoute = component
    this.root.showPrimaryRoute('usage', component)
    this.tui.setFocus(component)
    this.tui.requestRender()
    void component.refresh()
  }

  protected closeUsageRoute(): void {
    if (!this.usageRoute) return
    const route = this.usageRoute
    this.usageRoute = undefined
    this.root.hidePrimaryRoute(route)
    this.tui.setFocus(this.root)
    this.tui.requestRender()
  }

  protected override showSubagents(): void {
    this.closeConnectRoute()
    this.closeModelRoute()
    this.closeUsageRoute()
    this.closeQuotaRoute()
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

  protected override showSubagentPopup(child: ProjectedChildRun, onClose?: () => void): void {
    this.closeSubagentPopup(false)
    const projection = this.controller.state.projection
    if (!projection) return
    this.subagentPopupReturn = onClose
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

  protected closeSubagentPopup(restore = true): void {
    if (!this.subagentPopup) return
    const popup = this.subagentPopup
    const onClose = this.subagentPopupReturn
    this.subagentPopup = undefined
    this.subagentPopupReturn = undefined
    popup.component.dispose()
    popup.handle.hide()
    this.tui.setFocus(this.root)
    this.syncMouseTracking(this.controller.state)
    this.tui.requestRender()
    if (restore) onClose?.()
  }

  protected closeSubagentRoute(): void {
    if (!this.subagentRoute) return
    const route = this.subagentRoute
    this.subagentRoute = undefined
    route.dispose()
    this.root.hidePrimaryRoute(route)
    this.tui.setFocus(this.root)
    this.tui.requestRender()
  }

  protected override showCommandPalette(): void {
    if (this.commandOverlay) return
    const component = new CommandPaletteDialog(this.keymap, (entry) => {
      this.commandOverlay?.handle.hide()
      this.commandOverlay = undefined
      this.tui.setFocus(this.root)
      if (!entry?.slash) return
      if (entry.argumentRequired) this.root.setEditorText(`/${entry.slash} `)
      else if (entry.id === 'graph') void this.root.executeSlash('graph status')
      else void this.root.executeSlash(entry.slash)
    })
    this.commandOverlay = {
      component,
      handle: this.showExclusiveRoute('commands', component)
    }
  }

  protected override showVariants(): void {
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

  protected override showAgentModes(): void {
    if (this.agentOverlay) return
    const close = () => {
      this.agentOverlay?.handle.hide()
      this.agentOverlay = undefined
      this.tui.setFocus(this.root)
    }
    const component = new AgentModeDialog(this.controller, close, () => {
      close()
      this.showGoal()
    })
    this.agentOverlay = {
      component,
      handle: this.showExclusiveRoute('mode', component)
    }
  }

  protected override showGoal(): void {
    if (this.goalOverlay) return
    const close = () => {
      this.goalOverlay?.handle.hide()
      this.goalOverlay = undefined
      this.tui.setFocus(this.root)
    }
    const component = new GoalDialog(this.tui, this.controller, close)
    this.goalOverlay = {
      component,
      handle: this.showExclusiveRoute('goal', component)
    }
  }

  protected override hideAllOverlays(): void {
    this.closeSubagentPopup(false)
    this.closeGraphPopup(false)
    for (const entry of [
      this.threadOverlay, this.helpOverlay, this.approvalOverlay, this.inputOverlay,
      this.inspectionOverlay, this.permissionOverlay, this.timelineOverlay, this.skillsOverlay,
      this.commandOverlay, this.variantOverlay, this.agentOverlay, this.goalOverlay
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
    this.goalOverlay = undefined
    this.closeConnectRoute()
    this.closeModelRoute()
    this.closeUsageRoute()
    this.closeQuotaRoute()
    this.closeSubagentRoute()
  }

  protected override syncMouseTracking(_state: TuiControllerState): void {
    this.mouseTrackingWanted = this.pointerModeEnabled
    this.writeMouseTracking(this.mouseTrackingWanted)
  }

  protected override writeMouseTracking(enabled: boolean): void {
    this.terminal.setMouseTrackingAllowed(enabled)
    if (!this.terminalActive || this.mouseTrackingEnabled === enabled) return
    this.terminal.write(enabled ? ENABLE_MOUSE_TRACKING : DISABLE_MOUSE_TRACKING)
    this.mouseTrackingEnabled = enabled
  }
}
