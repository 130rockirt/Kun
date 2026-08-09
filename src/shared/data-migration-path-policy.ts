import { z } from 'zod'

import {
  DataMigrationComponentName,
  DataMigrationPolicy,
  DataMigrationPolicySchema,
  DataMigrationPreset,
  DataMigrationSourcePlatform,
  PackageRelativePath,
  parsePackageRelativePath
} from './data-migration-contracts'

export const DEFAULT_DATA_MIGRATION_POLICY: DataMigrationPolicy = Object.freeze(
  DataMigrationPolicySchema.parse({})
)

export type DataMigrationPathScope = 'workspace' | 'runtime' | 'profile'

export type DataMigrationPathPolicyDecision =
  | { action: 'include'; ruleId: 'include' | 'portable-artifact' }
  | { action: 'hard-exclude'; ruleId: string }
  | { action: 'preset-exclude'; ruleId: string }
  | { action: 'require-sensitive-acknowledgement'; ruleId: string }

export type MigrationPathRule = Readonly<{
  id: string
  scopes: readonly DataMigrationPathScope[]
  kind: 'segment' | 'segment-prefix' | 'basename' | 'prefix' | 'suffix'
  value: string
}>

export const DATA_MIGRATION_HARD_EXCLUSION_RULES: readonly MigrationPathRule[] = Object.freeze([
  { id: 'runtime-secret-key', scopes: ['runtime', 'profile'], kind: 'basename', value: 'secret.key' },
  { id: 'runtime-credentials', scopes: ['runtime', 'profile'], kind: 'segment', value: 'credentials' },
  { id: 'runtime-oauth', scopes: ['runtime', 'profile'], kind: 'segment', value: 'mcp-oauth' },
  { id: 'application-logs', scopes: ['runtime', 'profile'], kind: 'segment', value: 'logs' },
  { id: 'observability', scopes: ['runtime', 'profile'], kind: 'segment', value: 'observability' },
  { id: 'local-models', scopes: ['runtime', 'profile'], kind: 'segment', value: 'models' },
  { id: 'downloaded-binaries', scopes: ['runtime', 'profile'], kind: 'segment', value: 'agent-sdk' },
  { id: 'opaque-extension-data', scopes: ['runtime', 'profile'], kind: 'segment', value: 'extension-data' },
  { id: 'migration-staging', scopes: ['workspace', 'runtime', 'profile'], kind: 'segment-prefix', value: '.kun-migration-staging' },
  { id: 'migration-backup', scopes: ['workspace', 'runtime', 'profile'], kind: 'segment', value: '.kun-migration-backup' },
  { id: 'migration-temporary', scopes: ['workspace', 'runtime', 'profile'], kind: 'suffix', value: '.kunpack.tmp' }
])

export const DATA_MIGRATION_SMALLER_PRESET_RULES: readonly MigrationPathRule[] = Object.freeze([
  { id: 'git-metadata', scopes: ['workspace'], kind: 'segment', value: '.git' },
  { id: 'node-dependencies', scopes: ['workspace'], kind: 'segment', value: 'node_modules' },
  { id: 'python-venv', scopes: ['workspace'], kind: 'segment', value: '.venv' },
  { id: 'python-venv-plain', scopes: ['workspace'], kind: 'segment', value: 'venv' },
  { id: 'build-dist', scopes: ['workspace'], kind: 'segment', value: 'dist' },
  { id: 'build-output', scopes: ['workspace'], kind: 'segment', value: 'build' },
  { id: 'build-out', scopes: ['workspace'], kind: 'segment', value: 'out' },
  { id: 'next-cache', scopes: ['workspace'], kind: 'segment', value: '.next' },
  { id: 'coverage-output', scopes: ['workspace'], kind: 'segment', value: 'coverage' },
  { id: 'generic-cache', scopes: ['workspace'], kind: 'segment', value: '.cache' },
  { id: 'python-cache', scopes: ['workspace'], kind: 'segment', value: '__pycache__' },
  { id: 'rust-target', scopes: ['workspace'], kind: 'segment', value: 'target' }
])

export const SENSITIVE_BASENAME_RULES: readonly { id: string; pattern: RegExp }[] = Object.freeze([
  { id: 'environment-file', pattern: /^\.env(?:\..+)?$/i },
  { id: 'private-key-file', pattern: /\.(?:pem|key|p12|pfx)$/i },
  { id: 'ssh-private-key', pattern: /^id_(?:rsa|dsa|ecdsa|ed25519)$/i },
  { id: 'package-registry-auth', pattern: /^(?:\.npmrc|\.pypirc|\.netrc)$/i },
  { id: 'git-credentials', pattern: /^\.git-credentials$/i },
  { id: 'credential-json', pattern: /^(?:credentials?|service-account).+\.json$/i }
])

export const PORTABLE_ARTIFACT_SEGMENTS = new Set(['.kun-design', '.kunsdd'])

export function classifyDataMigrationPath(input: {
  path: string
  scope: DataMigrationPathScope
  preset: DataMigrationPreset
}): DataMigrationPathPolicyDecision {
  const normalized = normalizePolicyPath(input.path)
  const basename = normalized.split('/').at(-1) ?? ''
  const segments = normalized.split('/').filter(Boolean)

  const hardRule = DATA_MIGRATION_HARD_EXCLUSION_RULES.find((rule) =>
    rule.scopes.includes(input.scope) && migrationPathRuleMatches(rule, normalized, basename, segments)
  )
  if (hardRule) return { action: 'hard-exclude', ruleId: hardRule.id }

  if (input.scope === 'workspace') {
    const sensitiveRule = SENSITIVE_BASENAME_RULES.find((rule) => rule.pattern.test(basename))
    if (sensitiveRule) {
      return { action: 'require-sensitive-acknowledgement', ruleId: sensitiveRule.id }
    }
    if (segments.some((segment) => PORTABLE_ARTIFACT_SEGMENTS.has(segment))) {
      return { action: 'include', ruleId: 'portable-artifact' }
    }
  }

  if (input.preset === 'smaller') {
    const presetRule = DATA_MIGRATION_SMALLER_PRESET_RULES.find((rule) =>
      rule.scopes.includes(input.scope) && migrationPathRuleMatches(rule, normalized, basename, segments)
    )
    if (presetRule) return { action: 'preset-exclude', ruleId: presetRule.id }
  }

  return { action: 'include', ruleId: 'include' }
}

export function normalizePolicyPath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/')
}

export function migrationPathRuleMatches(
  rule: MigrationPathRule,
  normalized: string,
  basename: string,
  segments: readonly string[]
): boolean {
  const value = rule.value.toLowerCase()
  switch (rule.kind) {
    case 'segment':
      return segments.some((segment) => segment.toLowerCase() === value)
    case 'segment-prefix':
      return segments.some((segment) => segment.toLowerCase().startsWith(value))
    case 'basename':
      return basename.toLowerCase() === value
    case 'prefix':
      return normalized.toLowerCase().startsWith(value)
    case 'suffix':
      return normalized.toLowerCase().endsWith(value)
  }
}

export type ParsedMigrationSourcePath = {
  platform: DataMigrationSourcePlatform
  kind: 'drive' | 'unc' | 'absolute' | 'home' | 'relative'
  root: string
  segments: string[]
}

export function parseMigrationSourcePath(
  value: string,
  platform: DataMigrationSourcePlatform
): ParsedMigrationSourcePath {
  const trimmed = value.trim()
  if (!trimmed) return { platform, kind: 'relative', root: '', segments: [] }

  if (platform === 'windows') {
    const normalized = trimmed.replaceAll('/', '\\')
    if (normalized.startsWith('\\\\')) {
      const parts = normalized.slice(2).split(/\\+/).filter(Boolean)
      if (parts.length < 2) return { platform, kind: 'relative', root: '', segments: parts }
      return {
        platform,
        kind: 'unc',
        root: `\\\\${parts[0]}\\${parts[1]}`,
        segments: parts.slice(2)
      }
    }
    const drive = /^([A-Za-z]:)\\(.*)$/.exec(normalized)
    if (drive) {
      return {
        platform,
        kind: 'drive',
        root: drive[1].toUpperCase(),
        segments: splitMigrationSegments(drive[2], /\\+/)
      }
    }
    if (/^~(?:\\|$)/.test(normalized)) {
      return {
        platform,
        kind: 'home',
        root: '~',
        segments: splitMigrationSegments(normalized.slice(1), /\\+/)
      }
    }
    return { platform, kind: 'relative', root: '', segments: splitMigrationSegments(normalized, /\\+/) }
  }

  const normalized = trimmed.replaceAll('\\', '/')
  if (normalized === '~' || normalized.startsWith('~/')) {
    return {
      platform,
      kind: 'home',
      root: '~',
      segments: splitMigrationSegments(normalized.slice(1), /\/+/)
    }
  }
  if (normalized.startsWith('/')) {
    return {
      platform,
      kind: 'absolute',
      root: '/',
      segments: splitMigrationSegments(normalized, /\/+/)
    }
  }
  return { platform, kind: 'relative', root: '', segments: splitMigrationSegments(normalized, /\/+/) }
}

export function splitMigrationSegments(value: string, separator: RegExp): string[] {
  return value.split(separator).filter((segment) => segment && segment !== '.')
}

export function migrationPathRelativeToWorkspace(input: {
  path: string
  workspaceRoot: string
  sourcePlatform: DataMigrationSourcePlatform
}): PackageRelativePath | null {
  const path = parseMigrationSourcePath(input.path, input.sourcePlatform)
  const workspace = parseMigrationSourcePath(input.workspaceRoot, input.sourcePlatform)
  if (path.kind !== workspace.kind || migrationComparable(path.root, input.sourcePlatform) !== migrationComparable(workspace.root, input.sourcePlatform)) {
    return null
  }
  if (path.segments.length <= workspace.segments.length) return null
  for (let index = 0; index < workspace.segments.length; index += 1) {
    if (migrationComparable(path.segments[index] ?? '', input.sourcePlatform) !== migrationComparable(workspace.segments[index] ?? '', input.sourcePlatform)) {
      return null
    }
  }
  return parsePackageRelativePath(path.segments.slice(workspace.segments.length).join('/'))
}

export function migrationComparable(value: string, platform: DataMigrationSourcePlatform): string {
  return platform === 'windows' ? value.toLocaleLowerCase('en-US') : value
}

export function buildMigrationDestinationPath(input: {
  destinationRoot: string
  relativePath: PackageRelativePath
  destinationPlatform: DataMigrationSourcePlatform
}): string {
  const separator = input.destinationPlatform === 'windows' ? '\\' : '/'
  const trimmedRoot = input.destinationRoot.trim().replace(/[\\/]+$/, '')
  if (!trimmedRoot) throw new Error('destination root is required')
  return `${trimmedRoot}${separator}${input.relativePath.split('/').join(separator)}`
}

export type DataMigrationComponentEnvelope = {
  component: DataMigrationComponentName
  schemaVersion: number
  data: unknown
}

export type DataMigrationComponentMigrator = Readonly<{
  component: DataMigrationComponentName
  fromVersion: number
  toVersion: number
  migrate: (data: unknown) => unknown
}>

export const DATA_MIGRATION_V1_FIXTURE_CONVENTION = Object.freeze({
  directory: 'src/shared/__fixtures__/data-migration/v1',
  immutable: true,
  manifestFile: 'manifest.json',
  expectedReportFile: 'expected-report.json'
})

export function migrateDataMigrationComponent(
  envelope: DataMigrationComponentEnvelope,
  targetVersion: number,
  migrators: readonly DataMigrationComponentMigrator[]
): DataMigrationComponentEnvelope {
  if (!Number.isInteger(targetVersion) || targetVersion < 1) throw new Error('target version must be a positive integer')
  if (envelope.schemaVersion > targetVersion) throw new Error('component downgrade is not supported')
  let current = { ...envelope }
  const seen = new Set<number>()
  while (current.schemaVersion < targetVersion) {
    if (seen.has(current.schemaVersion)) throw new Error('component migrator cycle detected')
    seen.add(current.schemaVersion)
    const matches = migrators.filter((candidate) =>
      candidate.component === current.component && candidate.fromVersion === current.schemaVersion
    )
    if (matches.length !== 1) {
      throw new Error(matches.length === 0 ? 'missing component migrator' : 'ambiguous component migrator')
    }
    const migrator = matches[0]!
    if (migrator.toVersion <= migrator.fromVersion || migrator.toVersion > targetVersion) {
      throw new Error('invalid component migrator version range')
    }
    current = {
      component: current.component,
      schemaVersion: migrator.toVersion,
      data: migrator.migrate(current.data)
    }
  }
  return current
}
