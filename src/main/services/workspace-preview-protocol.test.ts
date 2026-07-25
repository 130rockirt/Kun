import { EventEmitter } from 'node:events'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  KUN_WORKSPACE_PREVIEW_SCHEME,
  WorkspacePreviewProtocolRegistry,
  parseWorkspaceByteRange,
  parseWorkspacePreviewUrl,
  sanitizeStaticHtml
} from './workspace-preview-protocol'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(path)
  return path
}

function createSender(id = 42): EventEmitter & { id: number } {
  return Object.assign(new EventEmitter(), { id })
}

describe('workspace preview protocol', () => {
  it('creates opaque leases and serves byte ranges', async () => {
    const workspaceRoot = await createTemporaryDirectory('kun-workspace-preview-')
    await writeFile(join(workspaceRoot, 'clip.mp4'), Buffer.from('0123456789'))
    let handler: ((request: Request) => Promise<Response>) | undefined
    const protocol = {
      unhandle: vi.fn(),
      handle: vi.fn((_scheme: string, next: (request: Request) => Promise<Response>) => {
        handler = next
      })
    }
    const registry = new WorkspacePreviewProtocolRegistry({
      randomToken: () => 'abcdefghijklmnopqrstuvwxyzABCDEFGH123456789'
    })
    registry.register(protocol as never)

    const lease = await registry.createLease(
      createSender() as never,
      { workspaceRoot, path: 'clip.mp4' }
    )
    expect(lease).toEqual(expect.objectContaining({
      ok: true,
      url: expect.stringMatching(/^kun-workspace-preview:\/\/lease\//),
      mimeType: 'video/mp4'
    }))
    if (!lease.ok || !handler) return

    const response = await handler(new Request(lease.url, { headers: { Range: 'bytes=2-5' } }))
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('2345')
  })

  it('blocks symlink escapes and releases leases when the sender is destroyed', async () => {
    const workspaceRoot = await createTemporaryDirectory('kun-workspace-preview-root-')
    const outsideRoot = await createTemporaryDirectory('kun-workspace-preview-outside-')
    await writeFile(join(outsideRoot, 'outside.mp3'), 'secret')
    await symlink(join(outsideRoot, 'outside.mp3'), join(workspaceRoot, 'outside.mp3'))
    const registry = new WorkspacePreviewProtocolRegistry()
    const sender = createSender()

    const escaped = await registry.createLease(sender as never, {
      workspaceRoot,
      path: 'outside.mp3'
    })
    expect(escaped).toEqual(expect.objectContaining({ ok: false }))

    await writeFile(join(workspaceRoot, 'inside.mp3'), 'audio')
    const valid = await registry.createLease(sender as never, {
      workspaceRoot,
      path: 'inside.mp3'
    })
    expect(valid.ok).toBe(true)
    if (!valid.ok) return
    sender.emit('destroyed')
    expect(registry.release(sender.id, valid.leaseId)).toEqual({
      ok: false,
      message: 'Preview resource lease is unavailable.'
    })
  })

  it('sanitizes active HTML and rejects malformed URLs and ranges', () => {
    expect(sanitizeStaticHtml(
      '<button onclick="alert(1)">x</button><script>alert(2)</script><a href="javascript:alert(3)">a</a>'
    )).toBe('<button>x</button><a>a</a>')
    expect(() => parseWorkspacePreviewUrl(`${KUN_WORKSPACE_PREVIEW_SCHEME}://other/token/file.png`))
      .toThrow()
    expect(parseWorkspaceByteRange('bytes=-4', 10)).toEqual({ start: 6, end: 9, length: 4 })
    expect(() => parseWorkspaceByteRange('bytes=20-30', 10)).toThrow()
  })
})
