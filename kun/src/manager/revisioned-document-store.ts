import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { atomicWriteFile } from '../adapters/file/atomic-write.js'
import type { RevisionedSnapshot } from '../contracts/runtime-flavor.js'

export class RevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super(`revision conflict; current revision is ${currentRevision}`)
    this.name = 'RevisionConflictError'
  }
}

type DocumentEntry = {
  path: string
  revision: number
  loaded: boolean
  value: string | null
  queue: Promise<unknown>
}

/** Manager-owned compare-and-swap documents for cross-profile business state. */
export class RevisionedDocumentStore {
  private readonly documents: Record<'settings' | 'client-state', DocumentEntry>

  constructor(input: { settingsPath: string; clientStatePath: string }) {
    this.documents = {
      settings: entry(input.settingsPath),
      'client-state': entry(input.clientStatePath)
    }
  }

  async read(key: 'settings' | 'client-state'): Promise<RevisionedSnapshot<string | null>> {
    const document = this.documents[key]
    await this.ensureLoaded(document)
    return { revision: document.revision, value: document.value }
  }

  async write(input: {
    key: 'settings' | 'client-state'
    expectedRevision: number
    value: string
  }): Promise<RevisionedSnapshot<string>> {
    const document = this.documents[input.key]
    return this.enqueue(document, async () => {
      await this.ensureLoaded(document)
      if (input.expectedRevision !== document.revision) {
        throw new RevisionConflictError(document.revision)
      }
      await mkdir(dirname(document.path), { recursive: true, mode: 0o700 })
      await atomicWriteFile(document.path, input.value)
      document.value = input.value
      document.revision += 1
      return { revision: document.revision, value: input.value }
    })
  }

  path(key: 'settings' | 'client-state'): string {
    return this.documents[key].path
  }

  private async ensureLoaded(document: DocumentEntry): Promise<void> {
    if (document.loaded) return
    try {
      document.value = await readFile(document.path, 'utf8')
      document.revision = 1
    } catch (error) {
      if (String((error as { code?: unknown })?.code ?? '') !== 'ENOENT') throw error
      document.value = null
      document.revision = 0
    }
    document.loaded = true
  }

  private async enqueue<T>(document: DocumentEntry, operation: () => Promise<T>): Promise<T> {
    const run = document.queue.catch(() => undefined).then(operation)
    document.queue = run.then(() => undefined, () => undefined)
    return run
  }
}

function entry(path: string): DocumentEntry {
  return { path, revision: 0, loaded: false, value: null, queue: Promise.resolve() }
}
