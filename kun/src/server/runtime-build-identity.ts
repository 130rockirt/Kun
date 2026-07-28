import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { RuntimeBuildIdSchema } from '../contracts/runtime-info.js'

export const RUNTIME_BUILD_MANIFEST_FILENAME = 'runtime-build.json'
export const RuntimeBuildManifestSchema = z.object({
  version: z.literal(1),
  buildId: RuntimeBuildIdSchema
}).strict()

export function runtimeBuildManifestPathForEntry(entry: string): string {
  const entryPath = entry.startsWith('file:') ? fileURLToPath(entry) : resolve(entry)
  return join(dirname(dirname(entryPath)), RUNTIME_BUILD_MANIFEST_FILENAME)
}

export async function readRuntimeBuildIdForEntry(
  entry: string
): Promise<string | undefined> {
  try {
    const path = runtimeBuildManifestPathForEntry(entry)
    const parsed = RuntimeBuildManifestSchema.safeParse(
      JSON.parse(await readFile(path, 'utf8')) as unknown
    )
    return parsed.success ? parsed.data.buildId : undefined
  } catch {
    return undefined
  }
}
