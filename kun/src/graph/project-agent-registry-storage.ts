import { join } from 'node:path'
import { GRAPH_CONTRACT_VERSION, type ProjectIdentityV1 } from '../contracts/index.js'
import { AtomicJsonFile } from '../extensions/atomic-json.js'
import {
  ProjectAgentRegistryStateSchema,
  type ProjectAgentRegistryState
} from './project-agent-registry-state.js'

export async function loadProjectAgentRegistryState(
  rootDir: string,
  projectId: string
): Promise<ProjectAgentRegistryState | null> {
  return new AtomicJsonFile<ProjectAgentRegistryState | null>(
    registryStatePath(rootDir, projectId),
    (value) => value === null ? null : ProjectAgentRegistryStateSchema.parse(value)
  ).read(() => null)
}

export async function loadOrCreateProjectAgentRegistryState(
  rootDir: string,
  identity: ProjectIdentityV1,
  nowIso: () => string
): Promise<ProjectAgentRegistryState> {
  const state = await loadProjectAgentRegistryState(rootDir, identity.projectId)
  return state ?? ProjectAgentRegistryStateSchema.parse({
    version: GRAPH_CONTRACT_VERSION,
    identity,
    profiles: [],
    evidence: [],
    explanations: [],
    candidates: [],
    scores: [],
    audit: [],
    updatedAt: nowIso()
  })
}

export async function persistProjectAgentRegistryState(
  rootDir: string,
  state: ProjectAgentRegistryState,
  nowIso: () => string
): Promise<void> {
  state.updatedAt = nowIso()
  const parsed = ProjectAgentRegistryStateSchema.parse(state)
  await new AtomicJsonFile(
    registryStatePath(rootDir, state.identity.projectId),
    (value) => ProjectAgentRegistryStateSchema.parse(value)
  ).write(parsed)
}

function registryStatePath(rootDir: string, projectId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(projectId)) {
    throw new Error('invalid project id')
  }
  return join(rootDir, projectId, 'registry.json')
}
