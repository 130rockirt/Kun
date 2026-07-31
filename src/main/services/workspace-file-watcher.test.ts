import { EventEmitter } from 'node:events'
import {
  mkdtempSync,
  renameSync,
  rmSync,
  unwatchFile,
  watchFile,
  writeFileSync,
  type Stats
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  isWindowsNetworkPath,
  startWorkspaceFileWatcher,
  type WorkspaceFileWatcherDependencies
} from './workspace-file-watcher'

class FakeNativeWatcher extends EventEmitter {
  close = vi.fn()
}

function fakeDependencies(platform: NodeJS.Platform = 'linux') {
  const nativeWatcher = new FakeNativeWatcher()
  const watch = vi.fn((
    _path: string,
    _options: { persistent: false },
    _listener: (eventType: 'rename' | 'change', filename: string | Buffer | null) => void
  ) => nativeWatcher)
  const watchFileMock = vi.fn()
  const unwatchFileMock = vi.fn()
  const dependencies: WorkspaceFileWatcherDependencies = {
    platform,
    watch,
    watchFile: watchFileMock,
    unwatchFile: unwatchFileMock
  }
  return { dependencies, nativeWatcher, watch, watchFileMock, unwatchFileMock }
}

function callbacks() {
  return {
    onChange: vi.fn(),
    onFallback: vi.fn(),
    onFatalError: vi.fn()
  }
}

describe('workspace file watcher', () => {
  it('recognizes Windows UNC paths without treating local device paths as network paths', () => {
    expect(isWindowsNetworkPath('\\\\nas\\data\\note.md', 'win32')).toBe(true)
    expect(isWindowsNetworkPath('//nas/data/note.md', 'win32')).toBe(true)
    expect(isWindowsNetworkPath('\\\\?\\UNC\\nas\\data\\note.md', 'win32')).toBe(true)
    expect(isWindowsNetworkPath('\\\\?\\C:\\data\\note.md', 'win32')).toBe(false)
    expect(isWindowsNetworkPath('C:\\data\\note.md', 'win32')).toBe(false)
    expect(isWindowsNetworkPath('\\\\nas\\data\\note.md', 'darwin')).toBe(false)
  })

  it('uses polling directly for Windows UNC paths and closes it idempotently', () => {
    const { dependencies, watch, watchFileMock, unwatchFileMock } = fakeDependencies('win32')
    const events = callbacks()
    const targetPath = '\\\\nas\\data\\note.md'
    const handle = startWorkspaceFileWatcher({ targetPath, ...events, dependencies })

    expect(watch).not.toHaveBeenCalled()
    expect(watchFileMock).toHaveBeenCalledWith(
      targetPath,
      { persistent: false, interval: 1_000 },
      expect.any(Function)
    )
    expect(events.onFallback).toHaveBeenCalledWith({ reason: 'windows-network-path' })

    const listener = watchFileMock.mock.calls[0]?.[2] as (current: Stats, previous: Stats) => void
    listener({} as Stats, {} as Stats)
    expect(events.onChange).toHaveBeenCalledOnce()

    handle.close()
    handle.close()
    expect(unwatchFileMock).toHaveBeenCalledOnce()
    expect(unwatchFileMock).toHaveBeenCalledWith(targetPath, listener)
  })

  it('watches a local parent directory and filters unrelated file events', () => {
    const { dependencies, nativeWatcher, watch, watchFileMock } = fakeDependencies()
    const events = callbacks()
    const handle = startWorkspaceFileWatcher({
      targetPath: '/workspace/note.md',
      ...events,
      dependencies
    })

    expect(watch).toHaveBeenCalledWith(
      '/workspace',
      { persistent: false },
      expect.any(Function)
    )
    expect(watchFileMock).not.toHaveBeenCalled()

    const listener = watch.mock.calls[0]?.[2]
    listener('change', 'other.md')
    listener('rename', Buffer.from('note.md'))
    listener('change', null)
    expect(events.onChange).toHaveBeenCalledTimes(2)

    handle.close()
    handle.close()
    expect(nativeWatcher.close).toHaveBeenCalledOnce()
    expect(() => nativeWatcher.emit('error', new Error('queued after close'))).not.toThrow()
  })

  it('falls back to polling when native watcher startup throws', () => {
    const { dependencies, watch, watchFileMock } = fakeDependencies()
    const nativeError = Object.assign(new Error('native unavailable'), { code: 'UNKNOWN' })
    watch.mockImplementation(() => {
      throw nativeError
    })
    const events = callbacks()

    const handle = startWorkspaceFileWatcher({
      targetPath: '/workspace/note.md',
      ...events,
      dependencies
    })

    expect(watchFileMock).toHaveBeenCalledOnce()
    expect(events.onFallback).toHaveBeenCalledWith({
      reason: 'native-start-error',
      error: nativeError
    })
    expect(events.onFatalError).not.toHaveBeenCalled()
    handle.close()
  })

  it('handles native watcher errors and switches to polling only once', () => {
    const { dependencies, nativeWatcher, watchFileMock, unwatchFileMock } = fakeDependencies()
    const events = callbacks()
    const handle = startWorkspaceFileWatcher({
      targetPath: '/workspace/note.md',
      ...events,
      dependencies
    })
    const runtimeError = Object.assign(new Error('unknown error, watch'), { code: 'UNKNOWN' })

    expect(() => nativeWatcher.emit('error', runtimeError)).not.toThrow()
    expect(() => nativeWatcher.emit('error', new Error('queued error'))).not.toThrow()
    expect(nativeWatcher.close).toHaveBeenCalledOnce()
    expect(watchFileMock).toHaveBeenCalledOnce()
    expect(events.onFallback).toHaveBeenCalledOnce()
    expect(events.onFallback).toHaveBeenCalledWith({
      reason: 'native-runtime-error',
      error: runtimeError
    })
    expect(events.onFatalError).not.toHaveBeenCalled()

    handle.close()
    handle.close()
    expect(unwatchFileMock).toHaveBeenCalledOnce()
  })

  it('reports a fatal error when native and polling watchers both fail', () => {
    const { dependencies, nativeWatcher, watchFileMock } = fakeDependencies()
    const events = callbacks()
    const handle = startWorkspaceFileWatcher({
      targetPath: '/workspace/note.md',
      ...events,
      dependencies
    })
    watchFileMock.mockImplementation(() => {
      throw new Error('poll unavailable')
    })

    expect(() => nativeWatcher.emit('error', new Error('native lost'))).not.toThrow()
    expect(events.onFatalError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Native workspace file watcher failed (native lost); polling fallback failed (poll unavailable).'
      })
    )
    handle.close()
  })

  it('contains errors thrown by the fatal error reporter', () => {
    const { dependencies, nativeWatcher, watchFileMock } = fakeDependencies()
    watchFileMock.mockImplementation(() => {
      throw new Error('poll unavailable')
    })
    const handle = startWorkspaceFileWatcher({
      targetPath: '/workspace/note.md',
      onChange: vi.fn(),
      onFallback: vi.fn(),
      onFatalError: () => {
        throw new Error('reporter failed')
      },
      dependencies
    })

    expect(() => nativeWatcher.emit('error', new Error('native lost'))).not.toThrow()
    handle.close()
  })

  it('throws a start error when neither watcher backend can be registered', () => {
    const { dependencies, watch, watchFileMock } = fakeDependencies()
    watch.mockImplementation(() => {
      throw new Error('native unavailable')
    })
    watchFileMock.mockImplementation(() => {
      throw new Error('poll unavailable')
    })

    expect(() => startWorkspaceFileWatcher({
      targetPath: '/workspace/note.md',
      ...callbacks(),
      dependencies
    })).toThrow(
      'Native workspace file watcher failed (native unavailable); polling fallback failed (poll unavailable).'
    )
  })

  it('keeps polling across atomic replacement, deletion, and recovery', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'kun-watch-poll-'))
    const target = join(temp, 'note.md')
    writeFileSync(target, 'one')
    const onChange = vi.fn()
    const dependencies: WorkspaceFileWatcherDependencies = {
      platform: process.platform,
      watch: () => {
        throw new Error('force polling')
      },
      watchFile: (path, options, listener) => {
        watchFile(path, options, listener)
      },
      unwatchFile: (path, listener) => {
        unwatchFile(path, listener)
      }
    }
    let handle: ReturnType<typeof startWorkspaceFileWatcher> | undefined

    try {
      handle = startWorkspaceFileWatcher({
        targetPath: target,
        onChange,
        onFallback: vi.fn(),
        onFatalError: vi.fn(),
        pollIntervalMs: 25,
        dependencies
      })
      await new Promise((resolve) => setTimeout(resolve, 75))

      const staged = join(temp, '.note.tmp')
      writeFileSync(staged, 'two-two')
      renameSync(staged, target)
      await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2_000, interval: 25 })

      onChange.mockClear()
      rmSync(target)
      await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2_000, interval: 25 })

      onChange.mockClear()
      writeFileSync(target, 'recovered-content')
      await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2_000, interval: 25 })
    } finally {
      handle?.close()
      rmSync(temp, { recursive: true, force: true })
    }
  })
})
