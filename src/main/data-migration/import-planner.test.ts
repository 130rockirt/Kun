import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parsePackageRelativePath, type DataMigrationPackageEntry, type DataMigrationWorkspaceCatalogEntry } from '../../shared/data-migration'
import {
  buildDataMigrationImportPlan,
  detectWorkspaceConflicts,
  probeDestinationFileSystem,
  rebindDataMigrationReferences,
  recommendCollisionFreeDestination,
  revalidateDataMigrationImportPlan,
  stableImportedSiblingPath,
  type DestinationFileSystemProbe
} from './import-planner'
import { validateKunpackEntryPath } from './archive-security'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const workspace: DataMigrationWorkspaceCatalogEntry = {
  workspaceId: 'ws_source',
  displayName: 'Project',
  sourcePathDisplay: 'C:\\Users\\Alice\\Project',
  sourcePlatform: 'windows',
  fileCount: 1,
  logicalBytes: 5,
  relatedThreadIds: ['thread_old'],
  capabilities: ['code', 'design']
}

function packageEntry(relativePath: string, contents = 'hello'): DataMigrationPackageEntry {
  return {
    path: parsePackageRelativePath(`payload/workspaces/ws_source/files/${relativePath}`),
    kind: 'workspace-file',
    ownerId: 'ws_source',
    logicalBytes: Buffer.byteLength(contents),
    sha256: createHash('sha256').update(contents).digest('hex')
  }
}

describe('cross-platform migration import planning', () => {
  it('probes destination semantics without leaving probe files behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-import-probe-'))
    roots.push(root)
    const probe = await probeDestinationFileSystem(root)
    expect(probe.writable).toBe(true)
    expect(probe.freeBytes).toBeGreaterThan(0)
    expect(probe.maximumComponentBytes).toBe(255)
  })

  it('recommends stable collision-free Keep both destinations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-import-destination-'))
    roots.push(root)
    await mkdir(join(root, 'Project (Imported)'))
    expect(await recommendCollisionFreeDestination(root, 'Project')).toBe(join(root, 'Project (Imported 2)'))
  })

  it('builds a repeatable plan with disk estimates and default Keep both policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-import-plan-'))
    roots.push(root)
    const input = {
      operationId: 'import_plan',
      packageId: 'package_plan',
      inspectedAt: '2026-07-15T00:00:00.000Z',
      sourcePlatform: 'windows' as const,
      encrypted: true,
      workspaces: [workspace],
      entries: [packageEntry('README.md')],
      destinationBaseRoot: root,
      destinationPlatform: process.platform === 'win32' ? 'windows' as const : 'macos' as const
    }
    const first = await buildDataMigrationImportPlan(input)
    const second = await buildDataMigrationImportPlan(input)
    // Free space is live filesystem telemetry and can legitimately change between
    // otherwise identical inspections. The logical plan must remain repeatable.
    expect({ ...first, mappings: first.mappings.map(({ freeBytes: _freeBytes, ...mapping }) => mapping) }).toEqual({
      ...second,
      mappings: second.mappings.map(({ freeBytes: _freeBytes, ...mapping }) => mapping)
    })
    expect(first.mappings[0]).toMatchObject({ strategy: 'keep-both', requiredBytes: 5, compatible: true })
    expect(first.estimatedPeakBytes).toBeGreaterThan(5)
  })

  it('detects case aliases and differing-content merge conflicts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-import-conflicts-'))
    roots.push(root)
    await writeFile(join(root, 'README.md'), 'target')
    const baseProbe: DestinationFileSystemProbe = {
      root,
      canonicalRoot: root,
      writable: true,
      caseSensitive: false,
      unicodeNormalizationSensitive: false,
      supportsSymbolicLinks: false,
      maximumComponentBytes: 255,
      maximumPathBytes: 4096,
      freeBytes: 10_000_000_000,
      platform: 'macos'
    }
    const conflicts = await detectWorkspaceConflicts({
      workspace,
      destinationRoot: root,
      entries: [packageEntry('README.md'), packageEntry('readme.md', 'other')],
      probe: baseProbe,
      strategy: 'merge'
    })
    expect(conflicts.map((conflict) => conflict.kind)).toEqual(['different-content', 'case-collision'])
    expect(conflicts[1]?.renamedPath).toBeTruthy()
  })

  it('plans deterministic compatible renames for names that are illegal on the target platform', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-import-invalid-names-'))
    roots.push(root)
    const probe: DestinationFileSystemProbe = {
      root,
      canonicalRoot: root,
      writable: true,
      caseSensitive: false,
      unicodeNormalizationSensitive: false,
      supportsSymbolicLinks: false,
      maximumComponentBytes: 255,
      maximumPathBytes: 32_767,
      freeBytes: 10_000_000_000,
      platform: 'windows'
    }
    const conflicts = await detectWorkspaceConflicts({
      workspace,
      destinationRoot: root,
      entries: [packageEntry('CON.txt'), packageEntry('name:stream')],
      probe,
      strategy: 'keep-both'
    })
    expect(conflicts).toHaveLength(2)
    for (const conflict of conflicts) {
      expect(conflict).toMatchObject({ kind: 'invalid-name', fatal: true })
      expect(() => validateKunpackEntryPath(conflict.renamedPath!)).not.toThrow()
    }
  })

  it('rebuilds submitted plans from inspected inputs and does not trust renderer compatibility flags', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-import-revalidate-'))
    roots.push(root)
    const oversized = packageEntry('huge.bin')
    oversized.logicalBytes = 1_000_000_000_000_000
    const plan = await buildDataMigrationImportPlan({
      operationId: 'import_revalidate', packageId: 'package_revalidate', inspectedAt: 'now',
      sourcePlatform: 'windows', encrypted: true, workspaces: [workspace], entries: [oversized],
      destinationBaseRoot: root
    })
    const submitted = {
      ...plan,
      mappings: plan.mappings.map((mapping) => ({
        ...mapping,
        compatible: true,
        preflightCompatible: true,
        freeBytes: Number.MAX_SAFE_INTEGER
      }))
    }
    const authoritative = await revalidateDataMigrationImportPlan({
      plan: submitted,
      packageId: 'package_revalidate',
      sourcePlatform: 'windows',
      encrypted: true,
      workspaces: [workspace],
      entries: [oversized]
    })
    expect(authoritative.mappings[0]).toMatchObject({
      compatible: false,
      preflightCompatible: false
    })
    await expect(revalidateDataMigrationImportPlan({
      plan: { ...plan, mappings: [] },
      packageId: 'package_revalidate',
      sourcePlatform: 'windows',
      encrypted: true,
      workspaces: [workspace],
      entries: [oversized]
    })).rejects.toThrow('mappings do not match')
    await expect(revalidateDataMigrationImportPlan({
      plan: { ...plan, mappings: [plan.mappings[0]!, plan.mappings[0]!] },
      packageId: 'package_revalidate',
      sourcePlatform: 'windows',
      encrypted: true,
      workspaces: [workspace],
      entries: [oversized]
    })).rejects.toThrow('mappings do not match')
  })

  it('keeps nonfatal merge conflicts unresolved until the user chooses a decision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-import-unresolved-merge-'))
    roots.push(root)
    await writeFile(join(root, 'README.md'), 'target')
    const source = packageEntry('README.md', 'source')
    const plan = await buildDataMigrationImportPlan({
      operationId: 'import_unresolved', packageId: 'package_unresolved', inspectedAt: 'now',
      sourcePlatform: 'windows', encrypted: false, workspaces: [workspace], entries: [source],
      destinationBaseRoot: dirname(root),
      destinationRoots: { ws_source: root },
      strategies: { ws_source: 'merge' }
    })
    const authoritative = await revalidateDataMigrationImportPlan({
      plan,
      packageId: 'package_unresolved',
      sourcePlatform: 'windows',
      encrypted: false,
      workspaces: [workspace],
      entries: [source]
    })
    expect(authoritative.conflicts).toEqual([
      expect.objectContaining({ kind: 'different-content', fatal: false })
    ])
    expect(authoritative.conflicts[0]).not.toHaveProperty('resolution')
    expect(authoritative.mappings[0]?.unresolvedIssueCount).toBe(1)
    await expect(revalidateDataMigrationImportPlan({
      plan: {
        ...plan,
        conflicts: plan.conflicts.map((conflict) => ({
          ...conflict,
          resolution: 'rename-source' as const
        }))
      },
      packageId: 'package_unresolved',
      sourcePlatform: 'windows',
      encrypted: false,
      workspaces: [workspace],
      entries: [source]
    })).rejects.toThrow('invalid resolution')
  })

  it('rejects missing, shared, nested, or migration-internal workspace destinations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-import-destination-boundaries-'))
    roots.push(root)
    const shared = join(root, 'shared')
    await mkdir(shared)
    const secondWorkspace: DataMigrationWorkspaceCatalogEntry = {
      ...workspace,
      workspaceId: 'ws_second',
      displayName: 'Second',
      sourcePathDisplay: 'C:\\Users\\Alice\\Second'
    }
    const secondEntry: DataMigrationPackageEntry = {
      ...packageEntry('SECOND.md'),
      path: parsePackageRelativePath('payload/workspaces/ws_second/files/SECOND.md'),
      ownerId: 'ws_second'
    }
    const common = {
      operationId: 'import_destination_boundaries',
      packageId: 'package_destination_boundaries',
      inspectedAt: 'now',
      sourcePlatform: 'windows' as const,
      encrypted: false,
      workspaces: [workspace, secondWorkspace],
      entries: [packageEntry('README.md'), secondEntry],
      destinationBaseRoot: root,
      strategies: { ws_source: 'merge' as const, ws_second: 'merge' as const }
    }
    await expect(buildDataMigrationImportPlan({
      ...common,
      destinationRoots: { ws_source: shared, ws_second: shared }
    })).rejects.toThrow('destinations overlap')
    await expect(buildDataMigrationImportPlan({
      ...common,
      destinationRoots: { ws_source: shared, ws_second: join(shared, 'nested') }
    })).rejects.toThrow('destinations overlap')
    await expect(buildDataMigrationImportPlan({
      ...common,
      destinationRoots: {
        ws_source: shared,
        ws_second: join(root, '.kun-migration-staging-user-selected', 'Second')
      }
    })).rejects.toThrow('staging or backup')

    const valid = await buildDataMigrationImportPlan({
      operationId: 'import_missing_destination',
      packageId: 'package_missing_destination',
      inspectedAt: 'now',
      sourcePlatform: 'windows',
      encrypted: false,
      workspaces: [workspace],
      entries: [packageEntry('README.md')],
      destinationBaseRoot: root
    })
    await expect(revalidateDataMigrationImportPlan({
      plan: {
        ...valid,
        mappings: valid.mappings.map(({ destinationRoot: _destinationRoot, ...mapping }) => mapping)
      },
      packageId: 'package_missing_destination',
      sourcePlatform: 'windows',
      encrypted: false,
      workspaces: [workspace],
      entries: [packageEntry('README.md')]
    })).rejects.toThrow('destination is required')
  })

  it('treats the skip strategy as a true unmapped workspace without probing or conflicts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-import-skip-workspace-'))
    roots.push(root)
    const result = await buildDataMigrationImportPlan({
      operationId: 'import_skip_workspace',
      packageId: 'package_skip_workspace',
      inspectedAt: 'now',
      sourcePlatform: 'windows',
      encrypted: false,
      workspaces: [workspace],
      entries: [packageEntry('CON.txt')],
      destinationBaseRoot: root,
      destinationRoots: { ws_source: join(root, '.kun-migration-staging-ignored') },
      strategies: { ws_source: 'skip' }
    })
    expect(result.mappings[0]).toMatchObject({
      strategy: 'skip',
      compatible: true,
      unresolvedIssueCount: 0
    })
    expect(result.mappings[0]).not.toHaveProperty('destinationRoot')
    expect(result.conflicts).toEqual([])
  })

  it('rewrites only typed path and thread references while preserving prose', () => {
    const rebound = rebindDataMigrationReferences({
      component: 'thread',
      schemaVersion: 1,
      value: {
        id: 'thread_old',
        parentThreadId: 'parent_old',
        workspace: 'C:\\Users\\Alice\\Project',
        summary: 'See C:\\Users\\Alice\\Project and thread_old in this prose.'
      },
      workspacePathMap: { 'C:\\Users\\Alice\\Project': '/Users/bob/Project' },
      threadIdMap: { thread_old: 'thread_new', parent_old: 'parent_new' },
      sourcePlatform: 'windows'
    })
    expect(rebound.value).toEqual({
      id: 'thread_new',
      parentThreadId: 'parent_new',
      workspace: '/Users/bob/Project',
      summary: 'See C:\\Users\\Alice\\Project and thread_old in this prose.'
    })
    expect(rebound.unresolved).toEqual([])
  })

  it('creates deterministic imported-sibling names', () => {
    expect(stableImportedSiblingPath(parsePackageRelativePath('src/config.json'), 'abcdef012345')).toBe(
      'src/config.imported-abcdef01.json'
    )
  })

  it('blocks planning before staging when logical bytes exceed target free space', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-import-disk-full-'))
    roots.push(root)
    const oversized = packageEntry('huge.bin')
    oversized.logicalBytes = 1_000_000_000_000_000
    const result = await buildDataMigrationImportPlan({
      operationId: 'import_disk_full', packageId: 'package_disk_full', inspectedAt: 'now',
      sourcePlatform: 'windows', encrypted: true, workspaces: [workspace], entries: [oversized],
      destinationBaseRoot: root
    })
    expect(result.mappings[0]?.compatible).toBe(false)
    expect(result.mappings[0]!.requiredBytes).toBe(1_000_000_000_000_000)
  })

  it('reports a read-only destination as not writable without leaving a probe directory', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'kun-import-read-only-'))
    roots.push(root)
    await chmod(root, 0o500)
    try {
      const probe = await probeDestinationFileSystem(root)
      expect(probe.writable).toBe(false)
    } finally {
      await chmod(root, 0o700)
    }
  })

  it('fails closed when a network destination disappears before its filesystem probe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-import-network-disconnect-'))
    await rm(root, { recursive: true, force: true })
    await expect(probeDestinationFileSystem(root)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
