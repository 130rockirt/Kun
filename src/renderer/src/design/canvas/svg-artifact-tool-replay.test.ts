import { describe, expect, it, vi } from 'vitest'
import type { ChatBlock, ToolBlock } from '../../agent/types'
import type { DesignArtifact } from '../design-types'
import { applySvgArtifactToolBlock } from './svg-artifact-tool-replay'

const artifactId = 'svg-aabbccddeeff'
const toolBlock: ToolBlock = {
  kind: 'tool',
  id: 'tool-svg-create',
  summary: 'create svg',
  status: 'success',
  meta: { toolName: 'design_svg_create', sourceItemKind: 'tool_result' },
  detail: JSON.stringify({
    ok: true,
    ops: [{ op: 'add-svg-artifact', artifactId, name: 'Orbit', brief: 'Animated orbit' }]
  })
}

function blocks(extra: ChatBlock[] = []): ChatBlock[] {
  return [
    { kind: 'user', id: 'user-create', text: 'Create an animated orbit' },
    toolBlock,
    ...extra
  ]
}

function svgArtifact(previewStatus: 'pending' | 'ready' = 'pending'): DesignArtifact {
  const relativePath = `.kun-design/doc/${artifactId}/v1.svg`
  return {
    id: artifactId,
    kind: 'svg',
    title: 'Orbit',
    relativePath,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    versions: [{ id: `${artifactId}-v1`, relativePath, createdAt: '2026-01-01T00:00:00.000Z', summary: '' }],
    previewStatus
  }
}

describe('applySvgArtifactToolBlock', () => {
  it('defers while the source thread is busy', async () => {
    const onDefer = vi.fn()
    const onRequest = vi.fn()
    const result = await applySvgArtifactToolBlock({
      block: toolBlock,
      allowLegacy: false,
      busy: true,
      blocks: blocks(),
      artifacts: [],
      appliedBlockIds: new Set(),
      processingBlockIds: new Set(),
      onDefer,
      onRequest
    })

    expect(result.status).toBe('deferred')
    expect(onDefer).toHaveBeenCalledWith(toolBlock)
    expect(onRequest).not.toHaveBeenCalled()
  })

  it('applies a stable create once and records the tool block', async () => {
    const applied = new Set<string>()
    const onRequest = vi.fn(async () => ({ artifactId, shapeId: 'shape-svg' }))
    const options = {
      block: toolBlock,
      allowLegacy: false,
      busy: false,
      blocks: blocks(),
      artifacts: [] as DesignArtifact[],
      appliedBlockIds: applied,
      processingBlockIds: new Set<string>(),
      onDefer: vi.fn(),
      onRequest
    }

    await expect(applySvgArtifactToolBlock(options)).resolves.toEqual({
      status: 'applied',
      shapeIds: ['shape-svg']
    })
    expect(onRequest).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId, name: 'Orbit' }),
      'Create an animated orbit'
    )
    await expect(applySvgArtifactToolBlock(options)).resolves.toEqual({ status: 'ignored', shapeIds: [] })
    expect(onRequest).toHaveBeenCalledTimes(1)
  })

  it('does not resend a pending artifact after its dedicated follow-up was recorded', async () => {
    const artifact = svgArtifact('pending')
    const onRequest = vi.fn()
    const result = await applySvgArtifactToolBlock({
      block: toolBlock,
      allowLegacy: false,
      busy: false,
      blocks: blocks([{
        kind: 'user',
        id: 'user-followup',
        text: `Reserved SVG file: ${artifact.relativePath}\nUse the structured SVG tools.`
      }]),
      artifacts: [artifact],
      appliedBlockIds: new Set(),
      processingBlockIds: new Set(),
      onDefer: vi.fn(),
      onRequest
    })

    expect(result).toEqual({ status: 'applied', shapeIds: [] })
    expect(onRequest).not.toHaveBeenCalled()
  })

  it('keeps stable replay gating even when legacy tool results are allowed', async () => {
    const artifact = svgArtifact('pending')
    const onRequest = vi.fn()
    const result = await applySvgArtifactToolBlock({
      block: toolBlock,
      allowLegacy: true,
      busy: false,
      blocks: blocks([{
        kind: 'user',
        id: 'user-followup-legacy-mode',
        text: `Reserved SVG file: ${artifact.relativePath}`
      }]),
      artifacts: [artifact],
      appliedBlockIds: new Set(),
      processingBlockIds: new Set(),
      onDefer: vi.fn(),
      onRequest
    })

    expect(result).toEqual({ status: 'applied', shapeIds: [] })
    expect(onRequest).not.toHaveBeenCalled()
  })

  it('deduplicates one in-flight stable create across hook instances', async () => {
    let release = (_value: { artifactId: string; shapeId: string }): void => undefined
    const pending = new Promise<{ artifactId: string; shapeId: string }>((resolve) => { release = resolve })
    const onRequest = vi.fn(() => pending)
    const makeOptions = () => ({
      block: toolBlock,
      allowLegacy: false,
      busy: false,
      blocks: blocks(),
      artifacts: [] as DesignArtifact[],
      appliedBlockIds: new Set<string>(),
      processingBlockIds: new Set<string>(),
      onDefer: vi.fn(),
      onRequest
    })

    const first = applySvgArtifactToolBlock(makeOptions())
    const remounted = applySvgArtifactToolBlock(makeOptions())
    expect(onRequest).toHaveBeenCalledTimes(1)
    release({ artifactId, shapeId: 'shape-shared' })

    await expect(first).resolves.toEqual({ status: 'applied', shapeIds: ['shape-shared'] })
    await expect(remounted).resolves.toEqual({ status: 'applied', shapeIds: ['shape-shared'] })
    expect(onRequest).toHaveBeenCalledTimes(1)
  })

  it('reports same-instance in-flight work without treating it as completed', async () => {
    const processingBlockIds = new Set([toolBlock.id])
    await expect(applySvgArtifactToolBlock({
      block: toolBlock,
      allowLegacy: false,
      busy: false,
      blocks: blocks(),
      artifacts: [],
      appliedBlockIds: new Set(),
      processingBlockIds,
      onDefer: vi.fn(),
      onRequest: vi.fn()
    })).resolves.toEqual({ status: 'processing', shapeIds: [] })
  })

  it('does not mark a failed follow-up applied and permits a later retry', async () => {
    const onRequest = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ artifactId, shapeId: 'shape-retry' })
    const makeOptions = () => ({
      block: toolBlock,
      allowLegacy: false,
      busy: false,
      blocks: blocks(),
      artifacts: [] as DesignArtifact[],
      appliedBlockIds: new Set<string>(),
      processingBlockIds: new Set<string>(),
      onDefer: vi.fn(),
      onRequest
    })

    await expect(applySvgArtifactToolBlock(makeOptions())).resolves.toEqual({ status: 'failed', shapeIds: [] })
    await expect(applySvgArtifactToolBlock(makeOptions())).resolves.toEqual({
      status: 'applied',
      shapeIds: ['shape-retry']
    })
    expect(onRequest).toHaveBeenCalledTimes(2)
  })

  it('turns a rejected follow-up into a retryable failure', async () => {
    const onRequest = vi.fn().mockRejectedValueOnce(new Error('thread switched'))
      .mockResolvedValueOnce({ artifactId, shapeId: 'shape-after-remount' })
    const makeOptions = () => ({
      block: toolBlock,
      allowLegacy: false,
      busy: false,
      blocks: blocks(),
      artifacts: [] as DesignArtifact[],
      appliedBlockIds: new Set<string>(),
      processingBlockIds: new Set<string>(),
      onDefer: vi.fn(),
      onRequest
    })

    await expect(applySvgArtifactToolBlock(makeOptions())).resolves.toEqual({
      status: 'failed', shapeIds: []
    })
    await expect(applySvgArtifactToolBlock(makeOptions())).resolves.toEqual({
      status: 'applied', shapeIds: ['shape-after-remount']
    })
  })
})
