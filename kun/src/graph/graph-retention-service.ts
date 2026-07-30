import type { GraphRuntimeConfig } from '../config/kun-config.js'
import type { ArtifactStore, StoredArtifactMeta } from '../artifacts/artifact-store.js'
import type { ProjectAgentRegistry } from './project-agent-registry.js'
import type { GraphLearningService } from './graph-learning-service.js'
import type { GraphRunStore } from './graph-run-store.js'
import type { FileGraphThreadReferenceStore } from './graph-thread-reference-store.js'

export type GraphRetentionResult = {
  referencesRemoved: number
  runsRemoved: number
  episodesRemoved: number
  jobsRemoved: number
  auditRemoved: number
  artifactsRemoved: number
  retainedReferencedRuns: number
}

/**
 * Applies time-based retention to terminal GraphRuns and Graph-owned artifacts.
 * Physical artifact deletion is conservative: legacy ownership metadata and
 * content observed outside Graph are retained.
 */
export class GraphRetentionService {
  private queue: Promise<GraphRetentionResult> | undefined

  constructor(private readonly options: {
    runs: GraphRunStore
    references: Pick<FileGraphThreadReferenceStore, 'compact' | 'referencedRunIds'>
    registry: Pick<ProjectAgentRegistry, 'listProjectIdentities' | 'compactRetention'>
    learning: Pick<GraphLearningService, 'compactRetention'>
      & Partial<Pick<GraphLearningService, 'listEpisodes'>>
    artifacts?: Pick<ArtifactStore, 'list' | 'delete'>
    config: () => GraphRuntimeConfig
    nowIso?: () => string
  }) {}

  run(): Promise<GraphRetentionResult> {
    if (this.queue) return this.queue
    const operation = this.execute().finally(() => {
      this.queue = undefined
    })
    this.queue = operation
    return operation
  }

  private async execute(): Promise<GraphRetentionResult> {
    const now = Date.parse(this.options.nowIso?.() ?? new Date().toISOString())
    const graphFloor = new Date(
      now - this.options.config().retention.graphDays * 86_400_000
    ).toISOString()
    const artifactFloor = new Date(
      now - this.options.config().retention.artifactDays * 86_400_000
    ).toISOString()
    const referencesRemoved = await this.options.references.compact(graphFloor)
    const referencedRunIds = await this.options.references.referencedRunIds()
    const allRuns = await this.options.runs.list()
    let runsRemoved = 0
    const removedRunIds = new Set<string>()
    for (const run of allRuns.filter((candidate) =>
      candidate.status === 'completed' ||
      candidate.status === 'failed' ||
      candidate.status === 'cancelled'
    )) {
      if (referencedRunIds.has(run.id) || run.updatedAt >= graphFloor) continue
      if (run.artifacts.some((artifact) =>
        artifact.retention === 'project' || artifact.retention === 'pinned')) continue
      await this.options.runs.remove(run.id)
      runsRemoved += 1
      removedRunIds.add(run.id)
    }
    const retainedRuns = allRuns.filter((run) => !removedRunIds.has(run.id))

    let episodesRemoved = 0
    let jobsRemoved = 0
    let auditRemoved = 0
    const retainedEpisodeArtifactIds = new Set<string>()
    const identities = await this.options.registry.listProjectIdentities()
    for (const identity of identities) {
      const [learningResult, registryResult] = await Promise.all([
        this.options.learning.compactRetention(identity.projectId),
        this.options.registry.compactRetention(identity.projectId)
      ])
      episodesRemoved += learningResult.episodesRemoved
      jobsRemoved += learningResult.jobsRemoved
      auditRemoved += registryResult.auditRemoved
      if (this.options.learning.listEpisodes) {
        for (const episode of await this.options.learning.listEpisodes(identity.projectId)) {
          for (const artifact of episode.artifactRefs) {
            retainedEpisodeArtifactIds.add(artifact.artifactId)
          }
        }
      }
    }
    const artifactsRemoved = await this.removeExpiredArtifacts(
      retainedRuns,
      retainedEpisodeArtifactIds,
      artifactFloor
    )
    return {
      referencesRemoved,
      runsRemoved,
      episodesRemoved,
      jobsRemoved,
      auditRemoved,
      artifactsRemoved,
      retainedReferencedRuns: referencedRunIds.size
    }
  }

  private async removeExpiredArtifacts(
    retainedRuns: Awaited<ReturnType<GraphRunStore['list']>>,
    episodeArtifactIds: ReadonlySet<string>,
    artifactFloor: string
  ): Promise<number> {
    const store = this.options.artifacts
    if (!store?.list || !store.delete) return 0
    const protectedArtifactIds = new Set([
      ...episodeArtifactIds,
      ...retainedRuns.flatMap((run) => run.artifacts.map((artifact) => artifact.artifactId))
    ])
    const retainedRunIds = new Set(retainedRuns.map((run) => run.id))
    const retainedAttemptIds = new Set(retainedRuns.flatMap((run) =>
      Object.values(run.nodes).flatMap((node) => node.attempts.map((attempt) => attempt.id))))
    let removed = 0
    for (const meta of await store.list()) {
      if (
        meta.createdAt >= artifactFloor ||
        protectedArtifactIds.has(meta.id) ||
        !artifactOwnershipIsCompleteAndGraphOnly(meta) ||
        artifactOriginStillReferenced(meta, retainedRunIds, retainedAttemptIds)
      ) continue
      await store.delete(meta.id)
      removed += 1
    }
    return removed
  }
}

function artifactOwnershipIsCompleteAndGraphOnly(meta: StoredArtifactMeta): boolean {
  return meta.originHistoryComplete === true &&
    Boolean(meta.origins?.length) &&
    meta.origins!.every((origin) =>
      origin.startsWith('graph:') ||
      origin.startsWith('graph-result:') ||
      origin.startsWith('graph-worktree:'))
}

function artifactOriginStillReferenced(
  meta: StoredArtifactMeta,
  retainedRunIds: ReadonlySet<string>,
  retainedAttemptIds: ReadonlySet<string>
): boolean {
  return (meta.origins ?? []).some((origin) => {
    if (origin.startsWith('graph:')) return retainedRunIds.has(origin.slice('graph:'.length))
    if (origin.startsWith('graph-result:')) {
      return retainedAttemptIds.has(origin.slice('graph-result:'.length))
    }
    if (origin.startsWith('graph-worktree:')) {
      return retainedAttemptIds.has(origin.slice('graph-worktree:'.length))
    }
    return true
  })
}
