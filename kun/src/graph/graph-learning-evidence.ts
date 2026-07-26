import {
  GRAPH_CONTRACT_VERSION,
  GraphAgentEvidenceV1Schema,
  type GraphRunV1,
  type ProjectIdentityV1
} from '../contracts/index.js'
import type { ProjectAgentRegistry } from './project-agent-registry.js'
import { hash } from './graph-learning-candidates.js'

export async function attributeGraphLearningEvidence(input: {
  identity: ProjectIdentityV1
  run: GraphRunV1
  taskFingerprint: string
  registry: ProjectAgentRegistry
  nowIso: () => string
}): Promise<void> {
  const { identity, run, taskFingerprint, registry, nowIso } = input
  for (const node of Object.values(run.nodes)) {
    const attempt = node.attempts.at(-1)
    if (!attempt || attempt.assignment.profileOrigin === 'ephemeral') continue
    const positive = node.status === 'accepted'
    await registry.recordEvidence(identity, GraphAgentEvidenceV1Schema.parse({
      version: GRAPH_CONTRACT_VERSION,
      evidenceId: `graph_evidence_${hash([
        run.id,
        node.node.id,
        attempt.assignment.profileId,
        'outcome'
      ].join('|')).slice(0, 24)}`,
      profileId: attempt.assignment.profileId,
      profileVersion: attempt.assignment.profileVersion,
      runId: run.id,
      nodeId: node.node.id,
      taskFingerprint,
      source: positive
        ? 'accepted_outcome'
        : node.attempts.length > 1
          ? 'retry'
          : 'regression',
      outcome: positive ? 'positive' : 'negative',
      quality: positive
        ? Math.max(0.5, run.reviews
            .filter((review) => review.nodeId === node.node.id)
            .reduce((score, review) => score + (review.outcome === 'pass' ? 0.1 : -0.1), 0.7))
        : 0.2,
      costTokens: node.attempts.reduce((sum, item) => sum + item.tokenUsage, 0),
      latencyMs: node.attempts.reduce((sum, item) => sum + item.elapsedMs, 0),
      eligible: true,
      recalled: true,
      selected: true,
      taskFit: 1,
      summary: positive ? 'Graph node was accepted.' : `Graph node ended ${node.status}.`,
      createdAt: nowIso()
    }))
    for (const review of run.reviews.filter((entry) =>
      entry.nodeId === node.node.id &&
      entry.attemptId === attempt.id
    )) {
      const source = review.reviewerKind === 'human'
        ? 'human_override'
        : review.reviewerKind === 'deterministic'
          ? 'later_validation'
          : 'independent_review'
      const outcome = review.outcome === 'pass'
        ? 'positive'
        : review.outcome === 'fail' || review.outcome === 'revise'
          ? 'negative'
          : 'neutral'
      await registry.recordEvidence(identity, GraphAgentEvidenceV1Schema.parse({
        version: GRAPH_CONTRACT_VERSION,
        evidenceId: `graph_evidence_${hash([
          run.id,
          node.node.id,
          attempt.assignment.profileId,
          review.reviewId
        ].join('|')).slice(0, 24)}`,
        profileId: attempt.assignment.profileId,
        profileVersion: attempt.assignment.profileVersion,
        runId: run.id,
        nodeId: node.node.id,
        taskFingerprint,
        source,
        outcome,
        quality: outcome === 'positive' ? 0.9 : outcome === 'negative' ? 0.1 : 0.5,
        costTokens: 0,
        latencyMs: 0,
        eligible: true,
        recalled: true,
        selected: true,
        taskFit: 1,
        summary: `${review.reviewerKind} review concluded ${review.outcome}.`,
        createdAt: nowIso()
      }))
    }
  }
  const explanations = await registry.listExplanations(identity.projectId)
  for (const explanation of explanations.filter((item) =>
    item.request.projectId === run.projectId &&
    Date.parse(item.createdAt) >= Date.parse(run.createdAt))) {
    for (const recalled of explanation.recalled) {
      if (recalled.profileId === explanation.selectedProfileId) continue
      await registry.recordEvidence(identity, GraphAgentEvidenceV1Schema.parse({
        version: GRAPH_CONTRACT_VERSION,
        evidenceId: `graph_evidence_${hash([
          run.id,
          recalled.profileId,
          hash(JSON.stringify(explanation.request)).slice(0, 16),
          'missed'
        ].join('|')).slice(0, 24)}`,
        profileId: recalled.profileId,
        profileVersion: recalled.profileVersion,
        runId: run.id,
        nodeId: `routing_${hash(JSON.stringify(explanation.request)).slice(0, 16)}`,
        taskFingerprint,
        source: 'missed_opportunity',
        outcome: 'neutral',
        quality: recalled.score.quality,
        costTokens: 0,
        latencyMs: 0,
        eligible: true,
        recalled: true,
        selected: false,
        taskFit: recalled.score.taskFit,
        summary: 'Eligible and relevant profile was recalled but not selected.',
        createdAt: nowIso()
      }))
    }
  }
}
