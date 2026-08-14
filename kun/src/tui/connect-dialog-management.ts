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
import { authenticationStrategy, connectionPresetForProfile, credentialAvailabilityLabel, connectionPresets, managementActions, type ConnectionPreset, type ConnectField, type ManagementAction } from './connect-common.js'
import { ConnectDialogBase } from './connect-dialog-base.js'
import { popupFrame } from './render-utils.js'
import { safeError } from './render-layout.js'

export abstract class ConnectDialogManagement extends ConnectDialogBase {
  protected override renderManagement(width: number): string[] {
    const management = this.management!
    const profile = management.profile
    if (management.mode === 'menu') {
      const actions = managementActions(profile, connectionPresetForProfile(profile))
      return pageFrame({
        path: ['KUN', 'Connect', profile.name],
        right: isModelConnectionProfileUsable(profile) ? 'Connected' : credentialAvailabilityLabel(profile),
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

  protected override handleManagementInput(data: string): void {
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
      const actions = managementActions(
        management.profile,
        connectionPresetForProfile(management.profile)
      )
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

  protected async beginManagementAction(action: ManagementAction['kind']): Promise<void> {
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
    } else if (action === 'reconnect') {
      const preset = connectionPresetForProfile(management.profile)
      if (!preset) {
        this.error = 'This connection has no current provider authentication preset.'
      } else {
        this.management = undefined
        this.choosePreset(preset)
      }
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

  protected async commitManagementInput(): Promise<void> {
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

  protected async disconnectManagedConnection(): Promise<void> {
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
}
