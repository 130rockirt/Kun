const SHARED_BUSINESS_KEYS = [
  'kun.codeWorkspaceRoots.v1',
  'kun.write.threadRegistry.v1',
  'kun.design.threadRegistry.v1',
  'kun.design-assistant.threadRegistry.v1',
  'kun.threadWorktrees.v1',
  'kun.threadForks.v1',
  'kun.sdd.threadRegistry.v1',
  'kun.plan.registry.v1'
] as const

type SharedEntries = Record<string, string>

type SharedClientStateSnapshot = {
  revision: number
  value: SharedEntries
}

type SharedClientStateApi = {
  read: () => Promise<SharedClientStateSnapshot>
  write: (revision: number, value: SharedEntries) => Promise<SharedClientStateSnapshot>
}

export type SharedBusinessStorageCursor = {
  baseline: SharedEntries
  revision: number
}

export type SharedBusinessStorageSyncResult = SharedBusinessStorageCursor & {
  retry: boolean
}

const POLL_INTERVAL_MS = 1_000
const INITIAL_READ_ATTEMPTS = 3
const INITIAL_READ_RETRY_DELAY_MS = 300

let installPromise: Promise<void> | null = null

// Test-only escape hatch: the production singleton intentionally survives a
// successful install, but unit tests must reset it between scenarios.
export function resetSharedBusinessStorageInstallForTests(): void {
  installPromise = null
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

async function readInitialSnapshot(api: SharedClientStateApi): Promise<SharedClientStateSnapshot> {
  let lastError: unknown
  for (let attempt = 0; attempt < INITIAL_READ_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await delay(INITIAL_READ_RETRY_DELAY_MS)
    try {
      return await api.read()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export async function installSharedBusinessStorage(): Promise<void> {
  if (installPromise) return installPromise
  const promise = doInstallSharedBusinessStorage()
  installPromise = promise
  try {
    await promise
  } catch (error) {
    // Allow a later retry (e.g. the StartupGate retry button) to install again.
    // A settled success keeps `installPromise` so the poller is never duplicated.
    if (installPromise === promise) installPromise = null
    throw error
  }
}

async function doInstallSharedBusinessStorage(): Promise<void> {
  const api = window.kunGui?.sharedClientState
  if (!api || typeof localStorage === 'undefined') return

  let snapshot = await readInitialSnapshot(api)
  const localAtStartup = readLocalEntries()
  if (
    snapshot.revision === 0 &&
    Object.keys(snapshot.value).length === 0 &&
    window.kunGui.appEnvironment.flavor === 'production' &&
    Object.keys(localAtStartup).length > 0
  ) {
    try {
      snapshot = await api.write(snapshot.revision, localAtStartup)
    } catch {
      snapshot = await api.read()
    }
  }
  applyEntries(snapshot.value)
  let baseline = readLocalEntries()
  let revision = snapshot.revision
  let syncing = false

  const sync = async () => {
    if (syncing) return
    syncing = true
    let retry = false
    try {
      const result = await syncSharedBusinessStorageOnce(api, { baseline, revision })
      baseline = result.baseline
      revision = result.revision
      retry = result.retry
    } catch {
      // Manager loss is surfaced by Runtime/settings operations. Keep the
      // profile-local mirror intact and retry when the stable manager returns.
    } finally {
      syncing = false
      if (retry) queueMicrotask(() => void sync())
    }
  }

  const timer = window.setInterval(() => void sync(), POLL_INTERVAL_MS)
  window.addEventListener('beforeunload', () => window.clearInterval(timer), { once: true })
}

/**
 * Reconcile one shared-state poll without allowing an async remote read or
 * compare-and-swap retry to overwrite local writes that happened while it was
 * awaiting. `baseline` is the last acknowledged remote snapshot, not simply
 * the latest local value, so protected late writes remain pending next poll.
 */
export async function syncSharedBusinessStorageOnce(
  api: SharedClientStateApi,
  cursor: SharedBusinessStorageCursor
): Promise<SharedBusinessStorageSyncResult> {
  // Read remote first. Any local mutation during this await is then visible in
  // the snapshot below and will be pushed instead of being overwritten.
  let remote = await api.read()
  let localSnapshot = readLocalEntries()
  let pendingKeys = changedKeys(cursor.baseline, localSnapshot)
  let wrotePendingKeys = false

  if (pendingKeys.length > 0) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // A previous CAS/read await may have admitted newer local writes. Always
      // rebuild the complete pending set against the acknowledged baseline.
      localSnapshot = readLocalEntries()
      pendingKeys = changedKeys(cursor.baseline, localSnapshot)
      if (pendingKeys.length === 0) break
      const merged = { ...remote.value }
      for (const key of pendingKeys) {
        const value = localSnapshot[key]
        if (value === undefined) delete merged[key]
        else merged[key] = value
      }
      try {
        remote = await api.write(remote.revision, merged)
        wrotePendingKeys = true
        break
      } catch {
        remote = await api.read()
      }
    }
  }

  const latestLocal = readLocalEntries()
  const protectedKeys = new Set(changedKeys(localSnapshot, latestLocal))
  if (pendingKeys.length > 0 && !wrotePendingKeys) {
    for (const key of changedKeys(cursor.baseline, latestLocal)) protectedKeys.add(key)
  }

  applyEntries(remote.value, protectedKeys)
  return {
    baseline: sharedEntriesFrom(remote.value),
    revision: remote.revision,
    retry: protectedKeys.size > 0
  }
}

function readLocalEntries(): SharedEntries {
  const entries: SharedEntries = {}
  for (const key of SHARED_BUSINESS_KEYS) {
    const value = localStorage.getItem(key)
    if (value !== null) entries[key] = value
  }
  return entries
}

function sharedEntriesFrom(entries: SharedEntries): SharedEntries {
  const shared: SharedEntries = {}
  for (const key of SHARED_BUSINESS_KEYS) {
    const value = entries[key]
    if (value !== undefined) shared[key] = value
  }
  return shared
}

function applyEntries(entries: SharedEntries, protectedKeys: ReadonlySet<string> = new Set()): void {
  for (const key of SHARED_BUSINESS_KEYS) {
    if (protectedKeys.has(key)) continue
    const next = entries[key]
    const previous = localStorage.getItem(key)
    if (next === undefined) {
      if (previous !== null) localStorage.removeItem(key)
    } else if (previous !== next) {
      localStorage.setItem(key, next)
    }
  }
}

function changedKeys(previous: SharedEntries, current: SharedEntries): string[] {
  return SHARED_BUSINESS_KEYS.filter((key) => previous[key] !== current[key])
}
