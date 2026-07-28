import { readdir } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import {
  GRAPH_CONTRACT_VERSION,
  GraphAgentEvidenceV1Schema,
  GraphAgentProfileVersionV1Schema,
  GraphAgentRoutingExplanationV1Schema,
  GraphAgentRoutingRequestV1Schema,
  GraphAgentScoreV1Schema,
  GraphGovernanceAuditV1Schema,
  GraphLearningCandidateV1Schema,
  ProjectIdentityV1Schema,
  type GraphAgentEvidenceV1,
  type GraphAgentLifecycle,
  type GraphAgentProfileVersionV1,
  type GraphAgentRoutingExplanationV1,
  type GraphAgentRoutingRequestV1,
  type GraphAgentScoreV1,
  type GraphGovernanceAuditV1,
  type GraphLearningCandidateV1,
  type ProjectIdentityV1
} from '../contracts/index.js'
import {
  type ProjectAgentRegistryState
} from './project-agent-registry-state.js'
import {
  loadOrCreateProjectAgentRegistryState,
  loadProjectAgentRegistryState,
  persistProjectAgentRegistryState
} from './project-agent-registry-storage.js'
import {
  assertLifecycleTransition,
  baselineRatingRequest,
  canonicalPath,
  gitValue,
  ineligibilityReason,
  latestProfiles,
  lifecycleAction,
  lifecycleRank,
  mergeCapabilities,
  normalizeRemoteIdentity,
  scoreProfile,
  sha256,
  upsertScore
} from './project-agent-registry-policy.js'
import { graphPhysicalPathIdentity } from './graph-platform-path.js'

export { scoreProfile } from './project-agent-registry-policy.js'
import type {
  FileProjectAgentRegistryOptions,
  GraphAgentRouteResult,
  ProjectAgentRegistry
} from './project-agent-registry-types.js'

export type {
  FileProjectAgentRegistryOptions,
  GraphAgentRouteResult,
  ProjectAgentRegistry
} from './project-agent-registry-types.js'

export class FileProjectAgentRegistry implements ProjectAgentRegistry {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly nowIso: () => string
  private readonly nextId: (prefix: string) => string

  constructor(private readonly options: FileProjectAgentRegistryOptions) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString())
    let next = 0
    this.nextId = options.nextId ?? ((prefix) => `${prefix}_${Date.now()}_${++next}`)
  }

  async identify(workspaceRoot: string): Promise<ProjectIdentityV1> {
    const canonicalWorkspaceRoot = await canonicalPath(workspaceRoot)
    const gitCommonDirRaw = await gitValue(canonicalWorkspaceRoot, ['rev-parse', '--git-common-dir'])
    const gitCommonDir = gitCommonDirRaw
      ? await canonicalPath(isAbsolute(gitCommonDirRaw)
        ? gitCommonDirRaw
        : resolve(canonicalWorkspaceRoot, gitCommonDirRaw))
      : undefined
    const remote = await gitValue(canonicalWorkspaceRoot, ['config', '--get', 'remote.origin.url'])
    const normalizedRemote = remote ? normalizeRemoteIdentity(remote) : undefined
    const remoteIdentityHash = normalizedRemote ? sha256(normalizedRemote) : undefined
    const stableSource = remoteIdentityHash ?? graphPhysicalPathIdentity(
      gitCommonDir ?? canonicalWorkspaceRoot
    )
    return ProjectIdentityV1Schema.parse({
      version: GRAPH_CONTRACT_VERSION,
      projectId: `project_${sha256(stableSource).slice(0, 24)}`,
      canonicalWorkspaceRoot,
      ...(gitCommonDir ? { gitCommonDir } : {}),
      ...(remoteIdentityHash ? { remoteIdentityHash } : {}),
      source: remoteIdentityHash
        ? 'git_remote'
        : gitCommonDir
          ? 'git_common_dir'
          : 'workspace_root',
      resolvedAt: this.nowIso()
    })
  }

  async listProjectIdentities(): Promise<ProjectIdentityV1[]> {
    const entries = await readdir(this.options.rootDir, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    const identities = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name))
      .map(async (entry) => {
        const state = await this.load(entry.name).catch(() => null)
        return state?.identity
      }))
    return identities
      .filter((identity): identity is ProjectIdentityV1 => Boolean(identity))
      .sort((a, b) => a.projectId.localeCompare(b.projectId))
  }

  async listProfiles(
    projectId: string,
    includeArchived = false
  ): Promise<GraphAgentProfileVersionV1[]> {
    const state = await this.load(projectId)
    if (!state) return []
    const latest = latestProfiles(state.profiles)
    return latest
      .filter((profile) => includeArchived ||
        (profile.lifecycle !== 'archived' && profile.lifecycle !== 'deleted'))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async getProfile(
    projectId: string,
    profileId: string,
    version?: number
  ): Promise<GraphAgentProfileVersionV1 | null> {
    const state = await this.load(projectId)
    if (!state) return null
    const matches = state.profiles.filter((profile) =>
      profile.profileId === profileId &&
      (version === undefined || profile.profileVersion === version))
    const direct = matches.sort((a, b) => b.profileVersion - a.profileVersion)[0]
    if (
      version !== undefined ||
      (direct && !['archived', 'deleted'].includes(direct.lifecycle))
    ) return direct ?? null
    const alias = latestProfiles(state.profiles)
      .filter((profile) =>
        profile.aliasProfileIds?.includes(profileId) &&
        profile.lifecycle !== 'deleted')
      .sort((a, b) =>
        lifecycleRank(b.lifecycle) - lifecycleRank(a.lifecycle) ||
        b.profileVersion - a.profileVersion)[0]
    return alias ?? direct ?? null
  }

  saveProfile(
    identityInput: ProjectIdentityV1,
    profileInput: GraphAgentProfileVersionV1,
    reason: string,
    actor: GraphGovernanceAuditV1['actor'] = profileInput.createdBy
  ): Promise<GraphAgentProfileVersionV1> {
    const identity = ProjectIdentityV1Schema.parse(identityInput)
    const profile = GraphAgentProfileVersionV1Schema.parse(profileInput)
    return this.enqueue(identity.projectId, async () => {
      const state = await this.loadOrCreate(identity)
      const latest = state.profiles
        .filter((entry) => entry.profileId === profile.profileId)
        .sort((a, b) => b.profileVersion - a.profileVersion)[0]
      if (latest && profile.profileVersion !== latest.profileVersion + 1) {
        throw new Error(
          `profile ${profile.profileId} version must be ${latest.profileVersion + 1}`
        )
      }
      if (!latest && profile.profileVersion !== 1) {
        throw new Error(`new profile ${profile.profileId} must start at version 1`)
      }
      state.profiles.push(profile)
      state.audit.push(this.audit(identity.projectId, {
        action: 'create',
        targetKind: 'profile',
        targetId: profile.profileId,
        ...(latest ? { beforeHash: sha256(JSON.stringify(latest)) } : {}),
        afterHash: sha256(JSON.stringify(profile)),
        reason
      }, actor))
      await this.persist(state)
      return profile
    })
  }

  importProfile(
    identityInput: ProjectIdentityV1,
    profileInput: GraphAgentProfileVersionV1,
    reason: string
  ): Promise<GraphAgentProfileVersionV1> {
    const identity = ProjectIdentityV1Schema.parse(identityInput)
    const profile = GraphAgentProfileVersionV1Schema.parse(profileInput)
    return this.enqueue(identity.projectId, async () => {
      const state = await this.loadOrCreate(identity)
      const latest = latestProfiles(state.profiles)
        .find((entry) => entry.profileId === profile.profileId)
      const imported = GraphAgentProfileVersionV1Schema.parse({
        ...profile,
        profileVersion: (latest?.profileVersion ?? 0) + 1,
        origin: 'user',
        lifecycle: 'candidate',
        ...(latest
          ? {
              supersedesVersion: latest.profileVersion,
              rollbackVersion: latest.profileVersion
            }
          : {
              supersedesVersion: undefined,
              rollbackVersion: undefined
            }),
        createdAt: this.nowIso(),
        createdBy: 'user'
      })
      state.profiles.push(imported)
      state.audit.push(this.audit(identity.projectId, {
        action: 'import',
        targetKind: 'profile',
        targetId: imported.profileId,
        ...(latest ? { beforeHash: sha256(JSON.stringify(latest)) } : {}),
        afterHash: sha256(JSON.stringify(imported)),
        reason
      }, 'user'))
      await this.persist(state)
      return imported
    })
  }

  mergeProfiles(
    identityInput: ProjectIdentityV1,
    sourceProfileIdsInput: string[],
    targetProfileId: string,
    name: string,
    reason: string
  ): Promise<GraphAgentProfileVersionV1> {
    const identity = ProjectIdentityV1Schema.parse(identityInput)
    const sourceProfileIds = [...new Set(sourceProfileIdsInput)]
    if (sourceProfileIds.length < 2) {
      return Promise.reject(new Error('profile merge requires at least two distinct sources'))
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(targetProfileId)) {
      return Promise.reject(new Error('invalid merge target profile id'))
    }
    return this.enqueue(identity.projectId, async () => {
      const state = await this.loadOrCreate(identity)
      const latest = latestProfiles(state.profiles)
      const sources = sourceProfileIds.map((profileId) => {
        const profile = latest.find((entry) =>
          entry.profileId === profileId &&
          entry.lifecycle !== 'deleted')
        if (!profile) throw new Error(`merge source profile not found: ${profileId}`)
        return profile
      })
      const priorTarget = latest.find((entry) => entry.profileId === targetProfileId)
      const base = priorTarget ?? sources[0]!
      const merged = GraphAgentProfileVersionV1Schema.parse({
        ...base,
        profileId: targetProfileId,
        profileVersion: (priorTarget?.profileVersion ?? 0) + 1,
        origin: 'user',
        lifecycle: 'candidate',
        name: name.trim(),
        description: `Merged from ${sources.map((profile) => profile.name).join(', ')}.`,
        systemPrompt: [
          base.systemPrompt,
          'This profile was merged from independently governed project agents.',
          'Use only the frozen assignment authority and never infer broader permissions.'
        ].join('\n\n').slice(0, 32_768),
        capabilities: mergeCapabilities(sources),
        provenanceEpisodeIds: [...new Set(sources.flatMap((profile) =>
          profile.provenanceEpisodeIds))].slice(0, 1_000),
        aliasProfileIds: [...new Set(sources.flatMap((profile) => [
          profile.profileId,
          ...(profile.aliasProfileIds ?? [])
        ]))]
          .filter((profileId) => profileId !== targetProfileId)
          .slice(0, 1_000),
        ...(priorTarget
          ? {
              supersedesVersion: priorTarget.profileVersion,
              rollbackVersion: priorTarget.profileVersion
            }
          : {
              supersedesVersion: undefined,
              rollbackVersion: undefined
            }),
        createdAt: this.nowIso(),
        createdBy: 'user'
      })
      state.profiles.push(merged)
      for (const source of sources) {
        if (source.profileId === targetProfileId || source.lifecycle === 'archived') continue
        state.profiles.push(GraphAgentProfileVersionV1Schema.parse({
          ...source,
          profileVersion: source.profileVersion + 1,
          lifecycle: 'archived',
          supersedesVersion: source.profileVersion,
          rollbackVersion: source.profileVersion,
          createdAt: this.nowIso(),
          createdBy: 'user'
        }))
      }
      state.audit.push(this.audit(identity.projectId, {
        action: 'merge',
        targetKind: 'profile',
        targetId: targetProfileId,
        ...(priorTarget ? { beforeHash: sha256(JSON.stringify(priorTarget)) } : {}),
        afterHash: sha256(JSON.stringify(merged)),
        reason
      }, 'user'))
      await this.persist(state)
      return merged
    })
  }

  recordProfileExport(
    projectId: string,
    profileInput: GraphAgentProfileVersionV1
  ): Promise<void> {
    const profile = GraphAgentProfileVersionV1Schema.parse(profileInput)
    return this.enqueue(projectId, async () => {
      const state = await this.load(projectId)
      if (!state) throw new Error(`Graph project not found: ${projectId}`)
      if (profile.profileId !== (
        state.profiles.find((entry) =>
          entry.profileId === profile.profileId &&
          entry.profileVersion === profile.profileVersion)?.profileId
      )) {
        throw new Error(`project agent not found: ${profile.profileId}`)
      }
      state.audit.push(this.audit(projectId, {
        action: 'export',
        targetKind: 'profile',
        targetId: profile.profileId,
        beforeHash: sha256(JSON.stringify(profile)),
        afterHash: sha256(JSON.stringify(profile)),
        reason: `Exported immutable profile version ${profile.profileVersion}.`
      }, 'user'))
      await this.persist(state)
    })
  }

  recordEvidence(
    identityInput: ProjectIdentityV1,
    evidenceInput: GraphAgentEvidenceV1
  ): Promise<void> {
    const identity = ProjectIdentityV1Schema.parse(identityInput)
    const evidence = GraphAgentEvidenceV1Schema.parse(evidenceInput)
    return this.enqueue(identity.projectId, async () => {
      const state = await this.loadOrCreate(identity)
      if (!state.evidence.some((entry) => entry.evidenceId === evidence.evidenceId)) {
        state.evidence.push(evidence)
        await this.applyOpportunityLifecycle(state, evidence.profileId)
        const profile = latestProfiles(state.profiles).find((entry) =>
          entry.profileId === evidence.profileId)
        if (profile) {
          const score = scoreProfile(
            profile,
            baselineRatingRequest(identity.projectId, profile),
            state.evidence.filter((entry) => entry.profileId === profile.profileId),
            0,
            this.nowIso()
          )
          upsertScore(state.scores, score)
        }
        await this.persist(state)
      }
    })
  }

  async route(
    identityInput: ProjectIdentityV1,
    requestInput: GraphAgentRoutingRequestV1,
    loadByProfile: ReadonlyMap<string, number> = new Map()
  ): Promise<GraphAgentRouteResult> {
    const identity = ProjectIdentityV1Schema.parse(identityInput)
    const request = GraphAgentRoutingRequestV1Schema.parse(requestInput)
    if (request.projectId !== identity.projectId) throw new Error('routing project identity mismatch')
    return this.enqueue(identity.projectId, async () => {
      const state = await this.loadOrCreate(identity)
      const excluded: GraphAgentRoutingExplanationV1['excluded'] = []
      const scored: Array<{ profile: GraphAgentProfileVersionV1; score: GraphAgentScoreV1 }> = []
      for (const profile of latestProfiles(state.profiles)) {
        const exclusion = ineligibilityReason(profile, request)
        if (exclusion) {
          excluded.push({ profileId: profile.profileId, reason: exclusion })
          continue
        }
        if (profile.lifecycle === 'probation') {
          const ratio = this.options.config().routing.explorationRatio
          if (ratio <= 0 || !request.probationEligible) {
            excluded.push({
              profileId: profile.profileId,
              reason: ratio <= 0
                ? 'probation exploration is disabled'
                : 'task is not eligible for low-risk probation evaluation'
            })
            continue
          }
          const bucket = Number.parseInt(
            sha256(`${request.query}\n${profile.profileId}`).slice(0, 8),
            16
          ) / 0xffffffff
          if (bucket >= ratio) {
            excluded.push({
              profileId: profile.profileId,
              reason: 'probation profile was outside the configured exploration sample'
            })
            continue
          }
        }
        const score = scoreProfile(
          profile,
          request,
          state.evidence.filter((item) => item.profileId === profile.profileId),
          loadByProfile.get(profile.profileId) ?? 0,
          this.nowIso()
        )
        upsertScore(state.scores, score)
        if (score.taskFit < this.options.config().routing.minTaskFit) {
          excluded.push({
            profileId: profile.profileId,
            reason: `task fit ${score.taskFit.toFixed(3)} is below configured minimum`
          })
          continue
        }
        if (
          score.confidence < this.options.config().routing.minConfidence &&
          profile.origin === 'learned' &&
          profile.lifecycle !== 'probation'
        ) {
          excluded.push({
            profileId: profile.profileId,
            reason: `confidence ${score.confidence.toFixed(3)} is below configured minimum`
          })
          continue
        }
        scored.push({ profile, score })
      }
      scored.sort((a, b) =>
        b.score.aggregate - a.score.aggregate ||
        b.score.confidence - a.score.confidence ||
        a.profile.profileId.localeCompare(b.profile.profileId))
      const recalled = scored.slice(0, this.options.config().routing.recallLimit)
      const selected = recalled[0]
      const explanation = GraphAgentRoutingExplanationV1Schema.parse({
        version: GRAPH_CONTRACT_VERSION,
        request,
        excluded,
        recalled: recalled.map(({ profile, score }) => ({
          profileId: profile.profileId,
          profileVersion: profile.profileVersion,
          score
        })),
        ...(selected
          ? {
              selectedProfileId: selected.profile.profileId,
              selectedProfileVersion: selected.profile.profileVersion
            }
          : {}),
        selectionReason: selected
          ? `Selected ${selected.profile.name} after permission eligibility and evidence ranking (${selected.score.aggregate.toFixed(3)}).`
          : 'No eligible project agent satisfied the task and authority constraints.',
        createdAt: this.nowIso()
      })
      state.explanations.push(explanation)
      if (state.explanations.length > 10_000) state.explanations.splice(0, state.explanations.length - 10_000)
      await this.persist(state)
      return { profile: selected?.profile, explanation }
    })
  }

  transitionProfile(
    identityInput: ProjectIdentityV1,
    profileId: string,
    lifecycle: GraphAgentLifecycle,
    reason: string,
    actor: GraphGovernanceAuditV1['actor'] = 'system'
  ): Promise<GraphAgentProfileVersionV1> {
    const identity = ProjectIdentityV1Schema.parse(identityInput)
    return this.enqueue(identity.projectId, async () => {
      const state = await this.loadOrCreate(identity)
      const current = latestProfiles(state.profiles).find((profile) => profile.profileId === profileId)
      if (!current) throw new Error(`project agent not found: ${profileId}`)
      assertLifecycleTransition(current.lifecycle, lifecycle)
      const next = GraphAgentProfileVersionV1Schema.parse({
        ...current,
        profileVersion: current.profileVersion + 1,
        lifecycle,
        supersedesVersion: current.profileVersion,
        rollbackVersion: current.profileVersion,
        createdAt: this.nowIso(),
        createdBy: actor
      })
      state.profiles.push(next)
      state.audit.push(this.audit(identity.projectId, {
        action: lifecycleAction(current.lifecycle, lifecycle),
        targetKind: 'profile',
        targetId: profileId,
        beforeHash: sha256(JSON.stringify(current)),
        afterHash: sha256(JSON.stringify(next)),
        reason
      }, actor))
      await this.persist(state)
      return next
    })
  }

  async listEvidence(projectId: string, profileId?: string): Promise<GraphAgentEvidenceV1[]> {
    const state = await this.load(projectId)
    return (state?.evidence ?? [])
      .filter((entry) => !profileId || entry.profileId === profileId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async listScores(projectId: string): Promise<GraphAgentScoreV1[]> {
    return (await this.load(projectId))?.scores
      .slice()
      .sort((a, b) =>
        b.aggregate - a.aggregate ||
        a.profileId.localeCompare(b.profileId)) ?? []
  }

  async listExplanations(projectId: string): Promise<GraphAgentRoutingExplanationV1[]> {
    return (await this.load(projectId))?.explanations
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) ?? []
  }

  async listCandidates(projectId: string): Promise<GraphLearningCandidateV1[]> {
    return (await this.load(projectId))?.candidates
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) ?? []
  }

  saveCandidate(
    identityInput: ProjectIdentityV1,
    candidateInput: GraphLearningCandidateV1,
    reason: string,
    actor: GraphGovernanceAuditV1['actor'] = 'learning'
  ): Promise<void> {
    const identity = ProjectIdentityV1Schema.parse(identityInput)
    const candidate = GraphLearningCandidateV1Schema.parse(candidateInput)
    if (candidate.projectId !== identity.projectId) {
      return Promise.reject(new Error('candidate project identity mismatch'))
    }
    return this.enqueue(identity.projectId, async () => {
      const state = await this.loadOrCreate(identity)
      const index = state.candidates.findIndex((entry) => entry.candidateId === candidate.candidateId)
      const before = index >= 0 ? state.candidates[index] : undefined
      if (index >= 0) state.candidates[index] = candidate
      else state.candidates.push(candidate)
      state.audit.push(this.audit(identity.projectId, {
        action: candidate.status === 'approved'
          ? 'approve_candidate'
          : candidate.status === 'rejected'
            ? 'reject_candidate'
            : candidate.status === 'promoted'
              ? 'promote'
            : candidate.status === 'rolled_back'
              ? 'rollback_candidate'
              : candidate.status === 'deleted'
                ? 'delete'
                : candidate.status === 'merged'
                  ? 'merge'
              : 'create',
        targetKind: candidate.kind === 'skill'
          ? 'skill'
          : candidate.kind === 'graph_recipe'
            ? 'recipe'
            : 'candidate',
        targetId: candidate.candidateId,
        ...(before ? { beforeHash: sha256(JSON.stringify(before)) } : {}),
        afterHash: sha256(JSON.stringify(candidate)),
        reason
      }, actor))
      await this.persist(state)
    })
  }

  async listAudit(projectId: string): Promise<GraphGovernanceAuditV1[]> {
    return (await this.load(projectId))?.audit
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) ?? []
  }

  compactRetention(projectId: string): Promise<{ auditRemoved: number }> {
    return this.enqueue(projectId, async () => {
      const state = await this.load(projectId)
      if (!state) return { auditRemoved: 0 }
      const floor = Date.parse(this.nowIso()) -
        this.options.config().retention.auditDays * 86_400_000
      const latestByTarget = new Map<string, GraphGovernanceAuditV1>()
      for (const entry of state.audit) {
        const key = `${entry.targetKind}:${entry.targetId}`
        const current = latestByTarget.get(key)
        if (!current || entry.createdAt > current.createdAt) latestByTarget.set(key, entry)
      }
      const retainedIds = new Set([...latestByTarget.values()].map((entry) => entry.auditId))
      const before = state.audit.length
      state.audit = state.audit.filter((entry) =>
        retainedIds.has(entry.auditId) || Date.parse(entry.createdAt) >= floor)
      await this.persist(state)
      return { auditRemoved: before - state.audit.length }
    })
  }

  private async applyOpportunityLifecycle(
    state: ProjectAgentRegistryState,
    profileId: string
  ): Promise<void> {
    const current = latestProfiles(state.profiles).find((profile) => profile.profileId === profileId)
    if (!current || current.lifecycle !== 'trusted') return
    const missed = state.evidence.filter((entry) =>
      entry.profileId === profileId &&
      entry.profileVersion === current.profileVersion &&
      entry.source === 'missed_opportunity' &&
      entry.eligible &&
      entry.recalled &&
      !entry.selected &&
      entry.taskFit >= this.options.config().routing.minTaskFit).length
    if (missed < this.options.config().routing.dormantMissedOpportunityThreshold) return
    const next = GraphAgentProfileVersionV1Schema.parse({
      ...current,
      profileVersion: current.profileVersion + 1,
      lifecycle: 'dormant',
      supersedesVersion: current.profileVersion,
      rollbackVersion: current.profileVersion,
      createdAt: this.nowIso(),
      createdBy: 'system'
    })
    state.profiles.push(next)
    state.audit.push(this.audit(state.identity.projectId, {
      action: 'disable',
      targetKind: 'profile',
      targetId: current.profileId,
      beforeHash: sha256(JSON.stringify(current)),
      afterHash: sha256(JSON.stringify(next)),
      reason: `${missed} relevant recalled opportunities were not selected; configured threshold is ${this.options.config().routing.dormantMissedOpportunityThreshold}.`
    }, 'system'))
  }

  private audit(
    projectId: string,
    input: Omit<GraphGovernanceAuditV1, 'version' | 'auditId' | 'projectId' | 'actor' | 'createdAt'>,
    actor: GraphGovernanceAuditV1['actor'] = 'system'
  ): GraphGovernanceAuditV1 {
    return GraphGovernanceAuditV1Schema.parse({
      version: GRAPH_CONTRACT_VERSION,
      auditId: this.nextId('graph_audit'),
      projectId,
      actor,
      ...input,
      createdAt: this.nowIso()
    })
  }

  private enqueue<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(operation)
    const guard = run.then(() => undefined, () => undefined)
    this.queues.set(projectId, guard)
    return run.finally(() => {
      if (this.queues.get(projectId) === guard) this.queues.delete(projectId)
    })
  }

  private async load(projectId: string): Promise<ProjectAgentRegistryState | null> {
    return loadProjectAgentRegistryState(this.options.rootDir, projectId)
  }

  private async loadOrCreate(identity: ProjectIdentityV1): Promise<ProjectAgentRegistryState> {
    return loadOrCreateProjectAgentRegistryState(this.options.rootDir, identity, this.nowIso)
  }

  private async persist(state: ProjectAgentRegistryState): Promise<void> {
    return persistProjectAgentRegistryState(this.options.rootDir, state, this.nowIso)
  }
}
