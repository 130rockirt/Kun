import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OfficeSessionDescriptor, WorkspaceOfficePreviewSuccess } from '@shared/office-document'
import { WpsOfficeEditor, type WpsOfficeSdkBridge } from './WpsOfficeEditor'

const result: WorkspaceOfficePreviewSuccess = {
  ok: true,
  path: '/repo/brief.docx',
  name: 'brief.docx',
  sourceFormat: 'docx',
  renderFormat: 'docx',
  viewer: 'word',
  size: 3,
  mtimeMs: 1,
  sourceSha256: 'a'.repeat(64),
  data: new Uint8Array([1, 2, 3])
}
const session: OfficeSessionDescriptor = {
  sessionId: 'session-1',
  appId: 'public-app',
  fileId: 'file-1',
  officeType: 'word',
  token: 'short-token',
  expiresAt: '2099-08-29T00:05:00.000Z',
  frameOrigin: 'https://office.example.test'
}

describe('WpsOfficeEditor', () => {
  let renderer: ReactTestRenderer

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(async () => {
    if (renderer) await act(async () => renderer.unmount())
  })

  it('fails closed when no short-lived WPS session is available', async () => {
    await act(async () => {
      renderer = create(createElement(WpsOfficeEditor, { result }))
    })
    expect(renderer.root.findByProps({ 'data-office-provider': 'wps' })).toBeTruthy()
    expect(renderer.root.findAllByProps({ className: 'workspace-docx-preview' })).toHaveLength(0)
    expect(JSON.stringify(renderer.toJSON())).toContain('WPS cloud Office is not configured')
    expect(JSON.stringify(renderer.toJSON())).toContain('no local fallback')
  })

  it('mounts and destroys only through the injected reviewed SDK bridge', async () => {
    const destroy = vi.fn()
    const mount = vi.fn(async () => ({ destroy }))
    const sdk: WpsOfficeSdkBridge = { mount }
    const mountNode = {
      replaceChildren: vi.fn()
    } as unknown as HTMLElement
    await act(async () => {
      renderer = create(
        createElement(WpsOfficeEditor, { result, session, sdk }),
        { createNodeMock: (element) => element.type === 'div' ? mountNode : null }
      )
    })
    expect(mount).toHaveBeenCalledWith(expect.objectContaining({ session, readOnly: true }))

    await act(async () => renderer.unmount())
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('never mounts an already expired session', async () => {
    const mount = vi.fn()
    const expiredSession = { ...session, expiresAt: '2020-01-01T00:00:00.000Z' }
    const mountNode = { replaceChildren: vi.fn() } as unknown as HTMLElement
    await act(async () => {
      renderer = create(
        createElement(WpsOfficeEditor, {
          result, session: expiredSession, sdk: { mount }
        }),
        { createNodeMock: (element) => element.type === 'div' ? mountNode : null }
      )
    })
    expect(mount).not.toHaveBeenCalled()
    expect(JSON.stringify(renderer.toJSON())).toContain('session expired')
  })

  it('destroys a mounted SDK instance when a fatal session error arrives', async () => {
    const destroy = vi.fn()
    const sdk: WpsOfficeSdkBridge = { mount: vi.fn(async () => ({ destroy })) }
    const mountNode = { replaceChildren: vi.fn() } as unknown as HTMLElement
    await act(async () => {
      renderer = create(
        createElement(WpsOfficeEditor, { result, session, sdk }),
        { createNodeMock: (element) => element.type === 'div' ? mountNode : null }
      )
    })
    await act(async () => {
      renderer.update(createElement(WpsOfficeEditor, {
        result, session, sdk, error: 'WPS session was revoked.'
      }))
    })
    expect(destroy).toHaveBeenCalledOnce()
    expect(JSON.stringify(renderer.toJSON())).toContain('WPS session was revoked')
  })
})
