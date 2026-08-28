import { describe, expect, it, vi } from 'vitest'
import { WpsOfficeClient, safeGatewayBaseUrl } from './wps-office-client.js'

function response(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

const document = {
  documentId: 'document-1', fileId: 'file-1', format: 'docx',
  sourceSha256: 'a'.repeat(64),
  version: { id: 'version-1', updatedAt: '2026-08-28T00:00:00.000Z' }
}

describe('WpsOfficeClient', () => {
  it('rejects unsafe gateway URLs', () => {
    expect(() => safeGatewayBaseUrl('http://example.test')).toThrow(/HTTPS/)
    expect(() => safeGatewayBaseUrl('https://user:pass@example.test')).toThrow(/HTTPS/)
    expect(safeGatewayBaseUrl('http://127.0.0.1:9000/v1', true).toString()).toBe('http://127.0.0.1:9000/v1/')
  })

  it('uploads through the fixed tenant boundary without exposing credentials in the URL', async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = []
    const fetcher: typeof globalThis.fetch = async (input, init) => {
      calls.push([input, init])
      return response(document)
    }
    const client = new WpsOfficeClient({
      baseUrl: 'https://gateway.example.test/v1', tenantId: 'tenant-1', fetch: fetcher
    })
    await expect(client.putDocument({
      content: new Uint8Array([1, 2, 3]), format: 'docx', sourceSha256: 'a'.repeat(64),
      workspaceIdentity: 'workspace-1', relativePath: 'reports/a.docx', idempotencyKey: 'upload-key-123456'
    })).resolves.toEqual(document)
    const [url, init] = calls[0]!
    expect(String(url)).toBe('https://gateway.example.test/v1/documents')
    expect((init?.headers as Record<string, string>)['X-Kun-Tenant-Id']).toBe('tenant-1')
    expect(String(url)).not.toContain('tenant-1')
  })

  it('maps conflicts and redacts arbitrary upstream bodies', async () => {
    const client = new WpsOfficeClient({
      baseUrl: 'https://gateway.example.test/v1', tenantId: 'tenant-1',
      fetch: vi.fn(async () => response('appSecret=leaked', 409))
    })
    await expect(client.inspect('document-1', { action: 'summary' }))
      .rejects.toMatchObject({ code: 'remote_changed', message: 'WPS document version changed' })
  })

  it('rejects a chunked response that crosses the limit without Content-Length', async () => {
    const oversized = new Uint8Array(6 * 1024 * 1024 + 1)
    const client = new WpsOfficeClient({
      baseUrl: 'https://gateway.example.test/v1', tenantId: 'tenant-1',
      fetch: vi.fn(async () => new Response(oversized))
    })
    await expect(client.inspect('document-1', { action: 'summary' }))
      .rejects.toMatchObject({ code: 'invalid_gateway_response' })
  })

  it('rejects malformed successful responses', async () => {
    const client = new WpsOfficeClient({
      baseUrl: 'https://gateway.example.test/v1', tenantId: 'tenant-1',
      fetch: vi.fn(async () => response('{broken'))
    })
    await expect(client.inspect('document-1', { action: 'summary' }))
      .rejects.toMatchObject({ code: 'invalid_gateway_response' })
  })
})
