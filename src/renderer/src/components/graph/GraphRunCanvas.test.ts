import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { GraphRunCanvas } from './GraphRunCanvas'

vi.mock('@xyflow/react', async () => {
  const React = await import('react')
  type FlowNode = {
    id: string
    position: { x: number; y: number }
    selected?: boolean
    data?: unknown
  }
  type NodeChange = {
    id: string
    type: string
    position?: { x: number; y: number }
  }
  const Empty = (): ReactNode => null
  return {
    Background: Empty,
    BackgroundVariant: { Dots: 'dots' },
    Controls: Empty,
    MiniMap: Empty,
    ReactFlow: ({
      children,
      ...props
    }: Record<string, unknown> & { children?: ReactNode }) =>
      React.createElement('mock-react-flow', props, children),
    useNodesState: (initial: FlowNode[]) => {
      const [nodes, setNodes] = React.useState(initial)
      const onNodesChange = (changes: NodeChange[]): void => {
        setNodes((current) => current.map((node) => {
          const change = changes.find((item) => item.id === node.id)
          return change?.type === 'position' && change.position
            ? { ...node, position: change.position }
            : node
        }))
      }
      return [nodes, setNodes, onNodesChange]
    }
  }
})

describe('GraphRunCanvas', () => {
  beforeAll(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    await i18n.changeLanguage('en')
  })

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  })

  it('wires click, drag, pan, zoom and keeps a dragged position across refreshes', async () => {
    const onSelectNode = vi.fn()
    const onInspectNode = vi.fn()
    const original = [{
      id: 'audit',
      position: { x: 36, y: 40 },
      data: { label: 'Audit v1' }
    }]
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(GraphRunCanvas, {
        runId: 'run_1',
        nodes: original,
        edges: [],
        selectedNodeId: null,
        onSelectNode,
        onInspectNode,
        onOpenInspector: vi.fn()
      }))
    })
    let flow = renderer!.root.find((instance) =>
      instance.props['aria-label'] === 'Directed Graph run' &&
      typeof instance.props.onNodesChange === 'function')

    expect(flow.props.nodesDraggable).toBe(false)
    expect(flow.props.panOnDrag).toEqual([0, 1, 2])
    expect(flow.props.zoomOnScroll).toBe(true)
    expect(flow.props.zoomOnDoubleClick).toBe(false)
    expect(flow.props.fitViewOptions.minZoom).toBeGreaterThanOrEqual(0.6)
    expect(flow.props.onNodesChange).toEqual(expect.any(Function))
    const interactionRoot = renderer!.root.find((instance) =>
      instance.props['data-graph-interaction-root'] === true)
    expect(interactionRoot.props.className).toContain('ds-no-drag')

    const selectTool = renderer!.root.find((instance) =>
      instance.props['aria-label'] === 'Select and move nodes')
    act(() => selectTool.props.onClick())
    flow = renderer!.root.find((instance) =>
      instance.props['aria-label'] === 'Directed Graph run' &&
      typeof instance.props.onNodesChange === 'function')
    expect(flow.props.nodesDraggable).toBe(true)
    expect(flow.props.panOnDrag).toEqual([1, 2])
    expect(flow.props.selectionOnDrag).toBe(true)

    act(() => {
      flow.props.onNodeDragStart({}, { id: 'audit' })
      flow.props.onNodeClick({}, { id: 'audit' })
      flow.props.onNodesChange([{
        id: 'audit',
        type: 'position',
        position: { x: 640, y: 320 }
      }])
    })
    expect(onSelectNode).toHaveBeenCalledWith('audit')
    expect(onInspectNode).not.toHaveBeenCalled()
    act(() => flow.props.onNodeDoubleClick({}, { id: 'audit' }))
    expect(onInspectNode).toHaveBeenCalledWith('audit')
    flow = renderer!.root.find((instance) =>
      instance.props['aria-label'] === 'Directed Graph run' &&
      typeof instance.props.onNodesChange === 'function')
    expect(flow.props.nodes[0].position).toEqual({ x: 640, y: 320 })

    await act(async () => {
      renderer!.update(createElement(GraphRunCanvas, {
        runId: 'run_1',
        nodes: [{
          ...original[0]!,
          data: { label: 'Audit v2' }
        }],
        edges: [],
        selectedNodeId: 'audit',
        onSelectNode,
        onInspectNode,
        onOpenInspector: vi.fn()
      }))
    })
    flow = renderer!.root.find((instance) =>
      instance.props['aria-label'] === 'Directed Graph run' &&
      typeof instance.props.onNodesChange === 'function')
    expect(flow.props.nodes[0]).toMatchObject({
      position: { x: 640, y: 320 },
      selected: true,
      data: { label: 'Audit v2' }
    })
  })
})
