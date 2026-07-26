import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import {
  GRAPH_CONTRACT_VERSION,
  GraphAgentRoutingRequestV1Schema,
  GraphAgentScoreV1Schema,
  GraphRiskClassSchema,
  type GraphAgentEvidenceV1,
  type GraphAgentLifecycle,
  type GraphAgentProfileVersionV1,
  type GraphAgentRoutingRequestV1,
  type GraphAgentScoreV1,
  type GraphGovernanceAuditV1
} from '../contracts/index.js'

const execFileAsync = promisify(execFile)

export function upsertScore(scores: GraphAgentScoreV1[], score: GraphAgentScoreV1): void {
  const index = scores.findIndex((entry) =>
    entry.profileId === score.profileId &&
    entry.profileVersion === score.profileVersion)
  if (index >= 0) scores[index] = score
  else scores.push(score)
}

export function baselineRatingRequest(
  projectId: string,
  profile: GraphAgentProfileVersionV1
): GraphAgentRoutingRequestV1 {
  return GraphAgentRoutingRequestV1Schema.parse({
    version: GRAPH_CONTRACT_VERSION,
    projectId,
    taskType: profile.capabilities.taskTypes[0],
    query: [
      profile.name,
      profile.description,
      ...profile.capabilities.taskTypes,
      ...profile.capabilities.capabilityTags
    ].join(' '),
    riskClass: 'low',
    requiredTools: [],
    requiredSkills: [],
    requiredMcpServers: [],
    readScopes: [],
    writeScopes: [],
    networkRequired: false,
    modelCapabilityTags: []
  })
}

export function scoreProfile(
  profile: GraphAgentProfileVersionV1,
  request: GraphAgentRoutingRequestV1,
  evidence: readonly GraphAgentEvidenceV1[],
  currentLoad: number,
  now: string
): GraphAgentScoreV1 {
  const taskFit = lexicalTaskFit(profile, request)
  const performanceEvidence = evidence.filter((item) => item.source !== 'missed_opportunity')
  const quality = performanceEvidence.length
    ? performanceEvidence.reduce((sum, item) => sum + item.quality, 0) /
      performanceEvidence.length
    : profile.origin === 'builtin' || profile.origin === 'user' ? 0.65 : 0.5
  const positives = performanceEvidence.filter((item) => item.outcome === 'positive').length
  const negatives = performanceEvidence.filter((item) => item.outcome === 'negative').length
  const trustEvidence = (positives + 1) / (positives + negatives + 2)
  const lifecycleTrust: Record<GraphAgentLifecycle, number> = {
    candidate: 0.15,
    probation: 0.45,
    trusted: 0.9,
    dormant: 0.55,
    archived: 0,
    deleted: 0
  }
  const trust = clamp01(trustEvidence * 0.55 + lifecycleTrust[profile.lifecycle] * 0.45)
  const latestEvidenceAt = evidence.reduce(
    (latest, item) => item.createdAt > latest ? item.createdAt : latest,
    profile.createdAt
  )
  const ageDays = Math.max(0, Date.parse(now) - Date.parse(latestEvidenceAt)) / 86_400_000
  const freshness = clamp01(Math.exp(-ageDays / 180))
  const avgTokens = performanceEvidence.length
    ? performanceEvidence.reduce((sum, item) => sum + item.costTokens, 0) /
      performanceEvidence.length
    : 20_000
  const avgLatency = performanceEvidence.length
    ? performanceEvidence.reduce((sum, item) => sum + item.latencyMs, 0) /
      performanceEvidence.length
    : 60_000
  const efficiency = clamp01(
    0.5 * (1 / (1 + avgTokens / 100_000)) +
    0.5 * (1 / (1 + avgLatency / 600_000))
  )
  const confidence = clamp01(1 - Math.exp(-evidence.length / 5))
  const availability = 1
  const load = clamp01(1 / (1 + Math.max(0, currentLoad)))
  const missedOpportunities = evidence.filter((item) =>
    item.source === 'missed_opportunity' &&
    item.eligible &&
    item.recalled &&
    !item.selected).length
  const missedOpportunityPenalty = Math.min(0.3, missedOpportunities * 0.015)
  const aggregate = clamp01(
    taskFit * 0.32 +
    quality * 0.22 +
    trust * 0.14 +
    freshness * 0.08 +
    efficiency * 0.08 +
    confidence * 0.10 +
    availability * 0.03 +
    load * 0.03 -
    missedOpportunityPenalty
  )
  return GraphAgentScoreV1Schema.parse({
    version: GRAPH_CONTRACT_VERSION,
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    taskFit,
    quality,
    trust,
    freshness,
    efficiency,
    confidence,
    availability,
    load,
    aggregate,
    evidenceCount: evidence.length,
    missedOpportunities,
    computedAt: now
  })
}

export function ineligibilityReason(
  profile: GraphAgentProfileVersionV1,
  request: GraphAgentRoutingRequestV1
): string | undefined {
  if (!['probation', 'trusted'].includes(profile.lifecycle)) {
    return `lifecycle ${profile.lifecycle} is not execution eligible`
  }
  if (
    profile.lifecycle === 'probation' &&
    (
      request.riskClass !== 'low' ||
      request.networkRequired ||
      request.writeScopes.length > 0
    )
  ) {
    return 'probation profiles are restricted to low-risk read-only evaluation'
  }
  if (riskRank(request.riskClass) > riskRank(profile.capabilities.maximumRiskClass)) {
    return `risk ${request.riskClass} exceeds profile maximum`
  }
  if (request.taskType && !profile.capabilities.taskTypes.includes(request.taskType)) {
    return `task type ${request.taskType} is outside the profile specialization`
  }
  const missingModelCapability = request.modelCapabilityTags.find((tag) =>
    !profile.capabilities.capabilityTags.includes(tag))
  if (missingModelCapability) {
    return `required model capability ${missingModelCapability} is unavailable`
  }
  if (request.networkRequired && !profile.capabilities.networkAllowed) {
    return 'task requires network access'
  }
  if (request.writeScopes.length && profile.capabilities.sandboxMode === 'read-only') {
    return 'task requires writes but profile is read-only'
  }
  for (const [required, allowed, blocked, label] of [
    [request.requiredTools, profile.capabilities.allowedTools, profile.capabilities.blockedTools, 'tool'],
    [request.requiredSkills, profile.capabilities.allowedSkills, profile.capabilities.blockedSkills, 'skill'],
    [request.requiredMcpServers, profile.capabilities.allowedMcpServers, profile.capabilities.blockedMcpServers, 'MCP server']
  ] as const) {
    const denied = required.find((item) => !allowed.includes(item) || blocked.includes(item))
    if (denied) return `required ${label} ${denied} is outside the profile authority`
  }
  if (!scopesCovered(request.readScopes, profile.capabilities.readScopes)) {
    return 'required read scope is outside profile authority'
  }
  if (!scopesCovered(request.writeScopes, profile.capabilities.writeScopes)) {
    return 'required write scope is outside profile authority'
  }
  return undefined
}

function lexicalTaskFit(
  profile: GraphAgentProfileVersionV1,
  request: GraphAgentRoutingRequestV1
): number {
  const query = tokenize([
    request.query,
    request.taskType ?? '',
    ...request.modelCapabilityTags
  ].join(' '))
  const document = tokenize([
    profile.name,
    profile.description,
    ...profile.capabilities.taskTypes,
    ...profile.capabilities.capabilityTags
  ].join(' '))
  if (!query.size || !document.size) return 0
  let overlap = 0
  for (const token of query) if (document.has(token)) overlap += 1
  const union = new Set([...query, ...document]).size
  const jaccard = overlap / Math.max(1, union)
  const taskTypeBonus = request.taskType &&
    profile.capabilities.taskTypes.includes(request.taskType) ? 0.4 : 0
  return clamp01(jaccard * 1.8 + taskTypeBonus)
}

function tokenize(value: string): Set<string> {
  const normalized = value.toLowerCase()
  const tokens = normalized.match(/[\p{L}\p{N}_-]{2,}/gu) ?? []
  return new Set(tokens)
}

function scopesCovered(required: readonly string[], allowed: readonly string[]): boolean {
  return required.every((scope) => allowed.some((parent) =>
    parent === '.' ||
    scope === parent ||
    scope.startsWith(`${parent.replace(/\/+$/, '')}/`)))
}

export function latestProfiles(
  profiles: readonly GraphAgentProfileVersionV1[]
): GraphAgentProfileVersionV1[] {
  const latest = new Map<string, GraphAgentProfileVersionV1>()
  for (const profile of profiles) {
    const current = latest.get(profile.profileId)
    if (!current || profile.profileVersion > current.profileVersion) {
      latest.set(profile.profileId, profile)
    }
  }
  return [...latest.values()]
}

export function assertLifecycleTransition(
  from: GraphAgentLifecycle,
  to: GraphAgentLifecycle
): void {
  const allowed: Record<GraphAgentLifecycle, readonly GraphAgentLifecycle[]> = {
    candidate: ['probation', 'archived', 'deleted'],
    probation: ['trusted', 'candidate', 'archived', 'deleted'],
    trusted: ['probation', 'dormant', 'archived', 'deleted'],
    dormant: ['trusted', 'archived', 'deleted'],
    archived: ['candidate', 'probation', 'trusted', 'dormant', 'deleted'],
    deleted: []
  }
  if (from === to) return
  if (!allowed[from].includes(to)) {
    throw new Error(`illegal profile lifecycle transition ${from} -> ${to}`)
  }
}

export function lifecycleRank(lifecycle: GraphAgentLifecycle): number {
  return {
    deleted: 0,
    archived: 1,
    dormant: 2,
    candidate: 3,
    probation: 4,
    trusted: 5
  }[lifecycle]
}

export function lifecycleAction(
  from: GraphAgentLifecycle,
  to: GraphAgentLifecycle
): GraphGovernanceAuditV1['action'] {
  if ((from === 'archived' || from === 'dormant') && !['archived', 'deleted'].includes(to)) {
    return 'restore'
  }
  if (to === 'trusted') return 'promote'
  if (to === 'dormant') return 'disable'
  if (to === 'probation' || to === 'candidate') return 'demote'
  if (to === 'archived') return 'archive'
  if (to === 'deleted') return 'delete'
  return 'restore'
}

export function mergeCapabilities(
  profiles: readonly GraphAgentProfileVersionV1[]
): GraphAgentProfileVersionV1['capabilities'] {
  const capabilities = profiles.map((profile) => profile.capabilities)
  const riskOrder = ['low', 'medium', 'high', 'critical'] as const
  const sandboxOrder = [
    'read-only',
    'external-sandbox',
    'workspace-write',
    'danger-full-access'
  ] as const
  const approvalOrder = ['never', 'always', 'untrusted', 'on-request', 'suggest', 'auto'] as const
  return {
    taskTypes: unionValues(capabilities.map((entry) => entry.taskTypes)),
    capabilityTags: unionValues(capabilities.map((entry) => entry.capabilityTags)),
    toolPolicy: capabilities.some((entry) => entry.toolPolicy === 'readOnly')
      ? 'readOnly'
      : 'inherit',
    allowedTools: intersectValues(capabilities.map((entry) => entry.allowedTools)),
    blockedTools: unionValues(capabilities.map((entry) => entry.blockedTools)),
    allowedSkills: intersectValues(capabilities.map((entry) => entry.allowedSkills)),
    blockedSkills: unionValues(capabilities.map((entry) => entry.blockedSkills)),
    allowedMcpServers: intersectValues(capabilities.map((entry) => entry.allowedMcpServers)),
    blockedMcpServers: unionValues(capabilities.map((entry) => entry.blockedMcpServers)),
    approvalPolicy: approvalOrder[Math.min(...capabilities.map((entry) =>
      approvalOrder.indexOf(entry.approvalPolicy)))]!,
    sandboxMode: sandboxOrder[Math.min(...capabilities.map((entry) =>
      sandboxOrder.indexOf(entry.sandboxMode)))]!,
    readScopes: intersectScopes(capabilities.map((entry) => entry.readScopes)),
    writeScopes: intersectScopes(capabilities.map((entry) => entry.writeScopes)),
    networkAllowed: capabilities.every((entry) => entry.networkAllowed),
    maximumRiskClass: riskOrder[Math.min(...capabilities.map((entry) =>
      riskOrder.indexOf(entry.maximumRiskClass)))]!
  }
}

function intersectValues(values: readonly string[][]): string[] {
  if (!values.length) return []
  return [...new Set(values[0])].filter((item) =>
    values.every((group) => group.includes(item))).sort()
}

function unionValues(values: readonly string[][]): string[] {
  return [...new Set(values.flat())].sort()
}

function intersectScopes(values: readonly string[][]): string[] {
  if (!values.length) return []
  const candidates = [...new Set(values.flat())]
  return candidates.filter((candidate) =>
    values.every((scopes) => scopes.some((scope) =>
      scope === '.' ||
      scope === candidate ||
      candidate.startsWith(`${scope.replace(/\/+$/, '')}/`))))
    .sort()
}

function riskRank(risk: z.infer<typeof GraphRiskClassSchema>): number {
  return { low: 0, medium: 1, high: 2, critical: 3 }[risk]
}

export async function canonicalPath(input: string): Promise<string> {
  const absolute = resolve(input)
  return realpath(absolute).catch(() => absolute)
}

export async function gitValue(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 64 * 1024
    })
    return result.stdout.trim() || undefined
  } catch {
    return undefined
  }
}

export function normalizeRemoteIdentity(remote: string): string {
  const trimmed = remote.trim()
  const scpLike = trimmed.match(/^(?:[^@]+@)?([^:]+):(.+)$/)
  if (scpLike && !trimmed.includes('://')) {
    return `${scpLike[1].toLowerCase()}/${stripGitSuffix(scpLike[2])}`
  }
  try {
    const url = new URL(trimmed)
    return `${url.hostname.toLowerCase()}${stripGitSuffix(url.pathname)}`
  } catch {
    return stripGitSuffix(trimmed.replace(/^[^@]+@/, ''))
  }
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git\/?$/, '').replace(/^\/+|\/+$/g, '')
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}
