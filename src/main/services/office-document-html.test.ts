import {
  OFFICE_DOCUMENT_PREVIEW_CSP,
  officeDocumentPreviewSrcDoc
} from '../../shared/office-document'
import {
  isSafeOfficeDocumentDataImage,
  sanitizeOfficeDocumentHtml
} from './office-document-html'
import { describe, expect, it } from 'vitest'

describe('Office document HTML sanitization', () => {
  it('drops CSS URLs and imports even when they are spelled with CSS escapes', () => {
    const sanitized = sanitizeOfficeDocumentHtml([
      '<html><head><style>',
      '.one{background-image:\\75\\72\\6c(\\66\\69\\6c\\65\\3a///private/secret)}',
      '@\\69mport "\\68\\74\\74\\70\\73\\3a//evil.test/preview.css";',
      '.safe{color:green}',
      '</style></head><body><p>Visible</p></body></html>'
    ].join(''))

    expect(sanitized).toContain('<style></style>')
    expect(sanitized).toContain('<p>Visible</p>')
    expect(sanitized).not.toMatch(/url|@import|https:|file:/i)
  })

  it('uses a restrictive CSP for both iframe srcdoc and capture HTML', () => {
    const srcDoc = officeDocumentPreviewSrcDoc('<html><head></head><body>Preview</body></html>')

    expect(srcDoc).toContain(`Content-Security-Policy" content="${OFFICE_DOCUMENT_PREVIEW_CSP}`)
    expect(OFFICE_DOCUMENT_PREVIEW_CSP).toContain("default-src 'none'")
    expect(OFFICE_DOCUMENT_PREVIEW_CSP).toContain('img-src data:')
    expect(OFFICE_DOCUMENT_PREVIEW_CSP).not.toContain('file:')
  })

  it('allows only base64 image data URLs as document subresources', () => {
    expect(isSafeOfficeDocumentDataImage('data:image/png;base64,cHJldmlldw==')).toBe(true)
    expect(isSafeOfficeDocumentDataImage('file:///private/secret.png')).toBe(false)
    expect(isSafeOfficeDocumentDataImage('https://example.test/preview.png')).toBe(false)
  })
})
