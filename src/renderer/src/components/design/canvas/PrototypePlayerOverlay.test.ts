import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DesignArtifact } from '../../../design/design-types'
import {
  PrototypePlayerOverlay,
  buildPrototypeViewportModeScript,
  openPrototypeHtmlInBrowser,
  prototypePlayerHeaderStartInset,
  prototypeViewportFitScale,
  shouldInjectPrototypeNavigationCapture,
  shouldSyncPrototypePlayerToInitialId
} from './PrototypePlayerOverlay'

const now = '2026-06-30T00:00:00.000Z'

function htmlArtifact(id: string, title: string, extra: Partial<DesignArtifact> = {}): DesignArtifact {
  const relativePath = `.kun-design/doc/${id}/v1.html`
  return {
    id,
    kind: 'html',
    title,
    relativePath,
    createdAt: now,
    updatedAt: now,
    versions: [{ id: `${id}-v1`, relativePath, createdAt: now, summary: '' }],
    ...extra
  }
}

describe('PrototypePlayerOverlay', () => {
  it('reserves native window-control space only on macOS', () => {
    expect(prototypePlayerHeaderStartInset('darwin')).toBe(108)
    expect(prototypePlayerHeaderStartInset('win32')).toBe(12)
    expect(prototypePlayerHeaderStartInset('linux')).toBe(12)
    expect(prototypePlayerHeaderStartInset('unknown')).toBe(12)
  })

  it('fits a fixed prototype viewport without changing its intrinsic dimensions', () => {
    expect(prototypeViewportFitScale(1280, 800, 1280, 800)).toBe(1)
    expect(prototypeViewportFitScale(960, 900, 1280, 800)).toBe(0.75)
    expect(prototypeViewportFitScale(1400, 600, 1280, 800)).toBe(0.75)
    expect(prototypeViewportFitScale(0, 600, 1280, 800)).toBe(1)
  })

  it('opens the active HTML artifact through the authorized system-browser bridge', async () => {
    const openPrototype = vi.fn(async () => ({ ok: true }))

    await expect(openPrototypeHtmlInBrowser(
      openPrototype,
      '/workspace',
      '.kun-design/doc/home/v1.html'
    )).resolves.toEqual({ ok: true })
    expect(openPrototype).toHaveBeenCalledWith({
      path: '.kun-design/doc/home/v1.html',
      workspaceRoot: '/workspace'
    })
  })

  it('waits for webview readiness before injecting navigation capture', () => {
    expect(shouldInjectPrototypeNavigationCapture({
      open: true,
      webviewUrl: 'file:///workspace/.kun-design/doc/home/v1.html?rev=1',
      webviewReady: false,
      hasExecuteJavaScript: true
    })).toBe(false)
    expect(shouldInjectPrototypeNavigationCapture({
      open: true,
      webviewUrl: 'file:///workspace/.kun-design/doc/home/v1.html?rev=1',
      webviewReady: true,
      hasExecuteJavaScript: true
    })).toBe(true)
    expect(shouldInjectPrototypeNavigationCapture({
      open: false,
      webviewUrl: 'file:///workspace/.kun-design/doc/home/v1.html?rev=1',
      webviewReady: true,
      hasExecuteJavaScript: true
    })).toBe(false)
    expect(shouldInjectPrototypeNavigationCapture({
      open: true,
      webviewUrl: '',
      webviewReady: true,
      hasExecuteJavaScript: true
    })).toBe(false)
    expect(shouldInjectPrototypeNavigationCapture({
      open: true,
      webviewUrl: 'file:///workspace/.kun-design/doc/home/v1.html?rev=1',
      webviewReady: true,
      hasExecuteJavaScript: false
    })).toBe(false)
  })

  it('syncs playback to a changed external initial screen while open', () => {
    expect(shouldSyncPrototypePlayerToInitialId({
      open: true,
      initialCurrentId: 'threads',
      lastInitialCurrentId: 'home',
      currentId: 'home'
    })).toBe(true)
    expect(shouldSyncPrototypePlayerToInitialId({
      open: true,
      initialCurrentId: 'threads',
      lastInitialCurrentId: 'threads',
      currentId: 'home'
    })).toBe(false)
    expect(shouldSyncPrototypePlayerToInitialId({
      open: true,
      initialCurrentId: 'threads',
      lastInitialCurrentId: 'home',
      currentId: 'threads'
    })).toBe(false)
    expect(shouldSyncPrototypePlayerToInitialId({
      open: false,
      initialCurrentId: 'threads',
      lastInitialCurrentId: 'home',
      currentId: 'home'
    })).toBe(false)
  })

  it('builds app viewport chrome CSS that hides native scrollbars', () => {
    const script = buildPrototypeViewportModeScript('app')

    expect(script).toContain('data-kun-prototype-viewport="app"')
    expect(script).toContain('scrollbar-width: none')
    expect(script).toContain('::-webkit-scrollbar')
    expect(script).toContain('width: 0')
  })

  it('renders macOS playback controls after the native traffic-light safe area', () => {
    const relativePath = '.kun-design/doc/long-title/v15.html'
    const title = '一个很长的中文交互稿页面标题'
    const html = renderToStaticMarkup(
      createElement(PrototypePlayerOverlay, {
        open: true,
        workspaceRoot: '/workspace',
        designTarget: 'web',
        platform: 'darwin',
        artifacts: [htmlArtifact('long-title', title, {
          relativePath,
          versions: [
            { id: 'long-title-v15', relativePath, createdAt: now, summary: 'Current screen' }
          ]
        })],
        initialArtifactId: 'long-title',
        onClose: () => {}
      })
    )

    expect(html).toContain('padding-inline-start:108px')
    expect(html).toContain('aria-label="Back"')
    expect(html).toContain(title)
    expect(html).toContain(`${relativePath} - Web 1280 x 800`)
  })

  it('renders an app-target prototype shell with phone viewport and all screens', () => {
    const html = renderToStaticMarkup(
      createElement(PrototypePlayerOverlay, {
        open: true,
        workspaceRoot: '/workspace',
        designTarget: 'app',
        artifacts: [
          htmlArtifact('home', 'Home', {
            prototypeLinks: [
              {
                targetTitle: 'Settings',
                targetArtifactId: 'settings',
                href: '../settings/v1.html',
                label: 'Open settings'
              }
            ]
          }),
          htmlArtifact('settings', 'Settings')
        ],
        initialArtifactId: 'home',
        onClose: () => {}
      })
    )

    expect(html).toContain('width:390px;height:844px;transform:scale(1)')
    expect(html).toContain('.kun-design/doc/home/v1.html - App 390 x 844')
    expect(html).toContain('aria-label="Prototype viewport"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('aria-label="Open in browser"')
    expect(html).toContain('rounded-[30px]')
    expect(html).not.toContain('ring-[6px]')
    expect(html).toContain('All screens')
    expect(html).toContain('Home')
    expect(html).toContain('Settings')
    expect(html).toContain('.kun-design/doc/home/v1.html')
    expect(html).toContain('.kun-design/doc/settings/v1.html')
  })

  it('renders a web-target prototype shell with desktop viewport fallback', () => {
    const html = renderToStaticMarkup(
      createElement(PrototypePlayerOverlay, {
        open: true,
        workspaceRoot: '/workspace',
        designTarget: 'web',
        artifacts: [htmlArtifact('home', 'Home')],
        initialArtifactId: 'home',
        onClose: () => {}
      })
    )

    expect(html).toContain('width:1280px;height:800px;transform:scale(1)')
    expect(html).toContain('.kun-design/doc/home/v1.html - Web 1280 x 800')
    expect(html).toContain('1280 x 800 web prototype')
    expect(html).toContain('fixed inset-0')
    expect(html).not.toContain('max-h-full max-w-full')
  })

  it('renders the current version path instead of stale screen paths', () => {
    const v1 = '.kun-design/doc/threads/v1.html'
    const v2 = '.kun-design/doc/threads/v2.html'
    const html = renderToStaticMarkup(
      createElement(PrototypePlayerOverlay, {
        open: true,
        workspaceRoot: '/workspace',
        designTarget: 'app',
        artifacts: [
          htmlArtifact('home', 'Home'),
          htmlArtifact('threads', 'Threads', {
            relativePath: v2,
            versions: [
              { id: 'threads-v2', relativePath: v2, createdAt: now, summary: 'Updated interaction pass' },
              { id: 'threads-v1', relativePath: v1, createdAt: now, summary: 'Initial screen' }
            ]
          })
        ],
        initialArtifactId: 'threads',
        onClose: () => {}
      })
    )

    expect(html).toContain(`${v2} - App 390 x 844`)
    expect(html).toContain(`title="${v2}"`)
  })

  it('does not render when closed', () => {
    const html = renderToStaticMarkup(
      createElement(PrototypePlayerOverlay, {
        open: false,
        workspaceRoot: '/workspace',
        designTarget: 'app',
        artifacts: [htmlArtifact('home', 'Home')],
        onClose: () => {}
      })
    )

    expect(html).toBe('')
  })
})
