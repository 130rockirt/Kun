import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WpsOfficeGateway } from '../ports/wps-office.js'
import { WpsOfficeService } from './wps-office-service.js'

const roots: string[] = []
const zip = (text: string): Uint8Array => new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...Buffer.from(text)])
const sha = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')
const version = { id: 'version-1', updatedAt: '2026-08-28T00:00:00.000Z' }

function gateway(overrides: Partial<WpsOfficeGateway> = {}): WpsOfficeGateway {
  return {
    putDocument: vi.fn(async (input) => ({
      documentId: 'document-1', fileId: 'file-1', format: input.format,
      sourceSha256: input.sourceSha256, version
    })),
    createSession: vi.fn(async () => ({
      sessionId: 'session-1', appId: 'public-app', fileId: 'file-1', officeType: 'word' as const,
      token: 'short-token', expiresAt: '2026-08-28T00:05:00.000Z',
      frameOrigin: 'https://office.example.test'
    })),
    inspect: vi.fn(async () => ({ version, result: { text: 'hello' } })),
    applyOperations: vi.fn(async () => version),
    render: vi.fn(async () => ({ kind: 'image/png' as const, dataBase64: 'AA==' })),
    download: vi.fn(async () => zip('downloaded')),
    delete: vi.fn(async () => undefined),
    ...overrides
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('WpsOfficeService foundation', () => {
  it('uploads a content-addressed workspace document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-wps-office-'))
    roots.push(root)
    const path = join(root, 'reports', 'brief.docx')
    await mkdir(join(root, 'reports'))
    const source = zip('before')
    await writeFile(path, source)
    const fake = gateway()
    const service = new WpsOfficeService({ gateway: fake, workspaceRoot: root, workspaceIdentity: 'workspace-1' })

    await service.upload(path)

    expect(fake.putDocument).toHaveBeenCalledWith(expect.objectContaining({
      relativePath: 'reports/brief.docx', sourceSha256: sha(source),
      idempotencyKey: `upload-${sha(source)}`
    }), undefined)
  })

  it('rejects a gateway document identity that does not match the upload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-wps-office-'))
    roots.push(root)
    const path = join(root, 'brief.docx')
    await writeFile(path, zip('before'))
    const fake = gateway({
      putDocument: vi.fn(async () => ({
        documentId: 'other', fileId: 'other', format: 'pptx' as const,
        sourceSha256: '0'.repeat(64), version
      }))
    })
    const service = new WpsOfficeService({ gateway: fake, workspaceRoot: root, workspaceIdentity: 'workspace-1' })

    await expect(service.upload(path)).rejects.toMatchObject({ code: 'invalid_gateway_response' })
  })

  it('rejects a symlink that escapes the physical workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-wps-office-'))
    const outside = await mkdtemp(join(tmpdir(), 'kun-wps-outside-'))
    roots.push(root, outside)
    const outsidePath = join(outside, 'secret.docx')
    const linkPath = join(root, 'linked.docx')
    await writeFile(outsidePath, zip('secret'))
    await symlink(outsidePath, linkPath)
    const fake = gateway()
    const service = new WpsOfficeService({ gateway: fake, workspaceRoot: root, workspaceIdentity: 'workspace-1' })

    await expect(service.upload(linkPath)).rejects.toThrow(/physically inside/)
    expect(fake.putDocument).not.toHaveBeenCalled()
  })

  it('rejects content whose header does not match the extension', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-wps-office-'))
    roots.push(root)
    const path = join(root, 'brief.docx')
    await writeFile(path, new Uint8Array([1, 2, 3]))
    const fake = gateway()
    const service = new WpsOfficeService({ gateway: fake, workspaceRoot: root, workspaceIdentity: 'workspace-1' })

    await expect(service.upload(path)).rejects.toThrow(/does not match/)
    expect(fake.putDocument).not.toHaveBeenCalled()
  })
})
