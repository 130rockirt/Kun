import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { BackgroundShellOverlay } from './BackgroundShellOverlay'

type RuntimeRequestResult = {
  ok: boolean
  status: number
  body: string
}

function backgroundShell(id: string, threadId: string, command: string): Record<string, unknown> {
  return {
    id,
    threadId,
    turnId: `turn-${threadId}`,
    command,
    cwd: '/workspace',
    shell: 'zsh',
    status: 'running',
    startedAt: '2026-07-24T00:00:00.000Z',
    exitCode: null,
    output: '',
    detached: true
  }
}

function response(sessions: Array<Record<string, unknown>>): RuntimeRequestResult {
  return {
    ok: true,
    status: 200,
    body: JSON.stringify({ sessions, running: sessions.length })
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function renderedText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON())
}

async function openOverlay(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    renderer.root.findByType('button').props.onClick()
  })
}

describe('BackgroundShellOverlay', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requests and displays background shells only for the active thread', async () => {
    const runtimeRequest = vi.fn(async () => response([
      backgroundShell('shell-a', 'thread-a', 'npm run test:a'),
      backgroundShell('shell-b', 'thread-b', 'npm run test:b')
    ]))
    vi.stubGlobal('window', {
      clearInterval,
      setInterval,
      kunGui: { runtimeRequest }
    })
    let renderer!: ReactTestRenderer

    await act(async () => {
      renderer = create(createElement(BackgroundShellOverlay, {
        runtimeReady: true,
        threadId: 'thread-a'
      }))
      await Promise.resolve()
    })

    expect(runtimeRequest).toHaveBeenCalledWith('/v1/background-shells?thread_id=thread-a')
    await openOverlay(renderer)
    expect(renderedText(renderer)).toContain('npm run test:a')
    expect(renderedText(renderer)).not.toContain('npm run test:b')

    act(() => renderer.unmount())
  })

  it('ignores an earlier response after the active thread changes', async () => {
    const first = deferred<RuntimeRequestResult>()
    const second = deferred<RuntimeRequestResult>()
    const runtimeRequest = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    vi.stubGlobal('window', {
      clearInterval,
      setInterval,
      kunGui: { runtimeRequest }
    })
    let renderer!: ReactTestRenderer

    await act(async () => {
      renderer = create(createElement(BackgroundShellOverlay, {
        runtimeReady: true,
        threadId: 'thread-a'
      }))
      await Promise.resolve()
    })
    await act(async () => {
      renderer.update(createElement(BackgroundShellOverlay, {
        runtimeReady: true,
        threadId: 'thread-b'
      }))
      await Promise.resolve()
    })

    second.resolve(response([backgroundShell('shell-b', 'thread-b', 'current command')]))
    await act(async () => {
      await second.promise
    })
    await openOverlay(renderer)
    expect(renderedText(renderer)).toContain('current command')

    first.resolve(response([backgroundShell('shell-a', 'thread-a', 'stale command')]))
    await act(async () => {
      await first.promise
    })
    expect(renderedText(renderer)).toContain('current command')
    expect(renderedText(renderer)).not.toContain('stale command')

    act(() => renderer.unmount())
  })
})
