import { describe, expect, it } from 'vitest'
import {
  WpsOfficeDocumentRefSchema,
  WpsOfficeSessionSchema
} from './wps-office.js'

const version = { id: 'version-1', updatedAt: '2026-08-28T00:00:00.000Z' }

describe('WPS Office contracts', () => {
  it('accepts a bounded cloud document identity', () => {
    expect(WpsOfficeDocumentRefSchema.parse({
      documentId: 'document-1',
      fileId: 'file-1',
      format: 'docx',
      sourceSha256: 'a'.repeat(64),
      version
    })).toMatchObject({ documentId: 'document-1', format: 'docx' })
  })

  it('requires an exact credential-free HTTPS frame origin', () => {
    const base = {
      sessionId: 'session-1', appId: 'public-app', fileId: 'file-1',
      officeType: 'word', token: 'short-token',
      expiresAt: '2026-08-28T00:05:00.000Z'
    }
    expect(WpsOfficeSessionSchema.safeParse({ ...base, frameOrigin: 'https://office.example.test' }).success).toBe(true)
    expect(WpsOfficeSessionSchema.safeParse({ ...base, frameOrigin: 'http://office.example.test' }).success).toBe(false)
    expect(WpsOfficeSessionSchema.safeParse({ ...base, frameOrigin: 'https://user:pass@office.example.test' }).success).toBe(false)
    expect(WpsOfficeSessionSchema.safeParse({ ...base, frameOrigin: 'https://office.example.test/path' }).success).toBe(false)
  })

  it('rejects unknown and secret-looking document fields', () => {
    expect(WpsOfficeDocumentRefSchema.safeParse({
      documentId: 'document-1', fileId: 'file-1', format: 'docx',
      sourceSha256: 'a'.repeat(64), version, appSecret: 'must-not-cross-boundary'
    }).success).toBe(false)
  })
})
