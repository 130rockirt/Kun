import { randomUUID } from 'node:crypto'
import { chmod, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { atomicWriteFile } from '../adapters/file/atomic-write.js'
import { RuntimeFlavorSchema, type RuntimeFlavor } from '../contracts/runtime-flavor.js'
import { sameCanonicalPath } from './canonical-path.js'

const FORCED_RUNTIME_RECOVERY_FILE = 'forced-runtime-recovery.json'
const MAX_RECOVERY_FILE_BYTES = 64 * 1024

export const VerifiedForcedRuntimeOwnerSchema = z.object({
  flavor: RuntimeFlavorSchema,
  instanceId: z.string().min(1).max(256),
  pid: z.number().int().positive(),
  startedAt: z.string().datetime()
}).strict()

export type VerifiedForcedRuntimeOwner = z.infer<typeof VerifiedForcedRuntimeOwnerSchema>

export const ForcedRuntimeRecoveryRecordSchema = z.object({
  version: z.literal(1),
  markerId: z.string().min(1).max(256),
  dataDir: z.string().min(1).max(4_096),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  owners: z.array(VerifiedForcedRuntimeOwnerSchema).min(1).max(8)
}).strict()

export type ForcedRuntimeRecoveryRecord = z.infer<typeof ForcedRuntimeRecoveryRecordSchema>

export function forcedRuntimeRecoveryPath(controlDir: string): string {
  return join(controlDir, FORCED_RUNTIME_RECOVERY_FILE)
}

export async function readForcedRuntimeRecovery(
  controlDir: string,
  expectedDataDir?: string
): Promise<ForcedRuntimeRecoveryRecord | null> {
  const path = forcedRuntimeRecoveryPath(controlDir)
  try {
    const metadata = await stat(path)
    if (!metadata.isFile() || metadata.size > MAX_RECOVERY_FILE_BYTES) {
      throw new Error('Kun forced-runtime recovery marker is invalid or oversized')
    }
    const record = ForcedRuntimeRecoveryRecordSchema.parse(
      JSON.parse(await readFile(path, 'utf8'))
    )
    if (expectedDataDir && !sameCanonicalPath(record.dataDir, expectedDataDir)) {
      throw new Error('Kun forced-runtime recovery marker owns a different data directory')
    }
    return record
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw error
  }
}

export async function recordVerifiedForcedRuntimeOwner(input: {
  controlDir: string
  dataDir: string
  owner: VerifiedForcedRuntimeOwner
  now?: Date
}): Promise<ForcedRuntimeRecoveryRecord> {
  const owner = VerifiedForcedRuntimeOwnerSchema.parse(input.owner)
  const existing = await readForcedRuntimeRecovery(input.controlDir, input.dataDir)
  const now = (input.now ?? new Date()).toISOString()
  const owners = [...(existing?.owners ?? [])]
  const index = owners.findIndex((candidate) =>
    candidate.flavor === owner.flavor && candidate.instanceId === owner.instanceId
  )
  if (index >= 0) owners[index] = owner
  else owners.push(owner)
  const record = ForcedRuntimeRecoveryRecordSchema.parse({
    version: 1,
    markerId: existing?.markerId ?? randomUUID(),
    dataDir: input.dataDir,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    owners
  })
  const path = forcedRuntimeRecoveryPath(input.controlDir)
  await atomicWriteFile(path, `${JSON.stringify(record, null, 2)}\n`)
  await chmod(path, 0o600).catch((error) => {
    if (process.platform !== 'win32') throw error
  })
  return record
}

export async function removeForcedRuntimeRecovery(
  controlDir: string,
  markerId: string
): Promise<boolean> {
  const current = await readForcedRuntimeRecovery(controlDir)
  if (!current || current.markerId !== markerId) return false
  try {
    await unlink(forcedRuntimeRecoveryPath(controlDir))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
    throw error
  }
}

export function forcedOwnerKey(owner: {
  flavor: RuntimeFlavor
  instanceId: string
}): string {
  return `${owner.flavor}:${owner.instanceId}`
}
