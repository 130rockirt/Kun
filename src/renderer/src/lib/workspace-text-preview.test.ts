import { describe, expect, it } from 'vitest'
import {
  isWorkspacePreviewPath,
  isWorkspaceRasterImagePreviewPath,
  isWorkspaceTextPreviewPath,
  workspaceFileKindLabel,
  workspaceFilePreviewKind
} from './workspace-text-preview'

describe('isWorkspaceTextPreviewPath', () => {
  it('accepts common source and markdown files', () => {
    expect(isWorkspaceTextPreviewPath('/tmp/app/src/main.ts')).toBe(true)
    expect(isWorkspaceTextPreviewPath('/tmp/app/README.md')).toBe(true)
    expect(isWorkspaceTextPreviewPath('/tmp/app/.gitignore')).toBe(true)
    expect(isWorkspaceTextPreviewPath('/tmp/app/architecture.svg')).toBe(true)
  })

  it('rejects common binary and media files', () => {
    expect(isWorkspaceTextPreviewPath('/tmp/app/logo.png')).toBe(false)
    expect(isWorkspaceTextPreviewPath('/tmp/app/archive.zip')).toBe(false)
    expect(isWorkspaceTextPreviewPath('/tmp/app/report.pdf')).toBe(false)
  })
})

describe('isWorkspaceRasterImagePreviewPath', () => {
  it('accepts image formats supported by the workspace image reader', () => {
    for (const extension of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico']) {
      expect(isWorkspaceRasterImagePreviewPath(`/tmp/app/image.${extension}`)).toBe(true)
    }
  })

  it('leaves SVG on the text-backed SVG preview path', () => {
    expect(isWorkspaceRasterImagePreviewPath('/tmp/app/image.svg')).toBe(false)
    expect(isWorkspaceRasterImagePreviewPath('/tmp/app/image.pdf')).toBe(false)
  })
})

describe('workspaceFilePreviewKind', () => {
  it('classifies the full workspace preview matrix', () => {
    expect(workspaceFilePreviewKind('README.md')).toBe('markdown')
    expect(workspaceFilePreviewKind('index.html')).toBe('html')
    expect(workspaceFilePreviewKind('diagram.svg')).toBe('svg')
    expect(workspaceFilePreviewKind('report.pdf')).toBe('pdf')
    expect(workspaceFilePreviewKind('budget.xlsx')).toBe('office')
    expect(workspaceFilePreviewKind('voice.mp3')).toBe('audio')
    expect(workspaceFilePreviewKind('demo.webm')).toBe('video')
    expect(workspaceFilePreviewKind('archive.zip')).toBe('unsupported')
    expect(isWorkspacePreviewPath('photo.png')).toBe(true)
    expect(workspaceFileKindLabel('budget.xlsx')).toBe('XLSX')
  })
})
