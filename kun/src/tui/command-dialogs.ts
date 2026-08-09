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
import { formatGoalDuration, popupFrame } from './render-utils.js'

export class CommandPaletteDialog implements Component, Focusable {
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

export class VariantDialog implements Component, Focusable {
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

export class AgentModeDialog implements Component, Focusable {
  private readonly modes = ['agent', 'plan', 'graph', 'goal'] as const
  private index: number
  private _focused = false

  constructor(
    private readonly controller: TuiController,
    private readonly close: () => void,
    private readonly openGoal: () => void
  ) {
    const thread = controller.state.projection?.thread
    const current = thread?.goal?.status === 'active'
      ? 'goal'
      : controller.state.composerOrchestration === 'graph'
        ? 'graph'
      : thread?.mode ?? controller.state.composerMode
    this.index = this.modes.indexOf(current)
  }

  get focused(): boolean { return this._focused }
  set focused(value: boolean) { this._focused = value }

  render(width: number): string[] {
    return pageFrame({
      path: ['KUN', 'Mode'],
      description: 'Choose Direct, Plan, Graph, or a persistent Goal.',
      body: this.modes.map((mode, index) => {
        const description = mode === 'agent'
          ? 'Build and act on the next request'
          : mode === 'plan'
            ? 'Analyze and plan before making changes'
            : mode === 'graph'
              ? 'Plan and execute through durable Graph subagents'
            : 'Keep pursuing Goals until complete'
        return selectionRow(
          mode === 'goal' ? 'Goal' : mode,
          description,
          width - 2,
          index === this.index
        )
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
    else if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) this.index = Math.min(this.modes.length - 1, this.index + 1)
    else if (matchesKey(data, 'home') || matchesKey(data, 'pageUp')) this.index = 0
    else if (matchesKey(data, 'end') || matchesKey(data, 'pageDown')) this.index = this.modes.length - 1
    else if (matchesKey(data, 'enter')) {
      const mode = this.modes[this.index]!
      if (mode === 'goal') this.openGoal()
      else if (mode === 'graph') {
        void this.controller.manageGraphMode().then(() => {
          this.close()
        })
      }
      else {
        void this.controller.setPlanMode(mode)
        this.close()
      }
    }
  }

  invalidate(): void {}
}

export type GoalDialogMode = 'menu' | 'objective' | 'budget' | 'confirm-clear'

export class GoalDialog implements Component, Focusable {
  private readonly input = new Input()
  private state: TuiControllerState
  private mode: GoalDialogMode
  private index = 0
  private _focused = false
  private saving = false
  private error = ''

  constructor(
    private readonly tui: TUI,
    private readonly controller: TuiController,
    private readonly close: () => void
  ) {
    this.state = controller.state
    this.mode = this.state.projection?.thread.goal ? 'menu' : 'objective'
  }

  get focused(): boolean { return this._focused }
  set focused(value: boolean) {
    this._focused = value
    this.input.focused = value && (this.mode === 'objective' || this.mode === 'budget')
  }

  update(state: TuiControllerState): void {
    this.state = state
    this.tui.requestRender()
  }

  private actions(): Array<{ id: 'pause' | 'resume' | 'edit' | 'budget' | 'clear'; label: string; detail: string }> {
    const goal = this.state.projection?.thread.goal
    if (!goal) return []
    const canPause = goal.status === 'active'
    return [
      canPause
        ? { id: 'pause', label: 'Pause goal', detail: 'Stop automatic continuation; keep progress' }
        : { id: 'resume', label: 'Resume goal', detail: 'Continue working in agent mode now' },
      { id: 'edit', label: 'Edit objective', detail: 'Replace the objective and start pursuing it' },
      { id: 'budget', label: 'Token budget', detail: goal.tokenBudget ? goal.tokenBudget.toLocaleString() : 'unlimited' },
      { id: 'clear', label: 'Clear goal', detail: 'Remove objective and accumulated goal state' }
    ]
  }

  render(width: number): string[] {
    const inner = Math.max(12, width - 2)
    const goal = this.state.projection?.thread.goal
    const summary = goal
      ? [
          `${dim('Status')}     ${goal.status === 'active' ? green(bold('active')) : yellow(goal.status)}`,
          `${dim('Objective')}  ${sanitizeTerminalText(goal.objective)}`,
          `${dim('Usage')}      ${goal.tokensUsed.toLocaleString()} tokens${goal.tokenBudget ? ` / ${goal.tokenBudget.toLocaleString()}` : ''} · ${formatGoalDuration(goal.timeUsedSeconds)}`
        ]
      : [
          `${yellow(bold('No active goal'))}`,
          dim('Set an objective and Kun will keep working across turns until it is complete, paused, or blocked.')
        ]

    let body: string[]
    let footer: Array<{ key: string; label: string; tone?: 'danger' }>
    if (this.mode === 'objective') {
      body = [
        ...summary,
        '',
        sectionLabel(goal ? 'Edit objective' : 'Start Goal mode', inner),
        this.input.render(Math.max(10, inner)).join(' '),
        this.error ? red(this.error) : dim('Enter starts an agent turn immediately.')
      ]
      footer = [
        { key: 'Enter', label: goal ? 'save and pursue' : 'start goal' },
        { key: 'Esc', label: goal ? 'actions' : 'back' }
      ]
    } else if (this.mode === 'budget') {
      body = [
        ...summary,
        '',
        sectionLabel('Token budget', inner),
        this.input.render(Math.max(10, inner)).join(' '),
        this.error ? red(this.error) : dim('Enter a positive token count, or “none” for no limit.')
      ]
      footer = [
        { key: 'Enter', label: 'save budget' },
        { key: 'Esc', label: 'actions' }
      ]
    } else if (this.mode === 'confirm-clear') {
      body = [
        ...summary,
        '',
        red(bold('Clear this goal and its accumulated usage state?'))
      ]
      footer = [
        { key: 'Enter', label: 'clear permanently', tone: 'danger' },
        { key: 'Esc', label: 'cancel' }
      ]
    } else {
      const actions = this.actions()
      this.index = Math.min(this.index, Math.max(0, actions.length - 1))
      body = [
        ...summary,
        '',
        sectionLabel('Actions', inner),
        ...actions.map((action, index) =>
          selectionRow(action.label, action.detail, inner, index === this.index)
        )
      ]
      footer = [
        { key: '↑/↓', label: 'choose' },
        { key: 'Enter', label: 'run' },
        { key: 'Esc', label: 'back' }
      ]
    }

    return pageFrame({
      path: ['KUN', 'Goal mode'],
      description: 'A persistent objective with automatic continuation and shared GUI/TUI state.',
      right: this.saving ? 'saving…' : goal?.status ?? 'not configured',
      body,
      footer,
      width
    })
  }

  handleInput(data: string): void {
    if (this.saving) return
    if (isCancelInput(data)) {
      if (this.mode === 'menu' || (this.mode === 'objective' && !this.state.projection?.thread.goal)) {
        this.close()
      } else {
        this.mode = 'menu'
        this.input.setValue('')
        this.error = ''
        this.input.focused = false
        this.tui.requestRender()
      }
      return
    }

    if (this.mode === 'menu') {
      const actions = this.actions()
      if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) this.index = Math.max(0, this.index - 1)
      else if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) this.index = Math.min(actions.length - 1, this.index + 1)
      else if (matchesKey(data, 'home') || matchesKey(data, 'pageUp')) this.index = 0
      else if (matchesKey(data, 'end') || matchesKey(data, 'pageDown')) this.index = Math.max(0, actions.length - 1)
      else if (matchesKey(data, 'enter')) void this.runAction(actions[this.index]?.id)
      this.tui.requestRender()
      return
    }

    if (this.mode === 'confirm-clear') {
      if (matchesKey(data, 'enter') || data.toLowerCase() === 'y') void this.clearGoal()
      return
    }

    if (matchesKey(data, 'enter')) {
      if (this.mode === 'objective') void this.saveObjective()
      else void this.saveBudget()
      return
    }
    this.input.handleInput(data)
    this.error = ''
    this.tui.requestRender()
  }

  private async runAction(action?: 'pause' | 'resume' | 'edit' | 'budget' | 'clear'): Promise<void> {
    if (!action) return
    if (action === 'edit') {
      this.mode = 'objective'
      this.input.setValue(this.state.projection?.thread.goal?.objective ?? '')
      this.input.focused = this._focused
      return
    }
    if (action === 'budget') {
      this.mode = 'budget'
      this.input.setValue(this.state.projection?.thread.goal?.tokenBudget?.toString() ?? '')
      this.input.focused = this._focused
      return
    }
    if (action === 'clear') {
      this.mode = 'confirm-clear'
      return
    }
    this.saving = true
    const ok = await this.controller.setGoalStatus(action === 'pause' ? 'paused' : 'active')
    this.saving = false
    if (ok && action === 'resume') this.close()
    this.tui.requestRender()
  }

  private async saveObjective(): Promise<void> {
    const objective = this.input.getValue().trim()
    if (!objective) {
      this.error = 'Enter an objective before starting Goal mode.'
      this.tui.requestRender()
      return
    }
    this.saving = true
    const ok = await this.controller.activateGoal(
      objective,
      this.state.projection?.thread.goal?.tokenBudget
    )
    this.saving = false
    if (ok) this.close()
    this.tui.requestRender()
  }

  private async saveBudget(): Promise<void> {
    const value = this.input.getValue().trim().toLowerCase()
    const budget = value === '' || value === 'none' || value === 'unlimited'
      ? null
      : Number(value.replace(/[, _]/gu, ''))
    if (budget !== null && (!Number.isSafeInteger(budget) || budget <= 0)) {
      this.error = 'Use a positive whole number, or “none”.'
      this.tui.requestRender()
      return
    }
    this.saving = true
    const ok = await this.controller.setGoalBudget(budget)
    this.saving = false
    if (ok) {
      this.mode = 'menu'
      this.input.setValue('')
      this.input.focused = false
    }
    this.tui.requestRender()
  }

  private async clearGoal(): Promise<void> {
    this.saving = true
    const ok = await this.controller.clearGoal()
    this.saving = false
    if (ok) this.close()
    this.tui.requestRender()
  }

  invalidate(): void { this.input.invalidate() }
}
