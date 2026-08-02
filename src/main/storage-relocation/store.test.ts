import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { StorageRelocationOperationJournal } from '../../shared/storage-relocation'
import {
  STORAGE_RELOCATION_ACTIVE_FILE,
  StorageRelocationStore,
  activeStorageRelocationRequiresRecovery,
  pendingStorageRelocationOperationId,
  storageRelocationMetadataIsInvalid
} from './store'

const operationId = '123e4567-e89b-42d3-a456-426614174000'

function journal(controlRoot: string): StorageRelocationOperationJournal {
  return {
    schemaVersion: 1,
    operationId,
    kind: 'move',
    phase: 'prepared',
    sourceHome: 'C:\\Users\\Alice',
    destinationRoot: 'D:\\KunData',
    controlRoot,
    roots: [],
    uniqueBytes: 0,
    requiredBytes: 5 * 1024 * 1024 * 1024,
    startedAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z'
  }
}

describe('storage relocation journal store', () => {
  it('durably round-trips a journal and active pointer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-storage-store-'))
    const store = new StorageRelocationStore(root)
    await store.writeJournal(journal(root))
    await store.setActiveOperation(operationId)
    await expect(store.readJournal(operationId)).resolves.toEqual(journal(root))
    expect(await store.activeOperationId()).toBe(operationId)
    expect(pendingStorageRelocationOperationId(root)).toBe(operationId)
    await store.clearActiveOperation(operationId)
    expect(await store.activeOperationId()).toBeNull()
  })

  it('treats a tampered active pointer as invalid recovery metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-storage-tamper-'))
    await mkdir(root, { recursive: true })
    await writeFile(join(root, STORAGE_RELOCATION_ACTIVE_FILE), JSON.stringify({
      schemaVersion: 1,
      operationId: '../../outside'
    }))
    expect(pendingStorageRelocationOperationId(root)).toBeNull()
    expect(storageRelocationMetadataIsInvalid(root)).toBe(true)
    expect(await readFile(join(root, STORAGE_RELOCATION_ACTIVE_FILE), 'utf8')).toContain('../../outside')
  })

  it('blocks startup when an app-owned location is unavailable or its junction is broken', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-storage-location-'))
    const home = join(root, 'home')
    const control = join(root, 'app-data', 'storage-relocation')
    const target = join(root, 'drive-d', 'KunData', '.kun')
    await mkdir(home, { recursive: true })
    await mkdir(target, { recursive: true })
    await mkdir(control, { recursive: true })
    await symlink(target, join(home, '.kun'), 'dir')
    await writeFile(join(control, 'active-location.json'), JSON.stringify({
      schemaVersion: 1,
      destinationRoot: join(root, 'drive-d', 'KunData'),
      roots: { '.kun': target },
      operationId,
      activatedAt: '2026-08-01T00:00:00.000Z'
    }))
    expect(activeStorageRelocationRequiresRecovery(control, home)).toBe(false)
    await unlink(join(home, '.kun'))
    expect(activeStorageRelocationRequiresRecovery(control, home)).toBe(true)
  })
})
