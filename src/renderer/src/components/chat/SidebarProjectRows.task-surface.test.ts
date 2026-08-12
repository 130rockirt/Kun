import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DesignTaskProfile } from '../../agent/design-task-profile'
import type { NormalizedThread } from '../../agent/types'
import { ThreadRow } from './SidebarProjectRows'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

const designProfile: DesignTaskProfile = {
  version: 1,
  documentTarget: { documentId: 'doc-design', boardArtifactId: 'board-design' },
  outputMedium: 'html',
  target: 'web',
  preset: 'none',
  context: { tone: [] },
  lockedAtTurnId: 'turn-design'
}

function renderThread(overrides: Partial<NormalizedThread>): string {
  const thread: NormalizedThread = {
    id: 'thread-1',
    title: 'Design task',
    updatedAt: '2026-08-13T00:00:00.000Z',
    model: 'test-model',
    mode: 'agent',
    workspace: '/workspace',
    ...overrides
  }
  return renderToStaticMarkup(createElement(ThreadRow, {
    thread,
    active: false,
    deleting: false,
    locale: 'en-US',
    showRunning: false,
    showUnread: false,
    onSelect: () => undefined,
    onContextMenu: () => undefined,
    onPreviewOpen: () => undefined,
    onPreviewClose: () => undefined,
    onPin: () => undefined,
    onRename: () => undefined,
    onArchive: () => undefined,
    onDelete: () => undefined,
    onRestore: () => undefined
  }))
}

describe('ThreadRow task surface icon', () => {
  it.each([
    ['durable locked task surface', { agentSurface: 'code', lockedTaskSurface: 'design' }],
    ['durable Design profile', { agentSurface: 'code', designProfile }],
    ['legacy Design ownership', { agentSurface: 'design' }]
  ] as const)('identifies Design from %s', (_name, thread) => {
    const html = renderThread(thread)

    expect(html).toContain('data-thread-task-surface="design"')
    expect(html).toContain('taskTypeDesign')
    expect(html).not.toContain('taskTypeCode')
  })

  it('preserves the Code icon and label for Code conversations', () => {
    const html = renderThread({
      agentSurface: 'code', lockedTaskSurface: 'code', designProfile
    })

    expect(html).toContain('data-thread-task-surface="code"')
    expect(html).toContain('taskTypeCode')
    expect(html).not.toContain('taskTypeDesign')
  })
})
