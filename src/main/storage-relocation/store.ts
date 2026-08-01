import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { atomicWriteFile } from '../../../kun/src/adapters/file/atomic-write.js'
import {
  StorageRelocationOperationJournalSchema,
  StorageRelocationReportSchema,
  type StorageRelocationOperationJournal,
  type StorageRelocationReport
} from '../../shared/storage-relocation'

export const STORAGE_RELOCATION_ACTIVE_FILE = 'active-operation.json'
export const STORAGE_RELOCATION_LOCATION_FILE = 'active-location.json'

export function pendingStorageRelocationOperationId(controlRoot: string): string | null {
  try {
    const value = JSON.parse(
      readFileSync(join(controlRoot, STORAGE_RELOCATION_ACTIVE_FILE), 'utf8')
    ) as { schemaVersion?: unknown; operationId?: unknown }
    if (value.schemaVersion !== 1 || typeof value.operationId !== 'string') return null
    assertOperationId(value.operationId)
    return value.operationId
  } catch {
    return null
  }
}

export function activeStorageRelocationRequiresRecovery(
  controlRoot: string,
  homeDir: string
): boolean {
  try {
    const location = JSON.parse(
      readFileSync(join(controlRoot, STORAGE_RELOCATION_LOCATION_FILE), 'utf8')
    ) as StorageRelocationLocationRecord
    if (location.schemaVersion !== 1 || !location.roots || typeof location.roots !== 'object') return true
    const canonicalTarget = location.roots['.kun']
    if (typeof canonicalTarget !== 'string') return true
    const logical = join(homeDir, '.kun')
    const metadata = lstatSync(logical)
    const physicalTarget = realpathSync(canonicalTarget)
    return !metadata.isSymbolicLink() ||
      resolve(realpathSync(logical)) !== resolve(physicalTarget) ||
      !lstatSync(physicalTarget).isDirectory()
  } catch (error) {
    if (String((error as NodeJS.ErrnoException).code) === 'ENOENT') {
      try {
        readFileSync(join(controlRoot, STORAGE_RELOCATION_LOCATION_FILE), 'utf8')
        return true
      } catch {
        return false
      }
    }
    return true
  }
}

export function storageRelocationMetadataIsInvalid(controlRoot: string): boolean {
  const activePath = join(controlRoot, STORAGE_RELOCATION_ACTIVE_FILE)
  const locationPath = join(controlRoot, STORAGE_RELOCATION_LOCATION_FILE)
  try {
    if (existsSync(activePath)) {
      const active = JSON.parse(readFileSync(activePath, 'utf8')) as {
        schemaVersion?: unknown
        operationId?: unknown
      }
      if (active.schemaVersion !== 1 || typeof active.operationId !== 'string') return true
      assertOperationId(active.operationId)
    }
    if (existsSync(locationPath)) {
      const location = JSON.parse(readFileSync(locationPath, 'utf8')) as Partial<StorageRelocationLocationRecord>
      if (
        location.schemaVersion !== 1 ||
        typeof location.destinationRoot !== 'string' ||
        typeof location.operationId !== 'string' ||
        typeof location.activatedAt !== 'string' ||
        !location.roots || typeof location.roots['.kun'] !== 'string'
      ) return true
      assertOperationId(location.operationId)
    }
    return false
  } catch {
    return true
  }
}

export type StorageRelocationLocationRecord = {
  schemaVersion: 1
  destinationRoot: string
  roots: Partial<Record<'.kun' | '.deepseekgui', string>>
  operationId: string
  activatedAt: string
}

export class StorageRelocationStore {
  readonly operationsRoot: string
  readonly reportsRoot: string

  constructor(readonly controlRoot: string) {
    this.operationsRoot = join(controlRoot, 'operations')
    this.reportsRoot = join(controlRoot, 'reports')
  }

  metadataIsInvalid(): boolean {
    return storageRelocationMetadataIsInvalid(this.controlRoot)
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.operationsRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.reportsRoot, { recursive: true, mode: 0o700 })
    ])
  }

  journalPath(operationId: string): string {
    assertOperationId(operationId)
    return join(this.operationsRoot, `${operationId}.json`)
  }

  async writeJournal(journal: StorageRelocationOperationJournal): Promise<void> {
    const parsed = StorageRelocationOperationJournalSchema.parse(journal)
    await this.initialize()
    await atomicWriteFile(this.journalPath(parsed.operationId), `${JSON.stringify(parsed, null, 2)}\n`)
  }

  async readJournal(operationId: string): Promise<StorageRelocationOperationJournal> {
    return StorageRelocationOperationJournalSchema.parse(
      JSON.parse(await readFile(this.journalPath(operationId), 'utf8'))
    )
  }

  async setActiveOperation(operationId: string): Promise<void> {
    assertOperationId(operationId)
    await this.initialize()
    await atomicWriteFile(
      join(this.controlRoot, STORAGE_RELOCATION_ACTIVE_FILE),
      `${JSON.stringify({ schemaVersion: 1, operationId }, null, 2)}\n`
    )
  }

  async activeOperationId(): Promise<string | null> {
    try {
      const parsed = JSON.parse(
        await readFile(join(this.controlRoot, STORAGE_RELOCATION_ACTIVE_FILE), 'utf8')
      ) as { schemaVersion?: unknown; operationId?: unknown }
      if (parsed.schemaVersion !== 1 || typeof parsed.operationId !== 'string') return null
      assertOperationId(parsed.operationId)
      return parsed.operationId
    } catch (error) {
      if (String((error as NodeJS.ErrnoException).code) === 'ENOENT') return null
      return null
    }
  }

  async clearActiveOperation(operationId: string): Promise<void> {
    if (await this.activeOperationId() !== operationId) return
    await rm(join(this.controlRoot, STORAGE_RELOCATION_ACTIVE_FILE), { force: true })
  }

  async writeLocation(location: StorageRelocationLocationRecord): Promise<void> {
    await this.initialize()
    await atomicWriteFile(
      join(this.controlRoot, STORAGE_RELOCATION_LOCATION_FILE),
      `${JSON.stringify(location, null, 2)}\n`
    )
  }

  async readLocation(): Promise<StorageRelocationLocationRecord | null> {
    try {
      const value = JSON.parse(
        await readFile(join(this.controlRoot, STORAGE_RELOCATION_LOCATION_FILE), 'utf8')
      ) as StorageRelocationLocationRecord
      if (
        value.schemaVersion !== 1 ||
        typeof value.destinationRoot !== 'string' ||
        typeof value.operationId !== 'string' ||
        typeof value.activatedAt !== 'string' ||
        !value.roots || typeof value.roots !== 'object'
      ) return null
      assertOperationId(value.operationId)
      return value
    } catch (error) {
      if (String((error as NodeJS.ErrnoException).code) === 'ENOENT') return null
      return null
    }
  }

  async clearLocation(): Promise<void> {
    await rm(join(this.controlRoot, STORAGE_RELOCATION_LOCATION_FILE), { force: true })
  }

  async writeReport(report: StorageRelocationReport): Promise<void> {
    const parsed = StorageRelocationReportSchema.parse(report)
    await this.initialize()
    await atomicWriteFile(
      join(this.reportsRoot, `${parsed.finishedAt.replace(/[:.]/gu, '-')}-${parsed.operationId}.json`),
      `${JSON.stringify(parsed, null, 2)}\n`
    )
  }

  async latestReport(): Promise<StorageRelocationReport | null> {
    try {
      const files = (await readdir(this.reportsRoot)).filter((name) => name.endsWith('.json')).sort().reverse()
      for (const name of files) {
        try {
          return StorageRelocationReportSchema.parse(
            JSON.parse(await readFile(join(this.reportsRoot, name), 'utf8'))
          )
        } catch {
          // Ignore a corrupt diagnostic report; journals remain authoritative.
        }
      }
      return null
    } catch (error) {
      if (String((error as NodeJS.ErrnoException).code) === 'ENOENT') return null
      throw error
    }
  }
}

function assertOperationId(operationId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(operationId)) {
    throw new Error('invalid storage relocation operation id')
  }
}
