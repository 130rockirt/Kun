import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { useDesignWorkspaceStore } from '../../design/design-workspace-store'
import { useDesignAgentActionRunner } from './useDesignAgentActionRunner'

function Harness(props: { onRun: (run: ReturnType<typeof useDesignAgentActionRunner>) => void }) {
  props.onRun(useDesignAgentActionRunner(vi.fn()))
  return null
}

describe('useDesignAgentActionRunner', () => {
  it('does not reopen the unreachable legacy assistant rail', async () => {
    useDesignWorkspaceStore.setState({ canvasAssistantOpen: false })
    let run!: ReturnType<typeof useDesignAgentActionRunner>
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(Harness, { onRun: (next) => { run = next } }))
    })

    await act(async () => run({ intentMode: 'modify', prompt: 'Tighten the layout.' }))

    expect(useDesignWorkspaceStore.getState().designIntentMode).toBe('modify')
    expect(useDesignWorkspaceStore.getState().canvasAssistantOpen).toBe(false)
    await act(async () => renderer.unmount())
  })
})
