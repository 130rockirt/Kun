import {
  lstatSync,
  readFileSync
} from 'node:fs'
import {
  join
} from 'node:path'
import {
  ExtensionPaths
} from '../../kun/src/extensions/paths.js'
import {
  validateRegistryDocument
} from '../../kun/src/extensions/registry.js'
import {
  isObjectRecord,
  type MigrationPhase,
  type RuntimeMigrationJournal
} from './runtime-data-dir-migration-types'
import {
  pathState,
  sameFilesystemPath,
  writeDurableJson
} from './runtime-data-dir-migration-journal-v2'
import {
  updateJournal
} from './runtime-data-dir-migration-journal-preservation'
import {
  backUpRegularFile
} from './runtime-data-dir-migration-copy'



export type ExtensionRegistryRebaseInspection =
  | { kind: 'missing' }
  | {
      kind: 'registry'
      path: string
      document: Record<string, unknown>
      rebasedRecords: number
    }

export function inspectExtensionRegistryForRebase(
  sourcePath: string,
  targetPath: string,
  platform: NodeJS.Platform,
  registryDataPath = targetPath
): ExtensionRegistryRebaseInspection {
  const registryPath = join(registryDataPath, 'extensions', 'registry.json')
  const state = pathState(registryPath)
  if (state === 'missing') return { kind: 'missing' }
  if (state !== 'other' || !lstatSync(registryPath).isFile()) {
    throw new Error(`extension registry is not a regular file: ${registryPath}`)
  }

  let document: unknown
  try {
    document = JSON.parse(readFileSync(registryPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `extension registry is not valid JSON at ${registryPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  if (!isObjectRecord(document) || !isObjectRecord(document.extensions)) {
    throw new Error(`extension registry has an invalid root shape: ${registryPath}`)
  }

  const legacyPaths = new ExtensionPaths({ packageRoot: join(sourcePath, 'extensions') })
  const currentPaths = new ExtensionPaths({ packageRoot: join(targetPath, 'extensions') })
  let rebasedRecords = 0

  for (const [extensionId, rawEntry] of Object.entries(document.extensions)) {
    if (!isObjectRecord(rawEntry) || rawEntry.id !== extensionId || !isObjectRecord(rawEntry.versions)) {
      throw new Error(`extension registry entry has an invalid shape: ${extensionId}`)
    }
    for (const [version, rawVersion] of Object.entries(rawEntry.versions)) {
      if (!isObjectRecord(rawVersion) || rawVersion.version !== version) {
        throw new Error(`extension registry version has an invalid shape: ${extensionId}@${version}`)
      }
      let legacyPackagePath: string
      let currentPackagePath: string
      try {
        legacyPackagePath = legacyPaths.packageVersion(extensionId, version)
        currentPackagePath = currentPaths.packageVersion(extensionId, version)
      } catch (error) {
        throw new Error(
          `extension registry identity is unsafe: ${extensionId}@${version}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
      if (typeof rawVersion.packagePath !== 'string') {
        throw new Error(`extension registry packagePath is missing: ${extensionId}@${version}`)
      }
      if (
        !sameFilesystemPath(rawVersion.packagePath, legacyPackagePath, platform) &&
        !sameFilesystemPath(rawVersion.packagePath, currentPackagePath, platform)
      ) {
        throw new Error(
          `extension registry packagePath is outside the canonical migration roots: ` +
          `${extensionId}@${version} (${rawVersion.packagePath})`
        )
      }
      if (rawVersion.packagePath !== currentPackagePath) {
        rawVersion.packagePath = currentPackagePath
        rebasedRecords += 1
      }
    }
  }

  try {
    // The Runtime validator normalizes a narrow legacy manifest shape while
    // validating. Validate a clone so this migration changes packagePath only.
    validateRegistryDocument(structuredClone(document), currentPaths)
  } catch (error) {
    throw new Error(
      `extension registry remains invalid after canonical path rebasing at ${registryPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }

  return {
    kind: 'registry',
    path: registryPath,
    document,
    rebasedRecords
  }
}

export function prepareExtensionRegistryRebase(
  journalPath: string,
  initialJournal: RuntimeMigrationJournal,
  options: {
    platform: NodeJS.Platform
    now: () => Date
    afterPhase: (phase: MigrationPhase) => void
  }
): RuntimeMigrationJournal {
  let journal = initialJournal
  const inspection = inspectExtensionRegistryForRebase(
    journal.sourcePath,
    journal.targetPath,
    options.platform
  )
  if (inspection.kind === 'missing' || inspection.rebasedRecords === 0) {
    journal = updateJournal(
      journalPath,
      journal,
      {
        phase: 'extension-registry-rebased',
        extensionRegistryRebasedRecords: 0,
        extensionRegistryRebasedAt: options.now().toISOString(),
        error: undefined
      },
      options.now
    )
    options.afterPhase('extension-registry-rebased')
    return journal
  }

  const existingBackups = journal.extensionRegistryBackupPaths ?? []
  const backupPath = existingBackups.length > 0
    ? undefined
    : backUpRegularFile(
        inspection.path,
        'pre-runtime-extension-path-migration',
        options.now,
        'extension registry'
      )
  journal = updateJournal(
    journalPath,
    journal,
    {
      phase: 'extension-registry-backed-up',
      extensionRegistryBackupPaths: backupPath
        ? [...existingBackups, backupPath]
        : existingBackups,
      // Persist the intended count before rewriting. If the process exits
      // after the atomic rename but before the next journal update, recovery
      // sees a canonical registry and can still report the completed work.
      extensionRegistryRebasedRecords: inspection.rebasedRecords,
      error: undefined
    },
    options.now
  )
  options.afterPhase('extension-registry-backed-up')
  return journal
}

export function commitExtensionRegistryRebase(
  journalPath: string,
  initialJournal: RuntimeMigrationJournal,
  options: {
    platform: NodeJS.Platform
    now: () => Date
    afterPhase: (phase: MigrationPhase) => void
  }
): RuntimeMigrationJournal {
  const inspection = inspectExtensionRegistryForRebase(
    initialJournal.sourcePath,
    initialJournal.targetPath,
    options.platform
  )
  if (inspection.kind === 'missing') {
    throw new Error('extension registry disappeared after its migration backup was recorded')
  }
  if (inspection.rebasedRecords > 0) {
    writeDurableJson(inspection.path, inspection.document)
  }
  const rebasedRecords =
    inspection.rebasedRecords > 0
      ? inspection.rebasedRecords
      : initialJournal.extensionRegistryRebasedRecords ?? 0
  const journal = updateJournal(
    journalPath,
    initialJournal,
    {
      phase: 'extension-registry-rebased',
      extensionRegistryRebasedRecords: rebasedRecords,
      extensionRegistryRebasedAt: options.now().toISOString(),
      error: undefined
    },
    options.now
  )
  options.afterPhase('extension-registry-rebased')
  return journal
}

export function repairCompletedExtensionRegistry(
  journalPath: string,
  initialJournal: RuntimeMigrationJournal,
  options: {
    platform: NodeJS.Platform
    now: () => Date
  }
): RuntimeMigrationJournal {
  let journal = initialJournal
  const inspection = inspectExtensionRegistryForRebase(
    journal.sourcePath,
    journal.targetPath,
    options.platform
  )
  if (inspection.kind === 'missing') {
    if (journal.extensionRegistryRebasedAt) return journal
    return updateJournal(
      journalPath,
      journal,
      {
        extensionRegistryRebasedRecords: 0,
        extensionRegistryRebasedAt: options.now().toISOString(),
        error: undefined
      },
      options.now
    )
  }
  if (inspection.rebasedRecords === 0) {
    if (journal.extensionRegistryRebasedAt) return journal
    return updateJournal(
      journalPath,
      journal,
      {
        extensionRegistryRebasedRecords: journal.extensionRegistryRebasedRecords ?? 0,
        extensionRegistryRebasedAt: options.now().toISOString(),
        error: undefined
      },
      options.now
    )
  }

  const existingBackups = journal.extensionRegistryBackupPaths ?? []
  if (existingBackups.length === 0) {
    const backupPath = backUpRegularFile(
      inspection.path,
      'pre-runtime-extension-path-migration',
      options.now,
      'extension registry'
    )
    journal = updateJournal(
      journalPath,
      journal,
      {
        extensionRegistryBackupPaths: [backupPath],
        extensionRegistryRebasedRecords: inspection.rebasedRecords,
        error: undefined
      },
      options.now
    )
  }
  writeDurableJson(inspection.path, inspection.document)
  return updateJournal(
    journalPath,
    journal,
    {
      extensionRegistryRebasedRecords:
        inspection.rebasedRecords > 0
          ? inspection.rebasedRecords
          : journal.extensionRegistryRebasedRecords ?? 0,
      extensionRegistryRebasedAt: options.now().toISOString(),
      error: undefined
    },
    options.now
  )
}
