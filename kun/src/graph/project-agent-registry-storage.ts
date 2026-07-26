import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { atomicWriteFile } from '../adapters/file/atomic-write.js'
import { GRAPH_CONTRACT_VERSION, type ProjectIdentityV1 } from '../contracts/index.js'
import {
  ProjectAgentRegistryStateSchema,
  type ProjectAgentRegistryState
} from './project-agent-registry-state.js'

export async function loadProjectAgentRegistryState(
  rootDir: string,
  projectId: string
): Promise<ProjectAgentRegistryState | null> {
  const text = await readFile(registryStatePath(rootDir, projectId), 'utf8').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  return text === null ? null : ProjectAgentRegistryStateSchema.parse(JSON.parse(text))
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
  const path = registryStatePath(rootDir, state.identity.projectId)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await atomicWriteFile(path, `${JSON.stringify(parsed)}\n`)
}

function registryStatePath(rootDir: string, projectId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(projectId)) {
    throw new Error('invalid project id')
  }
  return join(rootDir, projectId, 'registry.json')
}
