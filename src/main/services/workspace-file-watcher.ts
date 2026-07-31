import {
  watch as nodeWatch,
  watchFile as nodeWatchFile,
  unwatchFile as nodeUnwatchFile,
  type Stats
} from 'node:fs'
import { basename, dirname } from 'node:path'

export const WORKSPACE_FILE_POLL_INTERVAL_MS = 1_000

type NativeWatchEventListener = (
  eventType: 'rename' | 'change',
  filename: string | Buffer | null
) => void

type NativeWatcher = {
  close: () => void
  on: (event: 'error', listener: (error: Error) => void) => unknown
  removeListener: (event: 'error', listener: (error: Error) => void) => unknown
}

type PollingWatchListener = (current: Stats, previous: Stats) => void

export type WorkspaceFileWatcherDependencies = {
  platform: NodeJS.Platform
  watch: (
    path: string,
    options: { persistent: false },
    listener: NativeWatchEventListener
  ) => NativeWatcher
  watchFile: (
    path: string,
    options: { persistent: false; interval: number },
    listener: PollingWatchListener
  ) => void
  unwatchFile: (path: string, listener: PollingWatchListener) => void
}

export type WorkspaceFileWatcherFallbackReason =
  | 'windows-network-path'
  | 'native-start-error'
  | 'native-runtime-error'

export type WorkspaceFileWatcherFallback = {
  reason: WorkspaceFileWatcherFallbackReason
  error?: Error
}

export type WorkspaceFileWatcherHandle = {
  close: () => void
}

type StartWorkspaceFileWatcherOptions = {
  targetPath: string
  onChange: () => void
  onFallback: (fallback: WorkspaceFileWatcherFallback) => void
  onFatalError: (error: Error) => void
  pollIntervalMs?: number
  dependencies?: WorkspaceFileWatcherDependencies
}

const defaultDependencies: WorkspaceFileWatcherDependencies = {
  platform: process.platform,
  watch: (path, options, listener) => nodeWatch(path, options, listener),
  watchFile: (path, options, listener) => {
    nodeWatchFile(path, options, listener)
  },
  unwatchFile: (path, listener) => {
    nodeUnwatchFile(path, listener)
  }
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function fallbackStartError(nativeError: Error | null, pollingError: Error): Error {
  if (!nativeError) {
    return new Error(`Polling workspace file watcher failed: ${pollingError.message}`, {
      cause: pollingError
    })
  }
  return new Error(
    `Native workspace file watcher failed (${nativeError.message}); polling fallback failed (${pollingError.message}).`,
    { cause: pollingError }
  )
}

export function isWindowsNetworkPath(
  targetPath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'win32') return false
  const normalized = targetPath.replaceAll('/', '\\')
  if (/^\\\\\?\\UNC\\/i.test(normalized)) return true
  if (/^\\\\[?.]\\/.test(normalized)) return false
  return /^\\\\[^\\]+\\[^\\]+/.test(normalized)
}

export function startWorkspaceFileWatcher(
  options: StartWorkspaceFileWatcherOptions
): WorkspaceFileWatcherHandle {
  const dependencies = options.dependencies ?? defaultDependencies
  const pollIntervalMs = options.pollIntervalMs ?? WORKSPACE_FILE_POLL_INTERVAL_MS
  let closed = false
  let nativeWatcher: NativeWatcher | null = null
  let nativeErrorListener: ((error: Error) => void) | null = null
  let pollingListener: PollingWatchListener | null = null

  const reportFallback = (fallback: WorkspaceFileWatcherFallback): void => {
    try {
      options.onFallback(fallback)
    } catch {
      // Diagnostics must never disable an otherwise healthy watcher.
    }
  }

  const closeNative = (swallowFutureErrors: boolean): void => {
    const watcher = nativeWatcher
    const errorListener = nativeErrorListener
    nativeWatcher = null
    nativeErrorListener = null
    if (!watcher) return
    if (errorListener) watcher.removeListener('error', errorListener)
    if (swallowFutureErrors) {
      // A failed FSWatcher is unusable, but some network providers can queue
      // more than one error. Keep those errors from escaping EventEmitter.
      watcher.on('error', () => undefined)
    }
    watcher.close()
  }

  const startPolling = (fallback: WorkspaceFileWatcherFallback): void => {
    if (closed || pollingListener) return
    const listener: PollingWatchListener = () => {
      if (!closed) options.onChange()
    }
    dependencies.watchFile(
      options.targetPath,
      { persistent: false, interval: pollIntervalMs },
      listener
    )
    pollingListener = listener
    reportFallback(fallback)
  }

  const switchToPolling = (fallback: WorkspaceFileWatcherFallback): void => {
    try {
      closeNative(true)
    } catch {
      // An errored native watcher is already unusable. Polling can still keep
      // the open workspace file synchronized even if close() also fails.
    }
    try {
      startPolling(fallback)
    } catch (error) {
      try {
        options.onFatalError(fallbackStartError(fallback.error ?? null, errorFromUnknown(error)))
      } catch {
        // A failure reporter must not recreate the uncaught watcher error that
        // this fallback is designed to contain.
      }
    }
  }

  const startNative = (): void => {
    const watchedDirectory = dirname(options.targetPath)
    const watchedName = basename(options.targetPath)
    const watcher = dependencies.watch(
      watchedDirectory,
      { persistent: false },
      (_eventType, filename) => {
        if (filename && basename(filename.toString()) !== watchedName) return
        if (!closed) options.onChange()
      }
    )
    const onError = (error: Error): void => {
      if (closed || nativeWatcher !== watcher) return
      switchToPolling({ reason: 'native-runtime-error', error: errorFromUnknown(error) })
    }
    nativeWatcher = watcher
    nativeErrorListener = onError
    watcher.on('error', onError)
  }

  if (isWindowsNetworkPath(options.targetPath, dependencies.platform)) {
    try {
      startPolling({ reason: 'windows-network-path' })
    } catch (error) {
      throw fallbackStartError(null, errorFromUnknown(error))
    }
  } else {
    try {
      startNative()
    } catch (nativeError) {
      const normalizedNativeError = errorFromUnknown(nativeError)
      try {
        closeNative(false)
      } catch {
        // The polling fallback remains useful even if native cleanup fails.
      }
      try {
        startPolling({ reason: 'native-start-error', error: normalizedNativeError })
      } catch (pollingError) {
        throw fallbackStartError(normalizedNativeError, errorFromUnknown(pollingError))
      }
    }
  }

  return {
    close: () => {
      if (closed) return
      closed = true
      let closeError: unknown
      try {
        closeNative(true)
      } catch (error) {
        closeError = error
      }
      const listener = pollingListener
      pollingListener = null
      if (listener) {
        try {
          dependencies.unwatchFile(options.targetPath, listener)
        } catch (error) {
          closeError ??= error
        }
      }
      if (closeError !== undefined) throw closeError
    }
  }
}
