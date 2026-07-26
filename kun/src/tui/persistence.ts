import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { ModelReasoningEffort } from '../contracts/capabilities.js'

const RecentModelSchema = z.object({
  providerId: z.string().min(1),
  accountId: z.string().min(1),
  model: z.string().min(1)
}).strict()

const TuiPersistentStateSchema = z.object({
  schemaVersion: z.literal(1),
  recentModels: z.array(RecentModelSchema).max(20).default([]),
  favoriteModels: z.array(z.string().min(1)).max(500).default([]),
  reasoningByModel: z.record(z.string(), ModelReasoningEffort).default({})
}).strict()

export type TuiRecentModel = z.infer<typeof RecentModelSchema>
export type TuiPersistentState = z.infer<typeof TuiPersistentStateSchema>

export function emptyTuiPersistentState(): TuiPersistentState {
  return { schemaVersion: 1, recentModels: [], favoriteModels: [], reasoningByModel: {} }
}

export function tuiStatePath(dataDir: string): string {
  return join(dataDir, 'tui', 'state.json')
}

export async function readTuiPersistentState(dataDir: string): Promise<TuiPersistentState> {
  try {
    return TuiPersistentStateSchema.parse(JSON.parse(await readFile(tuiStatePath(dataDir), 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyTuiPersistentState()
    return emptyTuiPersistentState()
  }
}

export async function writeTuiPersistentState(dataDir: string, state: TuiPersistentState): Promise<void> {
  const target = tuiStatePath(dataDir)
  const directory = dirname(target)
  const safe = TuiPersistentStateSchema.parse(state)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700).catch(() => undefined)
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(safe, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await chmod(temporary, 0o600).catch(() => undefined)
  await rename(temporary, target)
  await chmod(target, 0o600).catch(() => undefined)
}

export function modelStateKey(providerId: string, accountId: string, model: string): string {
  return `${encodeURIComponent(providerId)}|${encodeURIComponent(accountId)}|${encodeURIComponent(model)}`
}
