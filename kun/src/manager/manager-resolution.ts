import { z } from 'zod'
import {
  KUN_MANAGER_PROTOCOL_VERSION,
  defaultKunControlDir,
  readManagerDiscovery,
  type ManagerDiscoveryRecord
} from './manager-discovery.js'
import { KUN_MANAGER_CAPABILITIES } from './service-manager.js'
import { processIsAlive, safeManagerUrl } from './manager-client-support.js'

const ManagerHealthSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('kun-service-manager'),
  protocolVersion: z.literal(KUN_MANAGER_PROTOCOL_VERSION),
  instanceId: z.string(),
  pid: z.number().int().positive(),
  startedAt: z.string().datetime(),
  serviceVersion: z.string(),
  buildId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  capabilities: z.array(z.string())
})

const ManagerStatusSchema = ManagerHealthSchema.omit({
  status: true,
  service: true
}).extend({
  slots: z.array(z.unknown())
})

type ManagerIdentity = z.infer<typeof ManagerHealthSchema>

export async function resolveServiceManager(
  controlDir = defaultKunControlDir(),
  fetchImpl: typeof fetch = fetch
): Promise<{ discovery: ManagerDiscoveryRecord } | null> {
  const candidate = await probeManagerHealth(controlDir, fetchImpl)
  if (!candidate) return null
  if (!KUN_MANAGER_CAPABILITIES.every((capability) =>
    candidate.health.capabilities.includes(capability)
  )) return null
  return { discovery: candidate.discovery }
}

/**
 * Resolves an older same-protocol Manager only for migration handoff. Normal
 * callers must use resolveServiceManager so current data operations never run
 * against an incomplete capability set.
 */
export async function resolveServiceManagerForHandoff(
  controlDir = defaultKunControlDir(),
  fetchImpl: typeof fetch = fetch
): Promise<{ discovery: ManagerDiscoveryRecord } | null> {
  const candidate = await probeManagerHealth(controlDir, fetchImpl)
  if (!candidate || !candidate.health.capabilities.includes('runtime-slots-v1')) return null
  try {
    const response = await fetchImpl(`${candidate.discovery.baseUrl}/v1/manager/status`, {
      headers: {
        authorization: `Bearer ${candidate.discovery.managerToken}`
      },
      signal: AbortSignal.timeout(2_000)
    })
    if (!response.ok) return null
    const status = ManagerStatusSchema.parse(await response.json())
    if (
      !managerIdentityMatchesDiscovery(status, candidate.discovery) ||
      !sameManagerIdentity(status, candidate.health) ||
      !sameStringSet(status.capabilities, candidate.health.capabilities) ||
      !status.capabilities.includes('runtime-slots-v1')
    ) return null
    return { discovery: candidate.discovery }
  } catch {
    return null
  }
}

export async function resolveServiceManagerForMigration(
  controlDir = defaultKunControlDir(),
  fetchImpl: typeof fetch = fetch
): Promise<{ discovery: ManagerDiscoveryRecord } | null> {
  return await resolveServiceManager(controlDir, fetchImpl) ??
    await resolveServiceManagerForHandoff(controlDir, fetchImpl)
}

async function probeManagerHealth(
  controlDir: string,
  fetchImpl: typeof fetch
): Promise<{ discovery: ManagerDiscoveryRecord; health: ManagerIdentity } | null> {
  const discovery = await readManagerDiscovery(controlDir).catch(() => null)
  if (!discovery || !safeManagerUrl(discovery) || !processIsAlive(discovery.pid)) return null
  try {
    const response = await fetchImpl(`${discovery.baseUrl}/health`, {
      signal: AbortSignal.timeout(2_000)
    })
    if (!response.ok) return null
    const health = ManagerHealthSchema.parse(await response.json())
    return managerIdentityMatchesDiscovery(health, discovery)
      ? { discovery, health }
      : null
  } catch {
    return null
  }
}

function managerIdentityMatchesDiscovery(
  identity: Omit<ManagerIdentity, 'status' | 'service'>,
  discovery: ManagerDiscoveryRecord
): boolean {
  return identity.protocolVersion === discovery.protocolVersion &&
    identity.instanceId === discovery.instanceId &&
    identity.pid === discovery.pid &&
    identity.startedAt === discovery.startedAt &&
    identity.serviceVersion === discovery.serviceVersion &&
    identity.buildId === discovery.buildId
}

function sameManagerIdentity(
  status: z.infer<typeof ManagerStatusSchema>,
  health: ManagerIdentity
): boolean {
  return status.protocolVersion === health.protocolVersion &&
    status.instanceId === health.instanceId &&
    status.pid === health.pid &&
    status.startedAt === health.startedAt &&
    status.serviceVersion === health.serviceVersion &&
    status.buildId === health.buildId
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const values = new Set(left)
  return values.size === left.length && right.every((value) => values.has(value))
}
