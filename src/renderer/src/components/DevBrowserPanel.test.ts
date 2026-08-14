import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildDevPreviewElementInspectionScript,
  canUseElectronWebviewEnvironment,
  mapPreviewPointerToViewport,
  resolveInitialDevBrowserUrl
} from '../lib/dev-preview-panel'
import { DevBrowserPanel } from './DevBrowserPanel'

afterEach(() => vi.unstubAllGlobals())

describe('DevBrowserPanel webview environment detection', () => {
  it('requires the Electron user agent in addition to the shell bridge', () => {
    expect(
      canUseElectronWebviewEnvironment({
        openExternalAvailable: true,
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36'
      })
    ).toBe(false)
  })

  it('allows Electron renderer environments with the shell bridge', () => {
    expect(
      canUseElectronWebviewEnvironment({
        openExternalAvailable: true,
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/132 Safari/537.36 Electron/34.2.0'
      })
    ).toBe(true)
  })

  it('rejects Electron-like pages when the shell bridge is absent', () => {
    expect(
      canUseElectronWebviewEnvironment({
        openExternalAvailable: false,
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/132 Safari/537.36 Electron/34.2.0'
      })
    ).toBe(false)
  })
})

describe('DevBrowserPanel selection mapping', () => {
  it('maps a scaled pointer back into the fixed CSS viewport', () => {
    expect(mapPreviewPointerToViewport({
      clientX: 147.5,
      clientY: 261,
      bounds: { left: 50, top: 50, width: 195, height: 422 },
      viewportWidth: 390,
      viewportHeight: 844
    })).toEqual({ x: 195, y: 422 })
  })

  it('uses a fixed bounded inspection script without collecting values or storage', () => {
    const script = buildDevPreviewElementInspectionScript(12, 34)
    expect(script).toContain('document.elementFromPoint')
    expect(script).toContain("['password', 'hidden', 'file']")
    expect(script).not.toContain('localStorage')
    expect(script).not.toContain('document.cookie')
    expect(script).not.toContain('element.value')
    expect(() => new Function(script)).not.toThrow()
  })

  it('degrades to an iframe and disables Agent-native controls outside Electron', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('window', {
      navigator: { userAgent: 'Mozilla/5.0 Chrome/132 Safari/537.36' },
      kunGui: {},
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key)
      },
      open: vi.fn()
    })
    const html = renderToStaticMarkup(createElement(DevBrowserPanel, {
      blocks: [],
      preferredUrl: 'http://localhost:3000/',
      onCollapse: vi.fn()
    }))
    expect(html).toContain('<iframe')
    expect(html).not.toContain('<webview')
    expect(html).toMatch(/aria-pressed="false"[^>]*disabled|disabled[^>]*aria-pressed="false"/)
  })

  it('exits continuous element selection when Escape is pressed', async () => {
    const listeners = new Map<string, (event: { key: string }) => void>()
    const values = new Map<string, string>()
    vi.stubGlobal('window', {
      navigator: { userAgent: 'Mozilla/5.0 Electron/34.2.0' },
      kunGui: {
        openExternal: vi.fn(async () => undefined),
        captureDevPreviewRegion: vi.fn()
      },
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key)
      },
      addEventListener: (name: string, handler: (event: { key: string }) => void) => listeners.set(name, handler),
      removeEventListener: (name: string) => listeners.delete(name),
      requestAnimationFrame: vi.fn(),
      cancelAnimationFrame: vi.fn(),
      setTimeout,
      clearTimeout
    })
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(DevBrowserPanel, {
        blocks: [],
        preferredUrl: 'http://localhost:3000/',
        onCollapse: vi.fn()
      }))
    })
    const selection = renderer!.root.findAllByType('button').find(
      (button) => button.props['aria-pressed'] === false && button.props.disabled === false
    )
    expect(selection).toBeDefined()
    await act(async () => selection!.props.onClick())
    expect(selection!.props['aria-pressed']).toBe(true)
    await act(async () => listeners.get('keydown')?.({ key: 'Escape' }))
    expect(selection!.props['aria-pressed']).toBe(false)
    await act(async () => renderer!.unmount())
  })

  it('clears page-scoped Preview context when the active thread changes', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('window', {
      navigator: { userAgent: 'Mozilla/5.0 Electron/34.2.0' },
      kunGui: { openExternal: vi.fn(async () => undefined) },
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key)
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      requestAnimationFrame: vi.fn(),
      cancelAnimationFrame: vi.fn(),
      setTimeout,
      clearTimeout
    })
    const onDocumentChange = vi.fn()
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(DevBrowserPanel, {
        blocks: [],
        activeThreadId: 'thread-1',
        preferredUrl: 'http://localhost:3000/',
        onCollapse: vi.fn(),
        onDocumentChange
      }))
    })
    expect(onDocumentChange).not.toHaveBeenCalled()
    await act(async () => {
      renderer!.update(createElement(DevBrowserPanel, {
        blocks: [],
        activeThreadId: 'thread-2',
        preferredUrl: 'http://localhost:3000/',
        onCollapse: vi.fn(),
        onDocumentChange
      }))
    })
    expect(onDocumentChange).toHaveBeenCalledTimes(1)
    await act(async () => renderer!.unmount())
  })
})

describe('DevBrowserPanel initial URL resolution', () => {
  it('stays blank when no preview URL source exists', () => {
    expect(
      resolveInitialDevBrowserUrl({
        normalizedPreferredUrl: null,
        storedUrl: null,
        latestDetectedUrl: null
      })
    ).toBeNull()
  })

  it('prefers explicit preview URL sources in order', () => {
    expect(
      resolveInitialDevBrowserUrl({
        normalizedPreferredUrl: 'http://localhost:3000/',
        storedUrl: 'http://localhost:4000/',
        latestDetectedUrl: 'http://localhost:5000/'
      })
    ).toBe('http://localhost:3000/')

    expect(
      resolveInitialDevBrowserUrl({
        normalizedPreferredUrl: null,
        storedUrl: 'http://localhost:4000/',
        latestDetectedUrl: 'http://localhost:5000/'
      })
    ).toBe('http://localhost:4000/')

    expect(
      resolveInitialDevBrowserUrl({
        normalizedPreferredUrl: null,
        storedUrl: null,
        latestDetectedUrl: 'http://localhost:5000/'
      })
    ).toBe('http://localhost:5000/')
  })
})
