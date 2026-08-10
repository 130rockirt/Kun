import { describe, expect, it } from 'vitest'
import {
  devPreviewUrlRejectionReason,
  isAllowedDevPreviewUrl,
  normalizeDevPreviewUrlInput
} from './dev-preview-url'

describe('dev-preview-url public URL support', () => {
  it('allows public http(s) URLs', () => {
    expect(normalizeDevPreviewUrlInput('https://example.com')).toBe('https://example.com/')
    expect(devPreviewUrlRejectionReason('https://example.com')).toBeNull()
    expect(isAllowedDevPreviewUrl('https://example.com')).toBe(true)
    expect(normalizeDevPreviewUrlInput('http://github.com/openai')).toBe('http://github.com/openai')
    expect(normalizeDevPreviewUrlInput('https://example.com:8443/path?q=1')).toBe(
      'https://example.com:8443/path?q=1'
    )
    expect(normalizeDevPreviewUrlInput('example.com')).toBe('http://example.com/')
  })

  it('rejects non-http(s) schemes with the scheme reason', () => {
    expect(devPreviewUrlRejectionReason('file:///tmp/a.html')).toBe('scheme')
    expect(devPreviewUrlRejectionReason('javascript:alert(1)')).toBe('scheme')
    expect(devPreviewUrlRejectionReason('data:text/html,<h1>hi</h1>')).toBe('scheme')
    expect(normalizeDevPreviewUrlInput('file:///tmp/a.html')).toBeNull()
    expect(isAllowedDevPreviewUrl('javascript:alert(1)')).toBe(false)
  })

  it('rejects cloud metadata destinations', () => {
    expect(devPreviewUrlRejectionReason('http://169.254.169.254/latest/meta-data')).toBe('metadata')
    expect(devPreviewUrlRejectionReason('http://metadata.google.internal/')).toBe('metadata')
    expect(devPreviewUrlRejectionReason('http://168.63.129.16/')).toBe('metadata')
    expect(devPreviewUrlRejectionReason('169.254.169.254')).toBe('metadata')
    expect(normalizeDevPreviewUrlInput('http://metadata.google.internal/')).toBeNull()
    expect(isAllowedDevPreviewUrl('http://169.254.169.254/latest/meta-data')).toBe(false)
  })

  it('rejects invalid inputs and embedded credentials', () => {
    expect(devPreviewUrlRejectionReason('http://user:pass@example.com')).toBe('invalid')
    expect(devPreviewUrlRejectionReason('not a url')).toBe('invalid')
    expect(devPreviewUrlRejectionReason('')).toBe('invalid')
    expect(devPreviewUrlRejectionReason('   ')).toBe('invalid')
    expect(normalizeDevPreviewUrlInput('http://user:pass@example.com')).toBeNull()
  })

  it('keeps local and private-network URLs working', () => {
    expect(normalizeDevPreviewUrlInput('http://localhost:5173')).toBe('http://localhost:5173/')
    expect(devPreviewUrlRejectionReason('http://localhost:5173')).toBeNull()
    expect(normalizeDevPreviewUrlInput('http://192.168.1.5:3000')).toBe('http://192.168.1.5:3000/')
    expect(normalizeDevPreviewUrlInput('localhost:5173')).toBe('http://localhost:5173/')
    expect(normalizeDevPreviewUrlInput('5173')).toBe('http://127.0.0.1:5173/')
    expect(normalizeDevPreviewUrlInput('http://0.0.0.0:8080')).toBe('http://127.0.0.1:8080/')
  })
})
