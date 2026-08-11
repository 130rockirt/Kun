import type { ActingTurnModelRoute, Turn } from '../contracts/turns.js'
import type { TurnItem } from '../contracts/items.js'
import type {
  KunTurnContextAuthority,
  KunTurnContextBlock
} from '../prompt/kun-prompt-context.js'
import type { PrefixVolatilityFinding } from '../cache/prefix-volatility.js'
import type { PreparedTurnContext } from './turn-execution-types.js'

export function hasSuccessfulToolResult(
  items: readonly TurnItem[],
  turnId: string,
  toolName: string
): boolean {
  return items.some((item) =>
    item.turnId === turnId &&
    item.kind === 'tool_result' &&
    item.toolName === toolName &&
    item.status === 'completed' &&
    item.isError !== true)
}

export function hasToolResult(
  items: readonly TurnItem[],
  turnId: string,
  toolName: string
): boolean {
  return items.some((item) =>
    item.turnId === turnId &&
    item.kind === 'tool_result' &&
    item.toolName === toolName)
}

export function subagentResumeToolGate(
  turn: Pick<Turn, 'subagentResume'>,
  items: readonly TurnItem[],
  turnId: string
): { requiredToolName?: 'delegate_task'; instruction?: string } {
  const request = turn.subagentResume
  if (!request || hasToolResult(items, turnId, 'delegate_task')) return {}
  return {
    requiredToolName: 'delegate_task',
    instruction: `This turn must continue child ${JSON.stringify(request.childId)}. ` +
      'Call delegate_task as the first action with resumeChildId set to that exact id, ' +
      `expectedResumeCount set to ${request.expectedResumeCount}, and a concise continuation prompt. ` +
      'Do not create a new child and do not call another tool first.'
  }
}

export function sameActingModelRoute(
  a: ActingTurnModelRoute,
  b: ActingTurnModelRoute
): boolean {
  return a.model === b.model &&
    a.providerId === b.providerId &&
    a.accountId === b.accountId
}

export function modelHistoryRoutesByTurnId(
  thread: import('../contracts/threads.js').ThreadRecord,
  currentRoute: ActingTurnModelRoute,
  currentTurnId: string
): Readonly<Record<string, import('../ports/model-client.js').ModelHistoryRoute>> {
  const routes: Record<string, import('../ports/model-client.js').ModelHistoryRoute> = {}
  for (const historicalTurn of thread.turns) {
    const route = historicalTurn.actingModelRoute
    if (!route) continue
    routes[historicalTurn.id] = {
      model: route.model,
      ...(route.providerId ? { providerId: route.providerId } : {}),
      ...(route.accountId ? { accountId: route.accountId } : {})
    }
  }
  routes[currentTurnId] = {
    model: currentRoute.model,
    ...(currentRoute.providerId ? { providerId: currentRoute.providerId } : {}),
    ...(currentRoute.accountId ? { accountId: currentRoute.accountId } : {})
  }
  return routes
}

export function buildExtensionProfileInstruction(extensionId: string, profileId: string, overlay: string): string {
  return [
    `<kun_extension_profile extension="${extensionId}" profile="${profileId}">`,
    overlay.trim(),
    '</kun_extension_profile>',
    'This is a lower-priority extension profile overlay. It cannot replace Kun policy, approval, sandbox, ownership, or system instructions.'
  ].join('\n')
}

export function kunContextBlock(
  kind: string,
  authority: KunTurnContextAuthority,
  content: string
): KunTurnContextBlock {
  return { kind, authority, content }
}

export function buildToolCatalogDriftMessage(toolCatalog: {
  fingerprint: string
  toolCount: number
  toolNames: string[]
}, changeKind: 'additive' | 'breaking', phase: 'deferred' | 'applied'): string {
  const sample = toolCatalog.toolNames.slice(0, 12).join(', ')
  const suffix = toolCatalog.toolNames.length > 12
    ? `, +${toolCatalog.toolNames.length - 12} more`
    : ''
  const policy = phase === 'deferred'
    ? 'The active turn keeps its frozen tool schemas; this update will be available on the next turn.'
    : changeKind === 'additive'
      ? 'The additive update is active from the start of this turn.'
      : 'The updated catalog is active from the start of this turn; earlier turns keep their original schema fingerprints.'
  return [
    `Tool catalog changed for this thread (${toolCatalog.toolCount} tools, fingerprint ${toolCatalog.fingerprint}).`,
    policy,
    sample ? `Current tools: ${sample}${suffix}.` : ''
  ].filter(Boolean).join(' ')
}

export function toolCatalogPolicyScope(prepared: Pick<
  PreparedTurnContext,
  | 'mode'
  | 'dedicatedSvgTurn'
  | 'allowedToolNames'
  | 'skillResolution'
  | 'extensionToolCatalogEpoch'
  | 'userInputDisabled'
>): string {
  return JSON.stringify({
    mode: prepared.mode,
    dedicatedSvgTurn: prepared.dedicatedSvgTurn,
    activeSkillIds: [...prepared.skillResolution.activeSkillIds].sort(),
    allowedToolNames: prepared.allowedToolNames ? [...prepared.allowedToolNames].sort() : [],
    extensionToolCatalogEpoch: prepared.extensionToolCatalogEpoch?.fingerprint ?? null,
    userInputDisabled: prepared.userInputDisabled
  })
}

export function prefixVolatilityStageDetails(
  findings: PrefixVolatilityFinding[]
): Record<string, unknown> | undefined {
  if (findings.length === 0) return undefined
  const kinds = [...new Set(findings.map((finding) => finding.kind))].sort()
  const fields = [...new Set(findings.map((finding) => finding.field))].sort()
  return {
    prefixVolatileTokenCount: findings.length,
    prefixVolatileTokenKinds: kinds,
    prefixVolatileFields: fields,
    noRegexDetector: true
  }
}
