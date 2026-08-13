import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesignTaskProfile } from '../../agent/design-task-profile'
import type { NormalizedThread } from '../../agent/types'
import { useDesignWorkspaceStore } from '../../design/design-workspace-store'
import { useChatStore } from '../../store/chat-store'
import {
  useWorkbenchTaskSurface,
  workbenchDesignProfileIsLocked,
  workbenchTaskSurfaceIsLocked
} from './useWorkbenchTaskSurface'
import {
  readWorkbenchTaskIntent,
  workbenchTaskIntentScope,
  writeWorkbenchTaskIntent
} from './workbench-task-intent'

const profile: DesignTaskProfile = {
  version: 1,
  documentTarget: { documentId: 'doc_1', boardArtifactId: 'board_1' },
  outputMedium: 'html',
  target: 'web',
  preset: 'none',
  context: { tone: [] },
  lockedAtTurnId: 'turn_1'
}

class MemoryStorage {
  private readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

function codeThread(overrides: Partial<NormalizedThread> = {}): NormalizedThread {
  return {
    id: 'thread-code',
    title: 'Code task',
    updatedAt: '2026-08-12T00:00:00.000Z',
    model: '',
    mode: 'agent',
    workspace: '/workspace',
    agentSurface: 'code',
    ...overrides
  }
}

describe('workbench task mode', () => {
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const localStorage = new MemoryStorage()
    vi.stubGlobal('window', {
      localStorage,
      kunGui: undefined,
      dispatchEvent: vi.fn(() => true)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('locks the task mode after the first accepted turn', () => {
    expect(workbenchDesignProfileIsLocked(null)).toBe(false)
    expect(workbenchDesignProfileIsLocked({})).toBe(false)
    expect(workbenchDesignProfileIsLocked({ designProfile: profile })).toBe(true)
    expect(workbenchTaskSurfaceIsLocked(null)).toBe(false)
    expect(workbenchTaskSurfaceIsLocked({ agentSurface: 'code' })).toBe(false)
    expect(workbenchTaskSurfaceIsLocked({ agentSurface: 'design' })).toBe(true)
    expect(workbenchTaskSurfaceIsLocked({ latestTurnId: 'turn_1' })).toBe(true)
    expect(workbenchTaskSurfaceIsLocked({ designProfile: profile })).toBe(true)
    expect(workbenchTaskSurfaceIsLocked({ lockedTaskSurface: 'code' })).toBe(true)
  })

  it('does not inherit an empty-workspace Design draft into an existing thread', () => {
    writeWorkbenchTaskIntent(workbenchTaskIntentScope(null, '/workspace'), {
      surface: 'design',
      profile: { outputMedium: 'image', target: 'app', preset: 'ios' }
    })

    expect(readWorkbenchTaskIntent(
      workbenchTaskIntentScope('thread-existing', '/workspace'),
      '/workspace'
    )).toEqual({
      surface: 'code',
      profile: { outputMedium: 'html', target: 'web', preset: 'none' }
    })
  })

  it('falls an unlocked AI-image draft back to HTML when image generation is disabled', async () => {
    const scope = workbenchTaskIntentScope(null, '/workspace')
    writeWorkbenchTaskIntent(scope, {
      surface: 'design',
      profile: { outputMedium: 'image', target: 'app', preset: 'ios' }
    })
    let runtime: ReturnType<typeof useWorkbenchTaskSurface> | null = null
    const Harness = () => {
      runtime = useWorkbenchTaskSurface({
        activeThreadId: null,
        threads: [],
        workspaceRoot: '/workspace',
        activeSkillWorkspace: '/workspace',
        createThread: vi.fn(async () => null),
        deleteThread: vi.fn(async () => undefined),
        setComposerMode: vi.fn(),
        setComposerOrchestration: vi.fn(),
        imageGenerationEnabled: false
      })
      return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(Harness)) })

    expect(runtime!.designTaskProfile).toEqual({
      outputMedium: 'html', target: 'app', preset: 'ios'
    })
    expect(readWorkbenchTaskIntent(scope, '/workspace').profile.outputMedium).toBe('html')
    await act(async () => renderer.unmount())
  })

  it('preserves an unlocked AI-image draft while runtime capability state is unknown', async () => {
    const scope = workbenchTaskIntentScope(null, '/workspace')
    writeWorkbenchTaskIntent(scope, {
      surface: 'design',
      profile: { outputMedium: 'image', target: 'web', preset: 'none' }
    })
    let runtime: ReturnType<typeof useWorkbenchTaskSurface> | null = null
    const Harness = () => {
      runtime = useWorkbenchTaskSurface({
        activeThreadId: null,
        threads: [],
        workspaceRoot: '/workspace',
        activeSkillWorkspace: '/workspace',
        createThread: vi.fn(async () => null),
        deleteThread: vi.fn(async () => undefined),
        setComposerMode: vi.fn(),
        setComposerOrchestration: vi.fn()
      })
      return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(Harness)) })

    expect(runtime!.designTaskProfile.outputMedium).toBe('image')
    expect(readWorkbenchTaskIntent(scope, '/workspace').profile.outputMedium).toBe('image')
    await act(async () => renderer.unmount())
  })

  it('preserves a locked AI-image profile after image generation is disabled', async () => {
    const imageProfile: DesignTaskProfile = { ...profile, outputMedium: 'image' }
    const lockedThread = codeThread({ id: 'thread-image', designProfile: imageProfile })
    let runtime: ReturnType<typeof useWorkbenchTaskSurface> | null = null
    const Harness = () => {
      runtime = useWorkbenchTaskSurface({
        activeThreadId: lockedThread.id,
        threads: [lockedThread],
        workspaceRoot: '/workspace',
        activeSkillWorkspace: '/workspace',
        createThread: vi.fn(async () => null),
        deleteThread: vi.fn(async () => undefined),
        setComposerMode: vi.fn(),
        setComposerOrchestration: vi.fn(),
        imageGenerationEnabled: false
      })
      return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(Harness)) })

    expect(runtime!.designProfileLocked).toBe(true)
    expect(runtime!.designTaskProfile.outputMedium).toBe('image')
    await act(async () => renderer.unmount())
  })

  it('does not rewrite a locked Design draft before profile detail hydration', async () => {
    const lockedThread = codeThread({ id: 'thread-summary', lockedTaskSurface: 'design' })
    const scope = workbenchTaskIntentScope(lockedThread.id, '/workspace')
    writeWorkbenchTaskIntent(scope, {
      surface: 'design',
      profile: { outputMedium: 'image', target: 'web', preset: 'none' }
    })
    let runtime: ReturnType<typeof useWorkbenchTaskSurface> | null = null
    const Harness = () => {
      runtime = useWorkbenchTaskSurface({
        activeThreadId: lockedThread.id,
        threads: [lockedThread],
        workspaceRoot: '/workspace',
        activeSkillWorkspace: '/workspace',
        createThread: vi.fn(async () => null),
        deleteThread: vi.fn(async () => undefined),
        setComposerMode: vi.fn(),
        setComposerOrchestration: vi.fn(),
        imageGenerationEnabled: false
      })
      return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(Harness)) })

    expect(runtime!.taskSurfaceLocked).toBe(true)
    expect(runtime!.designTaskProfile.outputMedium).toBe('image')
    expect(readWorkbenchTaskIntent(scope, '/workspace').profile.outputMedium).toBe('image')
    await act(async () => renderer.unmount())
  })

  it('keeps an accepted Code thread locked to Code', async () => {
    const thread = codeThread({ latestTurnId: 'turn-existing' })
    const createThread = vi.fn(async () => 'unexpected')
    const deleteThread = vi.fn(async () => undefined)
    const setComposerMode = vi.fn()
    const setComposerOrchestration = vi.fn()
    let runtime: ReturnType<typeof useWorkbenchTaskSurface> | null = null
    const Harness = () => {
      runtime = useWorkbenchTaskSurface({
        activeThreadId: thread.id,
        threads: [thread],
        workspaceRoot: '/workspace',
        activeSkillWorkspace: '/workspace',
        createThread,
        deleteThread,
        setComposerMode,
        setComposerOrchestration
      })
      return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(Harness)) })

    act(() => runtime!.onTaskSurfaceChange('design'))
    expect(runtime!.taskSurface).toBe('code')
    expect(runtime!.taskSurfaceLocked).toBe(true)
    expect(runtime!.taskSurfaceTransitioning).toBe(false)
    expect(setComposerMode).not.toHaveBeenCalled()
    expect(setComposerOrchestration).not.toHaveBeenCalled()
    expect(createThread).not.toHaveBeenCalled()
    expect(deleteThread).not.toHaveBeenCalled()
    await act(async () => renderer.unmount())
  })

  it('hides the selector from a summary-locked Code thread before detail hydration', async () => {
    const thread = codeThread({ lockedTaskSurface: 'code' })
    let runtime: ReturnType<typeof useWorkbenchTaskSurface> | null = null
    const Harness = () => {
      runtime = useWorkbenchTaskSurface({
        activeThreadId: thread.id,
        threads: [thread],
        workspaceRoot: '/workspace',
        activeSkillWorkspace: '/workspace',
        createThread: vi.fn(async () => null),
        deleteThread: vi.fn(async () => undefined),
        setComposerMode: vi.fn(),
        setComposerOrchestration: vi.fn()
      })
      return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(Harness)) })

    expect(runtime!.taskSurface).toBe('code')
    expect(runtime!.taskSurfaceLocked).toBe(true)
    await act(async () => renderer.unmount())
  })

  it('uses direct Agent execution in Design and restores the unlocked Code draft', async () => {
    const setComposerMode = vi.fn()
    const setComposerOrchestration = vi.fn()
    let runtime: ReturnType<typeof useWorkbenchTaskSurface> | null = null
    const Harness = () => {
      runtime = useWorkbenchTaskSurface({
        activeThreadId: null,
        threads: [],
        workspaceRoot: '/workspace',
        activeSkillWorkspace: '/workspace',
        createThread: vi.fn(async () => null),
        deleteThread: vi.fn(async () => undefined),
        composerMode: 'plan',
        composerOrchestration: 'graph',
        setComposerMode,
        setComposerOrchestration
      })
      return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(Harness)) })

    act(() => runtime!.onTaskSurfaceChange('design'))
    expect(runtime!.taskSurface).toBe('design')
    expect(setComposerMode).toHaveBeenLastCalledWith('agent')
    expect(setComposerOrchestration).toHaveBeenLastCalledWith('direct')

    act(() => runtime!.onTaskSurfaceChange('code'))
    expect(runtime!.taskSurface).toBe('code')
    expect(setComposerMode).toHaveBeenLastCalledWith('plan')
    expect(setComposerOrchestration).toHaveBeenLastCalledWith('graph')
    await act(async () => renderer.unmount())
  })

  it('creates an explicitly Code-owned thread only when no conversation exists', async () => {
    const deleteThread = vi.fn(async () => undefined)
    const createThread = vi.fn(async () => 'thread-created-for-send')
    let runtime: ReturnType<typeof useWorkbenchTaskSurface> | null = null
    const Harness = () => {
      runtime = useWorkbenchTaskSurface({
        activeThreadId: null,
        threads: [],
        workspaceRoot: '/workspace',
        activeSkillWorkspace: '/workspace',
        createThread,
        deleteThread,
        setComposerMode: vi.fn(),
        setComposerOrchestration: vi.fn()
      })
      return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(Harness)) })

    await expect(runtime!.ensureDesignThread('/workspace', 'doc-new'))
      .resolves.toBe('thread-created-for-send')
    expect(createThread).toHaveBeenCalledWith({
      workspaceRoot: '/workspace',
      forceNew: true,
      agentSurface: 'code'
    })
    await expect(runtime!.rollbackProvisionalThread('thread-created-for-send'))
      .resolves.toBe(true)
    expect(deleteThread).toHaveBeenCalledWith('thread-created-for-send')
    await act(async () => renderer.unmount())
  })

  it('keeps a provisional Code thread after runtime admission', async () => {
    const previousThreads = useChatStore.getState().threads
    const deleteThread = vi.fn(async () => undefined)
    let runtime: ReturnType<typeof useWorkbenchTaskSurface> | null = null
    const Harness = () => {
      runtime = useWorkbenchTaskSurface({
        activeThreadId: null,
        threads: [],
        workspaceRoot: '/workspace',
        activeSkillWorkspace: '/workspace',
        createThread: vi.fn(async () => 'thread-admitted'),
        deleteThread,
        setComposerMode: vi.fn(),
        setComposerOrchestration: vi.fn()
      })
      return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(Harness)) })
    await runtime!.ensureDesignThread('/workspace', 'doc-new')
    useChatStore.setState({
      threads: [codeThread({ id: 'thread-admitted', latestTurnId: 'turn-accepted' })]
    })

    await expect(runtime!.rollbackProvisionalThread('thread-admitted')).resolves.toBe(false)
    expect(deleteThread).not.toHaveBeenCalled()
    useChatStore.setState({ threads: previousThreads })
    await act(async () => renderer.unmount())
  })

  it('restores a Code-owned thread Design profile without retagging ownership', async () => {
    const lockedThread = codeThread({ id: 'thread-locked', designProfile: profile })
    useDesignWorkspaceStore.setState({
      workspaceRoot: '/workspace',
      activeDocumentId: profile.documentTarget.documentId,
      documents: [{
        id: profile.documentTarget.documentId,
        title: 'Design',
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:00:00.000Z',
        order: 0,
        artifacts: [],
        activeArtifactId: null
      }]
    })
    const dispatch = window.dispatchEvent as ReturnType<typeof vi.fn>
    let runtime: ReturnType<typeof useWorkbenchTaskSurface> | null = null
    const Harness = ({ thread }: { thread: NormalizedThread }) => {
      runtime = useWorkbenchTaskSurface({
        activeThreadId: thread.id,
        threads: [thread],
        workspaceRoot: '/workspace',
        activeSkillWorkspace: '/workspace',
        createThread: vi.fn(async () => null),
        deleteThread: vi.fn(async () => undefined),
        setComposerMode: vi.fn(),
        setComposerOrchestration: vi.fn()
      })
      return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(Harness, { thread: lockedThread })) })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(runtime!.taskSurface).toBe('design')
    expect(runtime!.taskSurfaceLocked).toBe(true)
    expect(runtime!.designProfileLocked).toBe(true)

    act(() => runtime!.onTaskSurfaceChange('code'))
    expect(runtime!.taskSurface).toBe('design')
    expect(runtime!.designTaskProfile).toEqual({
      outputMedium: profile.outputMedium,
      target: profile.target,
      preset: profile.preset
    })
    await expect(runtime!.ensureDesignThread('/workspace', profile.documentTarget.documentId))
      .resolves.toBe(lockedThread.id)
    await act(async () => renderer.unmount())
  })

  it('keeps legacy standalone Design threads read-only', async () => {
    const legacy = codeThread({ id: 'legacy-design', agentSurface: 'design' })
    let runtime: ReturnType<typeof useWorkbenchTaskSurface> | null = null
    const Harness = () => {
      runtime = useWorkbenchTaskSurface({
        activeThreadId: legacy.id,
        threads: [legacy],
        workspaceRoot: '/workspace',
        activeSkillWorkspace: '/workspace',
        createThread: vi.fn(async () => 'unexpected'),
        deleteThread: vi.fn(async () => undefined),
        setComposerMode: vi.fn(),
        setComposerOrchestration: vi.fn()
      })
      return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(createElement(Harness)) })
    expect(runtime!.taskSurface).toBe('design')
    expect(runtime!.taskSurfaceTransitioning).toBe(true)
    act(() => runtime!.onTaskSurfaceChange('code'))
    expect(runtime!.taskSurface).toBe('design')
    await act(async () => renderer.unmount())
  })
})
