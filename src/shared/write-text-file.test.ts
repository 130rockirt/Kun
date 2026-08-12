import { describe, expect, it } from 'vitest'
import {
  isWriteCodeFileExtension,
  isWriteCodeFileName,
  isWriteCodeFilePath,
  isWriteImageFileExtension,
  isWriteImageFilePath,
  isWriteOfficeFileExtension,
  isWriteOfficeFilePath,
  isWritePdfFileExtension,
  isWritePdfFilePath,
  isWriteTextFileExtension,
  isWriteTextFilePath,
  isWriteWorkspaceFilePath,
  isWriteWorkspaceEntry
} from './write-text-file'

describe('write text file helpers', () => {
  it('accepts markdown and txt-like extensions', () => {
    expect(isWriteTextFileExtension('.md')).toBe(true)
    expect(isWriteTextFileExtension('.MDX')).toBe(true)
    expect(isWriteTextFileExtension('.txt')).toBe(true)
    expect(isWriteTextFileExtension('.text')).toBe(true)
  })

  it('rejects non-write file extensions', () => {
    expect(isWriteTextFileExtension('.json')).toBe(false)
    expect(isWriteTextFileExtension('.png')).toBe(false)
  })

  it('classifies common source and configuration files separately from writing text', () => {
    for (const [path, extension] of [
      ['/tmp/workspace/app.tsx', '.tsx'],
      ['/tmp/workspace/config.mts', '.mts'],
      ['/tmp/workspace/types.pyi', '.pyi'],
      ['/tmp/workspace/header.hxx', '.hxx'],
      ['/tmp/workspace/service.py', '.py'],
      ['/tmp/workspace/config.json', '.json'],
      ['/tmp/workspace/styles.css', '.css']
    ]) {
      expect(isWriteCodeFileExtension(extension)).toBe(true)
      expect(isWriteCodeFilePath(path)).toBe(true)
      expect(isWriteWorkspaceFilePath(path)).toBe(true)
      expect(isWriteTextFilePath(path)).toBe(false)
    }
    expect(isWriteCodeFileExtension('.TS')).toBe(true)
    expect(isWriteCodeFileExtension('.zip')).toBe(false)
  })

  it('recognizes well-known extensionless and dotfile names case-insensitively', () => {
    for (const name of [
      'Dockerfile',
      'Dockerfile.dev',
      'Makefile',
      '.gitignore',
      '.env',
      '.env.local'
    ]) {
      expect(isWriteCodeFileName(name)).toBe(true)
      expect(isWriteCodeFilePath(`/tmp/workspace/${name}`)).toBe(true)
      expect(isWriteWorkspaceFilePath(`/tmp/workspace/${name}`)).toBe(true)
      expect(isWriteWorkspaceEntry({
        name,
        path: `/tmp/workspace/${name}`,
        type: 'file',
        ext: ''
      })).toBe(true)
    }
    expect(isWriteCodeFileName('DOCKERFILE')).toBe(true)
    expect(isWriteCodeFileName('MAKEFILE')).toBe(true)
  })

  it('keeps Markdown and plain text in the editable writing classification', () => {
    for (const path of ['/tmp/workspace/brief.md', '/tmp/workspace/notes.TXT']) {
      expect(isWriteTextFilePath(path)).toBe(true)
      expect(isWriteCodeFilePath(path)).toBe(false)
      expect(isWriteWorkspaceFilePath(path)).toBe(true)
    }
  })

  it('accepts common image extensions for preview', () => {
    expect(isWriteImageFileExtension('.png')).toBe(true)
    expect(isWriteImageFileExtension('.JPG')).toBe(true)
    expect(isWriteImageFileExtension('.webp')).toBe(true)
    expect(isWriteImageFileExtension('.svg')).toBe(false)
  })

  it('accepts pdf files for read-only literature preview', () => {
    expect(isWritePdfFileExtension('.pdf')).toBe(true)
    expect(isWritePdfFileExtension('.PDF')).toBe(true)
    expect(isWritePdfFileExtension('.md')).toBe(false)
    expect(isWritePdfFilePath('/tmp/papers/study.PDF')).toBe(true)
  })

  it('accepts all six Office formats as read-only Write files', () => {
    for (const extension of ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']) {
      expect(isWriteOfficeFileExtension(extension)).toBe(true)
      expect(isWriteOfficeFilePath(`/tmp/workspace/sample${extension}`)).toBe(true)
      expect(isWriteWorkspaceFilePath(`/tmp/workspace/sample${extension}`)).toBe(true)
    }
    expect(isWriteOfficeFileExtension('.docm')).toBe(false)
  })

  it('checks file paths with extension matching', () => {
    expect(isWriteTextFilePath('/tmp/draft.md')).toBe(true)
    expect(isWriteTextFilePath('/tmp/notes.TXT')).toBe(true)
    expect(isWriteTextFilePath('/tmp/output.jsonl')).toBe(false)
    expect(isWriteTextFilePath('/tmp/folder/no-ext')).toBe(false)

    expect(isWriteImageFilePath('/tmp/img/hero.PNG')).toBe(true)
    expect(isWriteWorkspaceFilePath('/tmp/img/hero.PNG')).toBe(true)
    expect(isWriteWorkspaceFilePath('/tmp/papers/study.pdf')).toBe(true)
    expect(isWriteWorkspaceFilePath('/tmp/slides/deck.PPTX')).toBe(true)
    expect(isWriteWorkspaceFilePath('/tmp/folder/no-ext')).toBe(false)
  })

  it('keeps existing Office and media classifications out of code files', () => {
    for (const path of [
      '/tmp/workspace/hero.png',
      '/tmp/workspace/paper.pdf',
      '/tmp/workspace/deck.pptx'
    ]) {
      expect(isWriteWorkspaceFilePath(path)).toBe(true)
      expect(isWriteCodeFilePath(path)).toBe(false)
    }
  })

  it('rejects unsupported binary archive paths and entries', () => {
    expect(isWriteCodeFilePath('/tmp/workspace/archive.zip')).toBe(false)
    expect(isWriteWorkspaceFilePath('/tmp/workspace/archive.zip')).toBe(false)
    expect(isWriteWorkspaceEntry({
      name: 'archive.zip',
      path: '/tmp/workspace/archive.zip',
      type: 'file',
      ext: '.zip'
    })).toBe(false)
  })

  it('allows directories but filters unsupported files from the write tree', () => {
    expect(isWriteWorkspaceEntry({
      name: 'docs',
      path: '/tmp/docs',
      type: 'directory',
      ext: ''
    })).toBe(true)
    expect(isWriteWorkspaceEntry({
      name: 'draft.md',
      path: '/tmp/draft.md',
      type: 'file',
      ext: '.md'
    })).toBe(true)
    expect(isWriteWorkspaceEntry({
      name: 'hero.png',
      path: '/tmp/hero.png',
      type: 'file',
      ext: '.png'
    })).toBe(true)
    expect(isWriteWorkspaceEntry({
      name: 'paper.pdf',
      path: '/tmp/paper.pdf',
      type: 'file',
      ext: '.pdf'
    })).toBe(true)
    expect(isWriteWorkspaceEntry({
      name: 'deck.pptx',
      path: '/tmp/deck.pptx',
      type: 'file',
      ext: '.pptx'
    })).toBe(true)
    expect(isWriteWorkspaceEntry({
      name: 'data.json',
      path: '/tmp/data.json',
      type: 'file',
      ext: '.json'
    })).toBe(true)
  })
})
