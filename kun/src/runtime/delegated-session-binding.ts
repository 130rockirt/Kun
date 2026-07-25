import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { TurnItem } from '../contracts/items.js'
import { effectiveHistoryAfterLatestCompaction } from '../loop/compaction-history.js'

export type DelegatedProviderKind = 'agent-sdk' | 'cursor-sdk' | 'antigravity-cli'
export type DelegatedContinuationMode = 'native' | 'portable'

export type DelegatedSessionRoute = {
  providerKind: DelegatedProviderKind
  providerId: string
  credentialIdentity: string
  workspace: string
  model: string
  capabilityFingerprint: string
  continuationMode: DelegatedContinuationMode
}

export type DelegatedSessionBinding = DelegatedSessionRoute & {
  schemaVersion: 1
  threadId: string
  generation: number
  nativeSessionId?: string
  synchronizedHistoryDigest: string
  lastCommittedTurnId: string
  createdAt: string
  updatedAt: string
}

export type DelegatedSessionPreparation = {
  threadId: string
  generation: number
  route: DelegatedSessionRoute
  priorHistoryDigest: string
  nativeSessionId?: string
  resumed: boolean
  rebaseReason?:
    | 'new'
    | 'route_changed'
    | 'capabilities_changed'
    | 'history_changed'
    | 'native_state_unavailable'
}

export interface DelegatedSessionBindingStore {
  load(threadId: string): Promise<DelegatedSessionBinding | null>
  save(binding: DelegatedSessionBinding): Promise<void>
  delete(threadId: string): Promise<void>
  clearProviderState(providerKind: DelegatedProviderKind, threadId: string): Promise<void>
  providerStateDir(providerKind: DelegatedProviderKind, threadId: string): string
}

const BINDING_SCHEMA_VERSION = 1
const MAX_NATIVE_SESSION_ID_LENGTH = 1_024
const MAX_IDENTITY_LENGTH = 1_024

export class FileDelegatedSessionBindingStore implements DelegatedSessionBindingStore {
  private readonly bindingDir: string
  private readonly stateDir: string

  constructor(private readonly rootDir: string) {
    this.bindingDir = join(rootDir, 'bindings')
    this.stateDir = join(rootDir, 'provider-state')
  }

  async load(threadId: string): Promise<DelegatedSessionBinding | null> {
    const path = this.bindingPath(threadId)
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
      const binding = parseBinding(parsed)
      if (!binding || binding.threadId !== threadId) {
        await unlink(path).catch(() => undefined)
        return null
      }
      return binding
    } catch (error) {
      if (isMissingFile(error)) return null
      await unlink(path).catch(() => undefined)
      return null
    }
  }

  async save(binding: DelegatedSessionBinding): Promise<void> {
    const parsed = parseBinding(binding)
    if (!parsed) throw new Error('invalid delegated session binding')
    await mkdir(this.bindingDir, { recursive: true, mode: 0o700 })
    const target = this.bindingPath(binding.threadId)
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    try {
      await rename(temporary, target)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  async delete(threadId: string): Promise<void> {
    await Promise.allSettled([
      unlink(this.bindingPath(threadId)),
      rm(this.providerStateRoot(threadId), { recursive: true, force: true })
    ])
  }

  async clearProviderState(
    providerKind: DelegatedProviderKind,
    threadId: string
  ): Promise<void> {
    const directory = this.providerStateDir(providerKind, threadId)
    await rm(directory, { recursive: true, force: true })
    await mkdir(directory, { recursive: true, mode: 0o700 })
  }

  providerStateDir(providerKind: DelegatedProviderKind, threadId: string): string {
    return join(this.providerStateRoot(threadId), providerKind)
  }

  private bindingPath(threadId: string): string {
    return join(this.bindingDir, `${threadKey(threadId)}.json`)
  }

  private providerStateRoot(threadId: string): string {
    return join(this.stateDir, threadKey(threadId))
  }
}

export class DelegatedSessionCoordinator {
  private readonly leases = new Map<string, Promise<void>>()

  constructor(
    readonly store: DelegatedSessionBindingStore,
    private readonly nowIso: () => string = () => new Date().toISOString()
  ) {}

  async runExclusive<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.leases.get(threadId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolveLease) => {
      release = resolveLease
    })
    const tail = previous.catch(() => undefined).then(() => current)
    this.leases.set(threadId, tail)
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (this.leases.get(threadId) === tail) this.leases.delete(threadId)
    }
  }

  async prepare(input: {
    threadId: string
    route: DelegatedSessionRoute
    priorItems: readonly TurnItem[]
  }): Promise<DelegatedSessionPreparation> {
    const priorHistoryDigest = delegatedHistoryDigest(input.priorItems)
    const binding = await this.store.load(input.threadId)
    const routeMatches = binding ? sameRoute(binding, input.route) : false
    const portableAligned = Boolean(
      binding &&
      routeMatches &&
      input.route.continuationMode === 'portable' &&
      binding.continuationMode === 'portable' &&
      binding.synchronizedHistoryDigest === priorHistoryDigest
    )
    const canResume = Boolean(
      binding &&
      routeMatches &&
      input.route.continuationMode === 'native' &&
      binding.continuationMode === 'native' &&
      binding.nativeSessionId &&
      binding.synchronizedHistoryDigest === priorHistoryDigest
    )
    if (binding && canResume) {
      return {
        threadId: input.threadId,
        generation: binding.generation,
        route: input.route,
        priorHistoryDigest,
        nativeSessionId: binding.nativeSessionId,
        resumed: true
      }
    }
    if (binding && portableAligned) {
      return {
        threadId: input.threadId,
        generation: binding.generation,
        route: input.route,
        priorHistoryDigest,
        resumed: false
      }
    }
    if (binding) {
      const providerKinds = new Set<DelegatedProviderKind>([
        binding.providerKind,
        input.route.providerKind
      ])
      await Promise.all(
        [...providerKinds].map((providerKind) =>
          this.store.clearProviderState(providerKind, input.threadId)
        )
      )
    }
    return {
      threadId: input.threadId,
      generation: (binding?.generation ?? 0) + 1,
      route: input.route,
      priorHistoryDigest,
      resumed: false,
      rebaseReason: rebaseReason(binding, input.route, priorHistoryDigest)
    }
  }

  async commit(input: {
    preparation: DelegatedSessionPreparation
    committedItems: readonly TurnItem[]
    lastCommittedTurnId: string
    nativeSessionId?: string
  }): Promise<DelegatedSessionBinding> {
    const previous = await this.store.load(input.preparation.threadId)
    if (
      previous &&
      previous.generation > input.preparation.generation
    ) {
      throw new Error('delegated session generation was superseded')
    }
    const now = this.nowIso()
    const nativeSessionId = validNativeSessionId(input.nativeSessionId)
    const continuationMode =
      input.preparation.route.continuationMode === 'native' && nativeSessionId
        ? 'native'
        : 'portable'
    const binding: DelegatedSessionBinding = {
      schemaVersion: BINDING_SCHEMA_VERSION,
      threadId: input.preparation.threadId,
      generation: input.preparation.generation,
      ...input.preparation.route,
      continuationMode,
      ...(nativeSessionId ? { nativeSessionId } : {}),
      synchronizedHistoryDigest: delegatedHistoryDigest(input.committedItems),
      lastCommittedTurnId: input.lastCommittedTurnId,
      createdAt:
        previous?.generation === input.preparation.generation
          ? previous.createdAt
          : now,
      updatedAt: now
    }
    await this.store.save(binding)
    return binding
  }

  async rejectResume(
    preparation: DelegatedSessionPreparation
  ): Promise<DelegatedSessionPreparation> {
    await this.store.clearProviderState(
      preparation.route.providerKind,
      preparation.threadId
    )
    return {
      ...preparation,
      generation: preparation.generation + 1,
      nativeSessionId: undefined,
      resumed: false,
      rebaseReason: 'native_state_unavailable'
    }
  }

  async invalidate(threadId: string): Promise<void> {
    await this.runExclusive(threadId, () => this.store.delete(threadId))
  }
}

export function delegatedHistoryDigest(items: readonly TurnItem[]): string {
  const effective = effectiveHistoryAfterLatestCompaction(items)
  return sha256(stableStringify(effective.map(digestItem)))
}

export function delegatedCapabilityFingerprint(value: unknown): string {
  return sha256(stableStringify(value))
}

export function delegatedCredentialIdentity(input: {
  providerId: string
  accountId?: string
  credentialSourceId?: string
  credentialSecret?: string
}): string {
  const parts = [
    ...(input.accountId?.trim() ? [`account:${input.accountId.trim()}`] : []),
    ...(input.credentialSourceId?.trim()
      ? [`credential-source:${input.credentialSourceId.trim()}`]
      : []),
    ...(input.credentialSecret?.trim()
      ? [`credential-secret:${input.credentialSecret.trim()}`]
      : [])
  ]
  if (parts.length === 0) {
    parts.push(`provider-config:${input.providerId.trim() || 'default'}`)
  }
  return `sha256:${sha256(parts.join('\n'))}`
}

export function priorItemsForDelegatedTurn(
  items: readonly TurnItem[],
  currentTurnId: string
): TurnItem[] {
  return items.filter((item) => item.turnId !== currentTurnId)
}

function sameRoute(
  binding: DelegatedSessionBinding,
  route: DelegatedSessionRoute
): boolean {
  return binding.providerKind === route.providerKind &&
    binding.providerId === route.providerId &&
    binding.credentialIdentity === route.credentialIdentity &&
    binding.workspace === route.workspace &&
    binding.model === route.model &&
    binding.capabilityFingerprint === route.capabilityFingerprint &&
    binding.continuationMode === route.continuationMode
}

function rebaseReason(
  binding: DelegatedSessionBinding | null,
  route: DelegatedSessionRoute,
  historyDigest: string
): DelegatedSessionPreparation['rebaseReason'] {
  if (!binding) return 'new'
  if (
    binding.providerKind !== route.providerKind ||
    binding.providerId !== route.providerId ||
    binding.credentialIdentity !== route.credentialIdentity ||
    binding.workspace !== route.workspace ||
    binding.model !== route.model ||
    binding.continuationMode !== route.continuationMode
  ) return 'route_changed'
  if (binding.capabilityFingerprint !== route.capabilityFingerprint) {
    return 'capabilities_changed'
  }
  if (binding.synchronizedHistoryDigest !== historyDigest) return 'history_changed'
  return 'native_state_unavailable'
}

function digestItem(item: TurnItem): unknown {
  const {
    createdAt: _createdAt,
    finishedAt: _finishedAt,
    ...semantic
  } = item
  return semantic
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  ).join(',')}}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function threadKey(threadId: string): string {
  return sha256(threadId)
}

function validNativeSessionId(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized && normalized.length <= MAX_NATIVE_SESSION_ID_LENGTH
    ? normalized
    : undefined
}

function parseBinding(value: unknown): DelegatedSessionBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const providerKind = record.providerKind
  const continuationMode = record.continuationMode
  if (
    record.schemaVersion !== BINDING_SCHEMA_VERSION ||
    typeof record.threadId !== 'string' ||
    !record.threadId ||
    !Number.isInteger(record.generation) ||
    Number(record.generation) < 1 ||
    (
      providerKind !== 'agent-sdk' &&
      providerKind !== 'cursor-sdk' &&
      providerKind !== 'antigravity-cli'
    ) ||
    (continuationMode !== 'native' && continuationMode !== 'portable') ||
    !boundedString(record.providerId) ||
    !boundedString(record.credentialIdentity) ||
    !boundedString(record.workspace, 16_384) ||
    !boundedString(record.model) ||
    !hexDigest(record.capabilityFingerprint) ||
    !hexDigest(record.synchronizedHistoryDigest) ||
    !boundedString(record.lastCommittedTurnId) ||
    !boundedString(record.createdAt) ||
    !boundedString(record.updatedAt) ||
    (
      record.nativeSessionId !== undefined &&
      !boundedString(record.nativeSessionId, MAX_NATIVE_SESSION_ID_LENGTH)
    )
  ) return null
  return record as DelegatedSessionBinding
}

function boundedString(value: unknown, max = MAX_IDENTITY_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function hexDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

export function delegatedSessionRoot(dataDir: string): string {
  return resolve(dataDir, 'delegated-sessions')
}
