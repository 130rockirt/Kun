import { createHash } from 'node:crypto'
import {
  GRAPH_CONTRACT_VERSION,
  GraphLearningCandidateV1Schema,
  type GraphAgentCapabilitiesV1,
  type GraphEpisodeV1,
  type GraphLearningCandidateV1,
  type GraphRunV1,
  type ProjectIdentityV1
} from '../contracts/index.js'
import { graphHostRelativePathCovers } from './graph-platform-path.js'

export function successfulClusters(
  episodes: readonly GraphEpisodeV1[],
  minimumDistinctSessions: number,
  minimumVerifiedEpisodes: number
): GraphEpisodeV1[][] {
  const groups = new Map<string, GraphEpisodeV1[]>()
  for (const episode of episodes) {
    if (episode.outcome !== 'completed') continue
    const key = [
      episode.graphShapeFingerprint,
      ...episode.assignments
        .filter((assignment) => assignment.outcome === 'accepted')
        .map((assignment) => `${assignment.nodeKind}:${assignment.profileName}`)
        .sort()
    ].join('|')
    const group = groups.get(key) ?? []
    group.push(episode)
    groups.set(key, group)
  }
  return [...groups.values()].filter((group) =>
    group.length >= minimumVerifiedEpisodes &&
    new Set(group.map((episode) => episode.threadIdHash)).size >= minimumDistinctSessions)
}

function buildCandidate(
  identity: ProjectIdentityV1,
  episodes: readonly GraphEpisodeV1[],
  candidateId: string,
  now: string,
  kind: GraphLearningCandidateV1['kind']
): GraphLearningCandidateV1 {
  const assignments = episodes.flatMap((episode) =>
    episode.assignments.filter((assignment) => assignment.outcome === 'accepted'))
  const dominant = mode(assignments.map((assignment) => assignment.profileName)) ?? 'Project Specialist'
  const capabilities = leastPrivilegeCapabilities(
    assignments.filter((assignment) => assignment.profileName === dominant)
  )
  const profileId = `learned_${slug(dominant)}_${hash(
    episodes.map((episode) => episode.graphShapeFingerprint).join('|')
  ).slice(0, 8)}`
  return GraphLearningCandidateV1Schema.parse({
    version: GRAPH_CONTRACT_VERSION,
    candidateId,
    projectId: identity.projectId,
    kind,
    status: 'draft',
    name: `${dominant} (${kind.replace('_', ' ')})`,
    summary: `Repeated successful pattern observed in ${episodes.length} verified episodes across ${new Set(episodes.map((episode) => episode.threadIdHash)).size} sessions.`,
    draft: {
      profileId,
      systemPrompt: [
        'You are a project-scoped specialist for the frozen candidate capabilities.',
        'Follow the assigned objective and acceptance criteria.',
        'Return concise, verifiable evidence. Never delegate or expand permissions.'
      ].join(' '),
      sourceGraphShape: episodes[0]!.graphShapeFingerprint,
      exampleRoleSummaries: [...new Set(assignments.map((assignment) =>
        assignment.roleSummary))].slice(0, 8)
    },
    ...(kind === 'agent_profile' ? { requestedCapabilities: capabilities } : {}),
    provenanceEpisodeIds: episodes.map((episode) => episode.episodeId),
    evaluationPlan: [
      'Run only on low-risk measurable tasks during probation.',
      'Require deterministic or independent review.',
      'Compare quality, retries, latency, and token cost with the prior route.',
      'Promote only after the configured number of independently accepted runs.'
    ],
    rollback: {
      instructions: 'Archive the learned profile and restore its prior routing version.'
    },
    createdAt: now,
    updatedAt: now
  })
}

export function buildCandidates(
  identity: ProjectIdentityV1,
  episodes: readonly GraphEpisodeV1[],
  nextCandidateId: (kind: GraphLearningCandidateV1['kind']) => string,
  now: string
): GraphLearningCandidateV1[] {
  const agent = buildCandidate(
    identity,
    episodes,
    nextCandidateId('agent_profile'),
    now,
    'agent_profile'
  )
  if (episodes.every((episode) => episode.assignments.length === 1)) return [agent]
  const reusableKind: GraphLearningCandidateV1['kind'] =
    episodes[0]!.assignments.length >= 3 ? 'graph_recipe' : 'skill'
  return [
    agent,
    buildCandidate(identity, episodes, nextCandidateId(reusableKind), now, reusableKind)
  ]
}

export function learningClusterFingerprint(
  projectId: string,
  episodes: readonly GraphEpisodeV1[]
): string {
  const representative = episodes[0]!
  return hash(JSON.stringify({
    projectId,
    graphShapeFingerprint: representative.graphShapeFingerprint,
    assignments: representative.assignments
      .filter((assignment) => assignment.outcome === 'accepted')
      .map((assignment) => ({
        nodeKind: assignment.nodeKind,
        profileName: assignment.profileName
      }))
      .sort((left, right) =>
        left.nodeKind.localeCompare(right.nodeKind) ||
        left.profileName.localeCompare(right.profileName))
  }))
}

function leastPrivilegeCapabilities(
  assignments: readonly GraphEpisodeV1['assignments'][number][]
): GraphAgentCapabilitiesV1 {
  const allReadOnly = assignments.every((assignment) => assignment.toolPolicy === 'readOnly')
  return {
    taskTypes: [...new Set(assignments.map((assignment) => assignment.nodeKind))],
    capabilityTags: [],
    toolPolicy: allReadOnly ? 'readOnly' : 'inherit',
    allowedTools: intersection(assignments.map((assignment) => assignment.allowedTools)),
    blockedTools: ['delegate_task', 'generate_subagent', 'graph_create_run', 'graph_agent_governance'],
    allowedSkills: intersection(assignments.map((assignment) => assignment.allowedSkills)),
    blockedSkills: [],
    allowedMcpServers: intersection(assignments.map((assignment) => assignment.allowedMcpServers)),
    blockedMcpServers: [],
    approvalPolicy: 'on-request',
    sandboxMode: assignments.some((assignment) => assignment.usedWriteScope)
      ? 'workspace-write'
      : 'read-only',
    readScopes: scopeIntersection(assignments.map((assignment) => assignment.readScopes)),
    writeScopes: scopeIntersection(assignments.map((assignment) => assignment.writeScopes)),
    networkAllowed: false,
    maximumRiskClass: 'low'
  }
}

function intersection(values: readonly string[][]): string[] {
  if (!values.length) return []
  return [...new Set(values[0])].filter((item) =>
    values.every((value) => value.includes(item))).sort()
}

function scopeIntersection(values: readonly string[][]): string[] {
  if (!values.length) return []
  const candidates = [...new Set(values.flat())]
  return candidates.filter((candidate) =>
    values.every((scopes) => scopes.some((scope) =>
      graphHostRelativePathCovers(scope, candidate))))
    .sort()
}

export function episodeNodeOutcome(
  status: GraphRunV1['nodes'][string]['status']
): GraphEpisodeV1['assignments'][number]['outcome'] {
  if (status === 'accepted') return 'accepted'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'skipped') return 'skipped'
  if (status === 'superseded') return 'superseded'
  return 'failed'
}

export function sanitize(value: string): string {
  return value
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi, '[REDACTED_PRIVATE_KEY]')
    .replace(/\b(?:sk|api|token|key)[-_][A-Za-z0-9_-]{16,}\b/gi, '[REDACTED_TOKEN]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi, 'Bearer [REDACTED]')
    .replace(
      /(password|secret|token|token[_-]?key|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[REDACTED]'
    )
}

export function normalizeFingerprintText(value: string): string {
  return sanitize(value).toLowerCase().replace(/\b\d+\b/g, '#').replace(/\s+/g, ' ').trim()
}

function mode(values: readonly string[]): string | undefined {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]
}

function slug(value: string): string {
  return value.toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'agent'
}

export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function isTerminal(status: GraphRunV1['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}
