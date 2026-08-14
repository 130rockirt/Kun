import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkWhiteboard } from '../../write/write-workspace-store'
import { WorkWhiteboardSidebarSection } from './WorkWhiteboardSidebarSection'

const board = (id: string, updatedAt: string, phase: WorkWhiteboard['phase'] = 'blank'): WorkWhiteboard => ({
  id,
  title: id === 'newer' ? 'Newer board' : 'Older board',
  workspaceRoot: '/workspace',
  threadId: null,
  phase,
  revision: 0,
  createdAt: updatedAt,
  updatedAt
})

const onToggle = vi.fn()
const onCreate = vi.fn()
const onOpen = vi.fn()
const onToggleMenu = vi.fn()
const onRename = vi.fn()
const onDelete = vi.fn()

function renderSection(props: Partial<Parameters<typeof WorkWhiteboardSidebarSection>[0]> = {}): ReactTestRenderer {
  return create(createElement(WorkWhiteboardSidebarSection, {
    whiteboards: [],
    activeWhiteboardId: null,
    expanded: true,
    openMenuId: null,
    label: 'Whiteboards',
    createLabel: 'New whiteboard',
    moreActionsLabel: 'More actions',
    renameLabel: 'Rename',
    deleteLabel: 'Delete',
    onToggle,
    onCreate,
    onOpen,
    onToggleMenu,
    onRename,
    onDelete,
    ...props
  }))
}

describe('WorkWhiteboardSidebarSection', () => {
  let renderer: ReactTestRenderer

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    onToggle.mockClear()
    onCreate.mockClear()
    onOpen.mockClear()
    onToggleMenu.mockClear()
    onRename.mockClear()
    onDelete.mockClear()
  })

  afterEach(async () => {
    await act(async () => renderer.unmount())
  })

  it('keeps an empty whiteboard folder visible and creates from its plus action', async () => {
    await act(async () => {
      renderer = renderSection()
    })

    expect(renderer.root.findByProps({ 'data-work-whiteboard-folder': 'true' })).toBeTruthy()
    const createButton = renderer.root.findByProps({ 'aria-label': 'New whiteboard' })
    await act(async () => {
      createButton.props.onClick({ stopPropagation: vi.fn() })
    })
    expect(onCreate).toHaveBeenCalledOnce()
  })

  it('sorts boards by recent update and hides children while collapsed', async () => {
    await act(async () => {
      renderer = renderSection({
        whiteboards: [
          board('older', '2026-08-13T00:00:00.000Z'),
          board('newer', '2026-08-13T00:00:01.000Z', 'complete')
        ],
        activeWhiteboardId: 'newer'
      })
    })

    expect(renderer.root.findAll((node) => node.props['data-work-whiteboard-item'])
      .map((node) => node.props['data-work-whiteboard-item']))
      .toEqual(['newer', 'older'])
    expect(renderer.root.findByProps({ 'data-active': 'true' }).props.title).toBe('Newer board')
    expect(renderer.root.findAll((node) => node.type === 'span' && node.props.className?.includes('bg-emerald-500')))
      .toHaveLength(1)

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': 'Whiteboards' }).props.onClick()
    })
    expect(onToggle).toHaveBeenCalledOnce()

    await act(async () => {
      renderer.update(createElement(WorkWhiteboardSidebarSection, {
        whiteboards: [board('newer', '2026-08-13T00:00:01.000Z')],
        activeWhiteboardId: null,
        expanded: false,
        openMenuId: null,
        label: 'Whiteboards',
        createLabel: 'New whiteboard',
        moreActionsLabel: 'More actions',
        renameLabel: 'Rename',
        deleteLabel: 'Delete',
        onToggle,
        onCreate,
        onOpen,
        onToggleMenu,
        onRename,
        onDelete
      }))
    })
    expect(renderer.root.findAll((node) => node.props['data-work-whiteboard-item'])).toHaveLength(0)
  })

  it('opens a board and retains its rename and delete menu actions', async () => {
    const newer = board('newer', '2026-08-13T00:00:01.000Z', 'review')
    await act(async () => {
      renderer = renderSection({ whiteboards: [newer], openMenuId: newer.id })
    })

    const item = renderer.root.findByProps({ 'data-work-whiteboard-item': newer.id })
    await act(async () => {
      item.findAllByType('button')[0].props.onClick()
    })
    expect(onOpen).toHaveBeenCalledWith(newer.id)
    expect(renderer.root.findAll((node) => node.type === 'span' && node.props.className?.includes('bg-amber-500')))
      .toHaveLength(1)

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': 'More actions' }).props.onClick({ stopPropagation: vi.fn() })
    })
    expect(onToggleMenu).toHaveBeenCalledWith(newer.id)
    await act(async () => {
      renderer.root.findAllByType('button').find((node) => node.children.includes('Rename'))?.props.onClick()
      renderer.root.findAllByType('button').find((node) => node.children.includes('Delete'))?.props.onClick()
    })
    expect(onRename).toHaveBeenCalledWith(newer)
    expect(onDelete).toHaveBeenCalledWith(newer)
  })
})
