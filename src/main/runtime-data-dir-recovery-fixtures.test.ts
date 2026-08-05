import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { runCanonicalKunRuntimeDataMigration } from './runtime-data-dir-migration'
import {
  RuntimeDataDirRecovery,
  runtimeDataRecoveryInternals
} from './runtime-data-dir-recovery'
import { canonicalCurrentKunDataDir } from './kun-data-dir-paths'

const FixtureEntrySchema = z.object({
  path: z.string().min(1).max(500),
  content: z.string().max(1024 * 1024)
}).strict()

const FixtureExpectedSchema = z.object({
  scannerState: z.enum([
    'new-install',
    'candidate-ready',
    'selection-required',
    'start-over-required'
  ]),
  candidateKinds: z.array(z.enum(['current', 'legacy', 'staging', 'backup'])),
  equivalentCopies: z.number().int().positive().optional(),
  invalidEvidenceCount: z.number().int().nonnegative().optional(),
  runnerStatus: z.enum(['completed', 'blocked'])
}).strict()

const FixtureSchema = z.object({
  version: z.string().regex(/^0\.2\.(?:29|30|31|32|33|34|35)$/),
  tagObject: z.string().regex(/^[a-f0-9]{40}$/),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  observedShape: z.string().min(1).max(300),
  entries: z.array(FixtureEntrySchema).min(1).max(30),
  journal: z.object({
    file: z.enum([
      'kun-runtime-data-migration-v2.json',
      'kun-runtime-data-migration-v3.json'
    ]),
    document: z.record(z.string(), z.unknown())
  }).strict().optional(),
  expected: FixtureExpectedSchema
}).strict()
type HistoricalFixture = z.infer<typeof FixtureSchema>

const FIXTURE_ROOT = fileURLToPath(new URL('./__fixtures__/runtime-data-migration/', import.meta.url))
const EXPECTED_TAG_PROVENANCE: Record<string, { tagObject: string; commit: string }> = {
  '0.2.29': {
    tagObject: '19a286f5dd6d6da3011531edea9d2961bd8c3714',
    commit: 'f65ac05c0f62d060b7a0cf208ee2941b6ecf41f7'
  },
  '0.2.30': {
    tagObject: 'd42203dd20d059aea257dbbeb69bdcb1e1bf8e35',
    commit: 'caa4dc5f50b65b2e17cd0f7bf9427f4a511cc0d9'
  },
  '0.2.31': {
    tagObject: 'a42343e323e4d2299bfde08de53bab7e274ef525',
    commit: '2f578f61a88985dc7afcc976a3b295ce8a4d5d8b'
  },
  '0.2.32': {
    tagObject: '81d30d322ccbf74c4aa2f49c0243ffa0012cd8cc',
    commit: '25f45f4290ec03528f156aa371a38990aa78792c'
  },
  '0.2.33': {
    tagObject: 'a73d00c8d02a1a719835988a4507c3fe8f600e78',
    commit: '1a6c8f679baf025f6883cf2370e9c3b162f4310c'
  },
  '0.2.34': {
    tagObject: '11fbd261afd298cc3fcb19dd322dc35ec9e1d662',
    commit: 'd86d44455a554b217a1ea03d62c37517b849dee7'
  },
  '0.2.35': {
    tagObject: 'fa788899466a405bc65b89ffead30cb486da12aa',
    commit: '21ef5194c17dc407a65457896bffa64f397aa737'
  }
}
const roots: string[] = []
const fixtures = loadFixtures()

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('v0.2.29-v0.2.35 Runtime migration fixture provenance', () => {
  it('pins every locally audited tag shape without embedding plaintext credentials', () => {
    expect(fixtures.map((fixture) => fixture.version)).toEqual(Object.keys(EXPECTED_TAG_PROVENANCE))
    for (const fixture of fixtures) {
      expect({ tagObject: fixture.tagObject, commit: fixture.commit })
        .toEqual(EXPECTED_TAG_PROVENANCE[fixture.version])
      const raw = readFileSync(join(FIXTURE_ROOT, `v${fixture.version}.json`), 'utf8')
      expect(raw).not.toMatch(/\bsk-[A-Za-z0-9]/)
      expect(raw).not.toMatch(/"apiKey"\s*:/i)
      expect(raw).not.toMatch(/"authorization"\s*:\s*"bearer /i)
      expect(fixture.version <= '0.2.31' ? fixture.journal : undefined).toBeUndefined()
      if (fixture.version >= '0.2.32') expect(fixture.journal).toBeDefined()
    }
  })
})

describe('historical Runtime data recovery scanner fixtures', () => {
  for (const fixture of fixtures) {
    it(`classifies v${fixture.version}: ${fixture.observedShape}`, async () => {
      const materialized = materializeFixture(fixture)
      const recovery = new RuntimeDataDirRecovery({
        homeDir: materialized.homeDir,
        userDataPath: materialized.userDataPath,
        assertRuntimeInactive: () => undefined
      })

      const status = await recovery.getStatus()

      expect(status.state).toBe(fixture.expected.scannerState)
      expect(status.candidates.map((candidate) => candidate.kind)).toEqual(
        fixture.expected.candidateKinds
      )
      if (fixture.expected.equivalentCopies) {
        expect(status.candidates[0]?.equivalentCopies).toBe(fixture.expected.equivalentCopies)
      }
      if (fixture.expected.invalidEvidenceCount !== undefined) {
        expect(status.invalidEvidenceCount).toBe(fixture.expected.invalidEvidenceCount)
      }
      expect(JSON.stringify(status)).not.toContain(materialized.root)
    })
  }
})

describe('historical Runtime migration runner fixtures', () => {
  for (const fixture of fixtures) {
    it(`handles v${fixture.version} without discarding evidence`, () => {
      const materialized = materializeFixture(fixture)
      const journalBefore = fixture.journal
        ? readFileSync(join(materialized.userDataPath, fixture.journal.file), 'utf8')
        : null
      const result = runCanonicalKunRuntimeDataMigration({
        userDataPath: materialized.userDataPath,
        homeDir: materialized.homeDir,
        sleep: () => undefined,
        assertLegacyRuntimeInactive: () => undefined,
        availableCopyBytes: () => 100 * 1024 * 1024 * 1024
      })

      expect(result.status).toBe(fixture.expected.runnerStatus)
      if (result.status === 'completed') {
        expect(lstatSync(canonicalCurrentKunDataDir(materialized.homeDir)).isDirectory()).toBe(true)
        if (fixture.journal) {
          expect(lstatSync(join(materialized.userDataPath, fixture.journal.file)).isFile()).toBe(true)
        }
      } else {
        expect(readFileSync(canonicalCurrentKunDataDir(materialized.homeDir), 'utf8'))
          .toBe('preserved non-directory target evidence\n')
        expect(journalBefore).not.toBeNull()
      }
    })
  }
})

function loadFixtures(): HistoricalFixture[] {
  return readdirSync(FIXTURE_ROOT)
    .filter((name) => /^v0\.2\.(?:29|30|31|32|33|34|35)\.json$/.test(name))
    .sort((left, right) => Number(left.split('.').at(-2)) - Number(right.split('.').at(-2)))
    .map((name) => FixtureSchema.parse(JSON.parse(readFileSync(join(FIXTURE_ROOT, name), 'utf8'))))
}

function materializeFixture(fixture: HistoricalFixture): {
  root: string
  homeDir: string
  userDataPath: string
} {
  const root = mkdtempSync(join(tmpdir(), `kun-v${fixture.version}-`))
  roots.push(root)
  const homeDir = join(root, 'home')
  const userDataPath = join(root, 'user-data')
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(userDataPath, { recursive: true })
  for (const entry of fixture.entries) {
    const target = safeFixturePath(root, entry.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.content, 'utf8')
  }
  if (fixture.journal) {
    const sourcePath = fixturePathToken(
      String(fixture.journal.document.sourcePath ?? ''),
      homeDir,
      userDataPath
    )
    const targetPath = fixturePathToken(
      String(fixture.journal.document.targetPath ?? ''),
      homeDir,
      userDataPath
    )
    const stagingPath = fixturePathToken(
      String(fixture.journal.document.stagingPath ?? ''),
      homeDir,
      userDataPath
    )
    const source = fingerprintIfDirectory(sourcePath)
    const target = fingerprintIfDirectory(targetPath)
    const staging = fingerprintIfDirectory(stagingPath)
    const document = expandFixtureValue(fixture.journal.document, {
      homeDir,
      userDataPath,
      source,
      target,
      staging
    })
    writeFileSync(
      join(userDataPath, fixture.journal.file),
      `${JSON.stringify(document, null, 2)}\n`,
      'utf8'
    )
  }
  return { root, homeDir, userDataPath }
}

type Fingerprint = ReturnType<typeof runtimeDataRecoveryInternals.fingerprintTree> | null

function fingerprintIfDirectory(path: string): Fingerprint {
  if (!path) return null
  try {
    if (!lstatSync(path).isDirectory()) return null
    return runtimeDataRecoveryInternals.fingerprintTree(path)
  } catch {
    return null
  }
}

function expandFixtureValue(
  value: unknown,
  context: {
    homeDir: string
    userDataPath: string
    source: Fingerprint
    target: Fingerprint
    staging: Fingerprint
  }
): unknown {
  if (value === '$SOURCE_INVENTORY') return requiredFingerprint(context.source).inventory
  if (value === '$TARGET_INVENTORY') return requiredFingerprint(context.target).inventory
  if (value === '$STAGING_INVENTORY') return requiredFingerprint(context.staging).inventory
  if (value === '$SOURCE_FINGERPRINT') return requiredFingerprint(context.source).fingerprint
  if (value === '$TARGET_FINGERPRINT') return requiredFingerprint(context.target).fingerprint
  if (value === '$CANDIDATE_FINGERPRINT') return requiredFingerprint(context.staging).fingerprint
  if (typeof value === 'string') return fixturePathToken(value, context.homeDir, context.userDataPath)
  if (Array.isArray(value)) return value.map((entry) => expandFixtureValue(entry, context))
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    expandFixtureValue(entry, context)
  ]))
}

function requiredFingerprint(value: Fingerprint): NonNullable<Fingerprint> {
  if (!value) throw new Error('fixture requested a fingerprint for a missing directory')
  return value
}

function fixturePathToken(value: string, homeDir: string, userDataPath: string): string {
  return value
    .replaceAll('$HOME', homeDir)
    .replaceAll('$USER_DATA', userDataPath)
}

function safeFixturePath(root: string, fixturePath: string): string {
  if (isAbsolute(fixturePath)) throw new Error('fixture entry must be relative')
  const target = resolve(root, fixturePath)
  const fromRoot = relative(root, target)
  if (fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('fixture entry escaped the fixture root')
  }
  return target
}
