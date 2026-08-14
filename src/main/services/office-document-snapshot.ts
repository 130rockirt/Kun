import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OfficeDocumentPreviewFormat } from '../../shared/office-document'

export type OfficeDocumentSnapshot = {
  path: string
  cleanup: () => Promise<void>
}

/**
 * OfficeCLI and LibreOffice operate on a private immutable copy, preventing an
 * atomic source-file replacement from mixing a stale SHA with new content.
 */
export async function createOfficeDocumentSnapshot(
  source: Uint8Array,
  format: OfficeDocumentPreviewFormat
): Promise<OfficeDocumentSnapshot> {
  const root = await mkdtemp(join(tmpdir(), 'kun-office-source-'))
  const path = join(root, `source.${format}`)
  try {
    await chmod(root, 0o700).catch(() => undefined)
    await writeFile(path, source, { mode: 0o600 })
    return {
      path,
      cleanup: () => rm(root, { recursive: true, force: true })
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}
