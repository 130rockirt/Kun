import { create } from 'zustand'
import { graphRuntimeClient } from './graph-runtime-client'
import type {
  GraphAgentEvidence,
  GraphAgentProfile,
  GraphAgentScore,
  GraphArtifactPage,
  GraphEventEnvelope,
  GraphGovernanceAudit,
  GraphLearningCandidate,
  GraphLearningJob,
  GraphPatchOperation,
  GraphRun,
  ProjectIdentity
} from './graph-types'

type GraphViewState = {
  threadId: string | null
  workspace: string
  runs: GraphRun[]
  selectedRunId: string | null
  selectedNodeId: string | null
  identity: ProjectIdentity | null
  profiles: GraphAgentProfile[]
  evidence: GraphAgentEvidence[]
  scores: GraphAgentScore[]
  audit: GraphGovernanceAudit[]
  candidates: GraphLearningCandidate[]
  jobs: GraphLearningJob[]
  exportedProfile: string | null
  artifactPage: GraphArtifactPage | null
  artifactContent: string
  artifactLoading: boolean
  loading: boolean
  error: string | null
  refreshThread: (threadId: string | null) => Promise<void>
  refreshProject: (workspace: string) => Promise<void>
  refreshSelectedRun: () => Promise<void>
  selectRun: (runId: string | null) => void
  selectNode: (nodeId: string | null) => void
  receiveEvent: (event: GraphEventEnvelope) => void
  command: (action: 'start' | 'pause' | 'resume' | 'cleanup') => Promise<void>
  cancel: () => Promise<void>
  retryNode: (nodeId: string) => Promise<void>
  reviewNode: (nodeId: string, outcome: 'pass' | 'fail') => Promise<void>
  patch: (operations: GraphPatchOperation[], reason: string) => Promise<void>
  rebindNode: (nodeId: string, profileId: string) => Promise<void>
  steer: (text: string, nodeId?: string) => Promise<void>
  loadArtifact: (artifactId: string) => Promise<void>
  loadNextArtifactPage: () => Promise<void>
  clearArtifact: () => void
  transitionProfile: (
    profileId: string,
    lifecycle: GraphAgentProfile['lifecycle']
  ) => Promise<void>
  exportProfile: (profileId: string) => Promise<void>
  importProfile: (portableJson: string) => Promise<void>
  mergeProfiles: (
    sourceProfileIds: string[],
    targetProfileId: string,
    name: string
  ) => Promise<void>
  governCandidate: (
    candidateId: string,
    action: 'approve' | 'reject' | 'start_probation' | 'promote' | 'rollback' | 'delete'
  ) => Promise<void>
  consolidate: () => Promise<void>
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const useGraphStore = create<GraphViewState>((set, get) => ({
  threadId: null,
  workspace: '',
  runs: [],
  selectedRunId: null,
  selectedNodeId: null,
  identity: null,
  profiles: [],
  evidence: [],
  scores: [],
  audit: [],
  candidates: [],
  jobs: [],
  exportedProfile: null,
  artifactPage: null,
  artifactContent: '',
  artifactLoading: false,
  loading: false,
  error: null,

  refreshThread: async (threadId) => {
    set({ threadId, loading: true, error: null })
    if (!threadId) {
      set({
        runs: [],
        selectedRunId: null,
        selectedNodeId: null,
        artifactPage: null,
        artifactContent: '',
        artifactLoading: false,
        loading: false
      })
      return
    }
    try {
      const runs = await graphRuntimeClient.listRuns(threadId)
      if (get().threadId !== threadId) return
      const previousRunId = get().selectedRunId
      const previousNodeId = get().selectedNodeId
      const selectedRunId = runs.some((run) => run.id === previousRunId)
        ? previousRunId
        : runs[0]?.id ?? null
      const selectedRun = runs.find((run) => run.id === selectedRunId)
      const selectedNodeId = previousNodeId && selectedRun?.nodes[previousNodeId]
        ? previousNodeId
        : null
      set({
        runs,
        selectedRunId,
        selectedNodeId,
        artifactPage: null,
        artifactContent: '',
        artifactLoading: false,
        loading: false
      })
    } catch (error) {
      set({ loading: false, error: message(error) })
    }
  },

  refreshProject: async (workspace) => {
    const trimmed = workspace.trim()
    set({ workspace: trimmed })
    if (!trimmed) {
      set({
        identity: null,
        profiles: [],
        evidence: [],
        scores: [],
        audit: [],
        candidates: [],
        jobs: [],
        exportedProfile: null
      })
      return
    }
    try {
      const identity = await graphRuntimeClient.identity(trimmed)
      const [profiles, evidence, scores, audit, candidates, jobs] = await Promise.all([
        graphRuntimeClient.listProfiles(identity.projectId),
        graphRuntimeClient.listEvidence(identity.projectId),
        graphRuntimeClient.listScores(identity.projectId),
        graphRuntimeClient.listAudit(identity.projectId),
        graphRuntimeClient.listCandidates(identity.projectId),
        graphRuntimeClient.listJobs(identity.projectId)
      ])
      if (get().workspace !== trimmed) return
      set({ identity, profiles, evidence, scores, audit, candidates, jobs, error: null })
    } catch (error) {
      if (get().workspace === trimmed) set({ error: message(error) })
    }
  },

  refreshSelectedRun: async () => {
    const runId = get().selectedRunId
    if (!runId) return
    try {
      const run = await graphRuntimeClient.getRun(runId)
      set((state) => ({
        runs: state.runs.some((item) => item.id === run.id)
          ? state.runs.map((item) => item.id === run.id ? run : item)
          : [run, ...state.runs],
        error: null
      }))
    } catch (error) {
      set({ error: message(error) })
    }
  },

  selectRun: (selectedRunId) => set({
    selectedRunId,
    selectedNodeId: null,
    artifactPage: null,
    artifactContent: '',
    artifactLoading: false
  }),
  selectNode: (selectedNodeId) => set({
    selectedNodeId,
    artifactPage: null,
    artifactContent: '',
    artifactLoading: false
  }),

  receiveEvent: (event) => {
    if (event.threadId !== get().threadId) return
    const known = get().runs.find((run) => run.id === event.runId)
    if (!known || event.graphSeq > known.lastEventSeq) {
      void get().refreshThread(event.threadId)
    }
  },

  command: async (action) => {
    const runId = get().selectedRunId
    if (!runId) return
    try {
      const run = await graphRuntimeClient.command(runId, action)
      set((state) => ({
        runs: state.runs.map((item) => item.id === run.id ? run : item),
        error: null
      }))
    } catch (error) {
      set({ error: message(error) })
    }
  },

  cancel: async () => {
    const runId = get().selectedRunId
    if (!runId) return
    try {
      const run = await graphRuntimeClient.cancel(runId, 'Cancelled by user from Graph panel.')
      set((state) => ({
        runs: state.runs.map((item) => item.id === run.id ? run : item),
        error: null
      }))
    } catch (error) {
      set({ error: message(error) })
    }
  },

  retryNode: async (nodeId) => {
    const runId = get().selectedRunId
    if (!runId) return
    try {
      const run = await graphRuntimeClient.retry(runId, nodeId)
      set((state) => ({
        runs: state.runs.map((item) => item.id === run.id ? run : item),
        error: null
      }))
    } catch (error) {
      set({ error: message(error) })
    }
  },

  reviewNode: async (nodeId, outcome) => {
    const run = get().runs.find((item) => item.id === get().selectedRunId)
    const attempt = run?.nodes[nodeId]?.attempts.at(-1)
    if (!run || !attempt) return
    try {
      const next = await graphRuntimeClient.review(run, nodeId, attempt.id, outcome)
      set((state) => ({
        runs: state.runs.map((item) => item.id === next.id ? next : item),
        error: null
      }))
    } catch (error) {
      set({ error: message(error) })
    }
  },

  patch: async (operations, reason) => {
    const run = get().runs.find((item) => item.id === get().selectedRunId)
    if (!run || operations.length === 0 || !reason.trim()) return
    try {
      const next = await graphRuntimeClient.patch(run, operations, reason.trim())
      set((state) => ({
        runs: state.runs.map((item) => item.id === next.id ? next : item),
        error: null
      }))
    } catch (error) {
      set({ error: message(error) })
    }
  },

  rebindNode: async (nodeId, profileId) => {
    const trimmed = profileId.trim()
    if (!trimmed) return
    await get().patch([{
      op: 'rebind_node',
      nodeId,
      assignment: { kind: 'existing', profileId: trimmed }
    }], `User rebound node ${nodeId} to project profile ${trimmed}.`)
  },

  steer: async (text, nodeId) => {
    const runId = get().selectedRunId
    if (!runId || !text.trim()) return
    try {
      const run = await graphRuntimeClient.steer(
        runId,
        text.trim(),
        nodeId ? { kind: 'node', nodeId } : { kind: 'run' }
      )
      set((state) => ({
        runs: state.runs.map((item) => item.id === run.id ? run : item),
        error: null
      }))
    } catch (error) {
      set({ error: message(error) })
    }
  },

  loadArtifact: async (artifactId) => {
    const runId = get().selectedRunId
    if (!runId) return
    set({ artifactLoading: true, error: null })
    try {
      const page = await graphRuntimeClient.readArtifact(runId, artifactId)
      if (get().selectedRunId !== runId) return
      set({
        artifactPage: page,
        artifactContent: page.content,
        artifactLoading: false,
        error: null
      })
    } catch (error) {
      set({ artifactLoading: false, error: message(error) })
    }
  },

  loadNextArtifactPage: async () => {
    const runId = get().selectedRunId
    const current = get().artifactPage
    if (!runId || !current || !current.truncated) return
    const cursor = current.nextStartLine !== undefined
      ? { startLine: current.nextStartLine }
      : { offset: current.nextOffset ?? 0 }
    set({ artifactLoading: true, error: null })
    try {
      const page = await graphRuntimeClient.readArtifact(
        runId,
        current.reference.artifactId,
        cursor
      )
      if (
        get().selectedRunId !== runId ||
        get().artifactPage?.reference.artifactId !== current.reference.artifactId
      ) return
      set({
        artifactPage: page,
        artifactContent: page.content,
        artifactLoading: false,
        error: null
      })
    } catch (error) {
      set({ artifactLoading: false, error: message(error) })
    }
  },

  clearArtifact: () => set({
    artifactPage: null,
    artifactContent: '',
    artifactLoading: false
  }),

  transitionProfile: async (profileId, lifecycle) => {
    const { identity, workspace } = get()
    if (!identity || !workspace) return
    try {
      await graphRuntimeClient.transitionProfile(
        identity.projectId,
        profileId,
        workspace,
        lifecycle,
        `User changed lifecycle to ${lifecycle} from the Graph panel.`
      )
      await get().refreshProject(workspace)
    } catch (error) {
      set({ error: message(error) })
    }
  },

  exportProfile: async (profileId) => {
    const { identity } = get()
    if (!identity) return
    try {
      const portable = await graphRuntimeClient.exportProfile(identity.projectId, profileId)
      set({ exportedProfile: JSON.stringify(portable, null, 2), error: null })
    } catch (error) {
      set({ error: message(error) })
    }
  },

  importProfile: async (portableJson) => {
    const { identity, workspace } = get()
    if (!identity || !workspace) return
    try {
      const value = JSON.parse(portableJson) as {
        format?: unknown
        formatVersion?: unknown
        profile?: unknown
      }
      if (
        value.format !== 'kun.graph-agent-profile' ||
        value.formatVersion !== 1 ||
        !value.profile ||
        typeof value.profile !== 'object'
      ) {
        throw new Error('Invalid portable Graph project-agent profile.')
      }
      await graphRuntimeClient.importProfile(
        identity.projectId,
        workspace,
        value.profile as GraphAgentProfile
      )
      await get().refreshProject(workspace)
    } catch (error) {
      set({ error: message(error) })
    }
  },

  mergeProfiles: async (sourceProfileIds, targetProfileId, name) => {
    const { identity, workspace } = get()
    if (!identity || !workspace) return
    if (sourceProfileIds.length < 2 || !targetProfileId.trim() || !name.trim()) return
    try {
      await graphRuntimeClient.mergeProfiles(
        identity.projectId,
        workspace,
        sourceProfileIds,
        targetProfileId.trim(),
        name.trim()
      )
      await get().refreshProject(workspace)
    } catch (error) {
      set({ error: message(error) })
    }
  },

  governCandidate: async (candidateId, action) => {
    const { identity, workspace } = get()
    if (!identity || !workspace) return
    try {
      await graphRuntimeClient.governCandidate(
        identity.projectId,
        candidateId,
        workspace,
        action,
        `User selected ${action} from the Graph learning panel.`
      )
      await get().refreshProject(workspace)
    } catch (error) {
      set({ error: message(error) })
    }
  },

  consolidate: async () => {
    const { identity, workspace } = get()
    if (!identity || !workspace) return
    try {
      await graphRuntimeClient.consolidate(identity.projectId, workspace)
      await get().refreshProject(workspace)
    } catch (error) {
      set({ error: message(error) })
    }
  }
}))

export function receiveGraphRuntimeEvent(value: unknown): void {
  if (!value || typeof value !== 'object') return
  const event = value as Partial<GraphEventEnvelope>
  if (
    event.version !== 1 ||
    typeof event.runId !== 'string' ||
    typeof event.threadId !== 'string' ||
    typeof event.graphSeq !== 'number' ||
    !event.event
  ) return
  useGraphStore.getState().receiveEvent(event as GraphEventEnvelope)
}
