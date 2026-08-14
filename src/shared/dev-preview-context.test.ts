import { describe, expect, it } from 'vitest'
import {
  appendDevPreviewIssue,
  createDevPreviewIssue,
  MAX_DEV_PREVIEW_ISSUES,
  normalizeDevPreviewElementContext,
  paddedDevPreviewCaptureRect
} from './dev-preview-context'

const normalElement = {
  url: 'http://localhost:3000/page',
  tag: 'button',
  selector: '#app > button:nth-of-type(1)',
  text: 'Save changes',
  attributes: {
    id: 'save',
    'aria-label': 'Save',
    onclick: 'steal()',
    value: 'secret',
    unknown: 'drop'
  },
  styles: { display: 'flex', color: 'red', backgroundImage: 'url(secret)' },
  rect: { x: 10, y: 12, width: 120, height: 40 },
  viewport: { width: 390, height: 844 }
}

describe('Preview element context sanitization', () => {
  it('retains only bounded allowlisted fields', () => {
    expect(normalizeDevPreviewElementContext(normalElement)).toEqual({
      kind: 'element',
      url: 'http://localhost:3000/page',
      tag: 'button',
      selector: '#app > button:nth-of-type(1)',
      text: 'Save changes',
      attributes: { id: 'save', 'aria-label': 'Save' },
      styles: { display: 'flex', color: 'red' },
      rect: normalElement.rect,
      viewport: normalElement.viewport
    })
  })

  it('rejects sensitive controls, scripts, and cross-origin frames', () => {
    expect(normalizeDevPreviewElementContext({
      ...normalElement, tag: 'input', attributes: { type: 'password', value: 'secret' }
    })).toBeNull()
    expect(normalizeDevPreviewElementContext({ ...normalElement, tag: 'script' })).toBeNull()
    expect(normalizeDevPreviewElementContext({ crossOriginFrame: true })).toBeNull()
    expect(normalizeDevPreviewElementContext({ ...normalElement, sensitive: true })).toBeNull()
  })

  it('clamps a padded capture to the viewport', () => {
    expect(paddedDevPreviewCaptureRect(
      { x: 5, y: 800, width: 100, height: 40 },
      { width: 390, height: 844 }
    )).toEqual({ x: 0, y: 768, width: 137, height: 76 })
  })
})

describe('Preview issues', () => {
  it('deduplicates by content and increments the repeat count', () => {
    const issue = createDevPreviewIssue({ kind: 'console', message: 'Boom', source: 'app.js', line: 3 })
    const issues = appendDevPreviewIssue(appendDevPreviewIssue([], issue), issue)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.count).toBe(2)
  })

  it('retains only the newest fifty distinct issues', () => {
    let issues = [] as ReturnType<typeof appendDevPreviewIssue>
    for (let index = 0; index < 60; index += 1) {
      issues = appendDevPreviewIssue(issues, createDevPreviewIssue({
        kind: 'console', message: `error ${index}`, createdAt: index
      }))
    }
    expect(issues).toHaveLength(MAX_DEV_PREVIEW_ISSUES)
    expect(issues[0]?.message).toBe('error 10')
    expect(issues.at(-1)?.message).toBe('error 59')
  })
})

