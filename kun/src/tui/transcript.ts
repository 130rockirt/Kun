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
import { EXPLORE_GROUP_PREFIX, KUN_REPLY_GROUP_PREFIX, deriveExplorationStages, isKunReplyItem, type ExplorationStage } from './transcript-exploration.js'
import { ApprovalReviewComponent, ExplorationGroupComponent, ItemComponent } from './transcript-items.js'
import { ChildRunComponent, ChildRunGroupComponent } from './subagent-components.js'
import { childIdFromToolResult, resolveReasoningEndAt } from './render-utils.js'

export class TranscriptComponent implements Component {
  private order: string[] = []
  private readonly items = new Map<string, ItemComponent>()
  private readonly approvalReviews = new Map<string, ApprovalReviewComponent>()
  private readonly children = new Map<string, ChildRunComponent>()
  private readonly childGroups = new Map<string, ChildRunGroupComponent>()
  private readonly explorationGroups = new Map<string, ExplorationGroupComponent>()
  private readonly reasoningOverrides = new Map<string, boolean>()
  private showReasoning = false
  private projection?: ThreadProjection
  private renderedChildRows: Array<{ start: number; end: number; child: ProjectedChildRun }> = []
  private renderedReasoningRows: Array<{ row: number; itemId: string }> = []

  update(
    projection: ThreadProjection | undefined,
    showReasoning: boolean,
    showToolDetails: boolean,
    legacyGui = false,
    attachmentMetadata: Readonly<Record<string, AttachmentMetadata>> = {}
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
    const attachmentIdsByTurn = new Map(
      (projection?.thread.turns ?? []).map((turn) => [turn.id, turn.attachmentIds] as const)
    )
    const visible = all.filter((item) => item.kind !== 'tool_result' || !toolCalls.has(item.callId))
    const explorationStages = deriveExplorationStages(
      visible,
      toolResults,
      projection?.runningTurnId
    )
    const explorationGroupIds = new Set(explorationStages.map((stage) => stage.id))
    for (const id of this.explorationGroups.keys()) {
      if (!explorationGroupIds.has(id)) this.explorationGroups.delete(id)
    }
    for (const stage of explorationStages) {
      const current = this.explorationGroups.get(stage.id)
      if (current) current.update(stage, showToolDetails, showReasoning)
      else this.explorationGroups.set(
        stage.id,
        new ExplorationGroupComponent(stage, showToolDetails, showReasoning)
      )
    }
    const explorationGroupAfterItem = new Map(
      explorationStages.map((stage) => [stage.insertAfterItemId, stage.id] as const)
    )
    const groupedExplorationItemIds = new Set(
      explorationStages.flatMap((stage) => stage.timeline.map((entry) =>
        entry.kind === 'reasoning' ? entry.item.id : entry.entry.call.id
      ))
    )
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
      const userAttachmentIds = item.kind === 'user_message'
        ? item.attachmentIds?.length
          ? item.attachmentIds
          : attachmentIdsByTurn.get(item.turnId) ?? []
        : []
      if (current?.kind === item.kind) {
        current.update(
          item,
          itemShowReasoning,
          showToolDetails,
          result,
          turnRunning,
          legacyGui,
          reasoningRunning,
          reasoningEndedAt,
          attachmentMetadata,
          userAttachmentIds
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
          reasoningEndedAt,
          attachmentMetadata,
          userAttachmentIds
        ))
      }
    }

    const reviewIds = new Set(
      (projection?.approvalReviews ?? []).map((review) => `approval-review:${review.reviewId}`)
    )
    for (const id of this.approvalReviews.keys()) {
      if (!reviewIds.has(id)) this.approvalReviews.delete(id)
    }
    for (const review of projection?.approvalReviews ?? []) {
      const id = `approval-review:${review.reviewId}`
      const current = this.approvalReviews.get(id)
      if (current) current.update(review)
      else this.approvalReviews.set(id, new ApprovalReviewComponent(review))
    }

    const childRunsByTurn = new Map<string, ProjectedChildRun[]>()
    for (const child of projection?.childRuns ?? []) {
      const current = childRunsByTurn.get(child.parentTurnId) ?? []
      current.push(child)
      childRunsByTurn.set(child.parentTurnId, current)
    }
    const childIds = new Set((projection?.childRuns ?? []).map((run) => `child:${run.childId}`))
    for (const id of this.children.keys()) if (!childIds.has(id)) this.children.delete(id)
    for (const child of projection?.childRuns ?? []) {
      const id = `child:${child.childId}`
      const current = this.children.get(id)
      if (current) current.update(child, showToolDetails)
      else this.children.set(id, new ChildRunComponent(child, showToolDetails))
    }
    const groupIds = new Set(
      [...childRunsByTurn.entries()]
        .filter(([, children]) => children.length > 1)
        .map(([turnId]) => `child-group:${turnId}`)
    )
    for (const id of this.childGroups.keys()) if (!groupIds.has(id)) this.childGroups.delete(id)
    for (const [turnId, children] of childRunsByTurn) {
      if (children.length < 2) continue
      const id = `child-group:${turnId}`
      const current = this.childGroups.get(id)
      if (current) current.update(children, showToolDetails)
      else this.childGroups.set(id, new ChildRunGroupComponent(children, showToolDetails))
    }

    const placedChildren = new Set<string>()
    const labeledTurns = new Set<string>()
    const order: string[] = []
    const lastDelegationItemByTurn = new Map<string, string>()
    for (const item of visible) {
      if (item.kind === 'tool_call' && item.toolName === 'delegate_task') {
        lastDelegationItemByTurn.set(item.turnId, item.id)
      }
    }
    const addKunReplyLabel = (turnId: string): void => {
      if (labeledTurns.has(turnId)) return
      labeledTurns.add(turnId)
      order.push(`${KUN_REPLY_GROUP_PREFIX}${turnId}`)
    }
    for (const item of visible) {
      if (isKunReplyItem(item)) addKunReplyLabel(item.turnId)
      if (!groupedExplorationItemIds.has(item.id)) order.push(item.id)
      if (item.kind !== 'tool_call' || item.toolName !== 'delegate_task') continue
      const groupedChildren = childRunsByTurn.get(item.turnId) ?? []
      if (groupedChildren.length > 1) {
        if (lastDelegationItemByTurn.get(item.turnId) === item.id) {
          addKunReplyLabel(item.turnId)
          order.push(`child-group:${item.turnId}`)
          for (const child of groupedChildren) placedChildren.add(`child:${child.childId}`)
        }
        continue
      }
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
    for (const [itemId, groupId] of explorationGroupAfterItem) {
      const itemIndex = order.indexOf(itemId)
      if (itemIndex >= 0) {
        order.splice(itemIndex + 1, 0, groupId)
        continue
      }
      const lastGroupedItemId = explorationStages
        .find((stage) => stage.id === groupId)
        ?.insertAfterItemId
      const groupedItemIndex = lastGroupedItemId
        ? visible.findIndex((item) => item.id === lastGroupedItemId)
        : -1
      if (groupedItemIndex < 0) continue
      const nextVisibleId = visible.slice(groupedItemIndex + 1)
        .map((item) => item.id)
        .find((id) => order.includes(id))
      const nextOrderIndex = nextVisibleId ? order.indexOf(nextVisibleId) : -1
      if (nextOrderIndex >= 0) order.splice(nextOrderIndex, 0, groupId)
      else order.push(groupId)
    }
    for (const id of childIds) {
      if (placedChildren.has(id)) continue
      const child = this.children.get(id)?.value
      if (child) addKunReplyLabel(child.parentTurnId)
      const siblings = child ? childRunsByTurn.get(child.parentTurnId) ?? [] : []
      if (child && siblings.length > 1) {
        const groupId = `child-group:${child.parentTurnId}`
        if (!order.includes(groupId)) order.push(groupId)
        for (const sibling of siblings) placedChildren.add(`child:${sibling.childId}`)
      } else {
        order.push(id)
      }
    }
    const reviews = [...(projection?.approvalReviews ?? [])]
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    const placedReviewIdsByTurn = new Map<string, string[]>()
    for (const review of reviews) {
      const id = `approval-review:${review.reviewId}`
      if (!review.turnId) {
        order.push(id)
        continue
      }
      addKunReplyLabel(review.turnId)
      const nextItem = visible.find((item) =>
        item.turnId === review.turnId &&
        item.createdAt > review.startedAt &&
        order.includes(item.id)
      )
      if (nextItem) {
        order.splice(order.indexOf(nextItem.id), 0, id)
      } else {
        const turnOrderIds = [
          ...visible.filter((item) => item.turnId === review.turnId).map((item) => item.id),
          ...(placedReviewIdsByTurn.get(review.turnId) ?? [])
        ]
        const lastTurnIndex = turnOrderIds.reduce(
          (latest, candidate) => Math.max(latest, order.lastIndexOf(candidate)),
          -1
        )
        if (lastTurnIndex >= 0) order.splice(lastTurnIndex + 1, 0, id)
        else order.push(id)
      }
      const placed = placedReviewIdsByTurn.get(review.turnId) ?? []
      placed.push(id)
      placedReviewIdsByTurn.set(review.turnId, placed)
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
        : id.startsWith(EXPLORE_GROUP_PREFIX)
          ? this.explorationGroups.get(id)?.render(width, animationFrame) ?? []
        : id.startsWith('child-group:')
          ? this.childGroups.get(id)?.render(width, animationFrame) ?? []
        : id.startsWith('child:')
          ? this.children.get(id)?.render(width, animationFrame) ?? []
          : id.startsWith('approval-review:')
            ? this.approvalReviews.get(id)?.render(width, animationFrame) ?? []
          : this.items.get(id)?.render(width, animationFrame) ?? []
      const kind = replyGroup
        ? 'kun_reply'
        : id.startsWith(EXPLORE_GROUP_PREFIX)
          ? 'exploration_group'
        : id.startsWith('child-group:')
          ? 'child_group'
        : id.startsWith('child:')
          ? 'child'
          : id.startsWith('approval-review:')
            ? 'approval_review'
          : this.items.get(id)?.kind
      const compact = kind === 'child' || kind === 'child_group' || kind === 'assistant_text' ||
        kind === 'assistant_reasoning' || kind === 'tool_call' ||
        kind === 'tool_result' || kind === 'approval' ||
        kind === 'user_input' || kind === 'review' || kind === 'error' ||
        kind === 'approval_review' || kind === 'compaction' || kind === 'exploration_group'
      if (index !== 0 && !compact) lines.push('')
      const start = lines.length
      lines.push(...rendered)
      if (kind === 'assistant_reasoning' && rendered.length) {
        this.renderedReasoningRows.push({ row: start, itemId: id })
      }
      if (id.startsWith('child:') && rendered.length) {
        const child = this.children.get(id)?.value
        if (child) this.renderedChildRows.push({ start, end: lines.length - 1, child })
      } else if (id.startsWith('child-group:') && rendered.length) {
        for (const entry of this.childGroups.get(id)?.childRows() ?? []) {
          this.renderedChildRows.push({
            start: start + entry.start,
            end: start + entry.end,
            child: entry.child
          })
        }
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
    for (const review of this.approvalReviews.values()) review.invalidate()
  }
}
