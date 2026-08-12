import { describe, expect, it } from 'vitest'
import {
  createThreadRecord,
  legacyThreadCanClaimWrite,
  resolveThreadAgentSurface,
  toThreadSummary
} from './thread.js'
import { makeUserItem } from './item.js'
import { createTurnRecord } from './turn.js'

function legacyThreadWithSurfaces(surfaces: Array<'code' | 'write' | 'design' | undefined>) {
  const thread = createThreadRecord({
    id: 'thr_legacy_surface',
    title: 'Legacy surface',
    workspace: '/tmp/project',
    model: 'test-model',
    createdAt: '2026-08-01T00:00:00.000Z'
  })
  return {
    ...thread,
    turns: surfaces.map((agentSurface, index) => createTurnRecord({
      id: `turn_${index}`,
      threadId: thread.id,
      prompt: `turn ${index}`,
      model: thread.model,
      ...(agentSurface ? { agentSurface } : {}),
      createdAt: `2026-08-01T00:00:0${index + 1}.000Z`
    }))
  }
}

describe('resolveThreadAgentSurface', () => {
  it('honors explicit thread ownership even when legacy turns are mixed', () => {
    const thread = {
      ...legacyThreadWithSurfaces(['code', 'design']),
      agentSurface: 'write' as const
    }

    expect(resolveThreadAgentSurface(thread)).toBe('write')
    expect(toThreadSummary(thread).agentSurface).toBe('write')
  })

  it('infers a non-Code surface only from a non-empty homogeneous annotated history', () => {
    expect(resolveThreadAgentSurface(legacyThreadWithSurfaces(['design', 'design']))).toBe('design')
    expect(resolveThreadAgentSurface(legacyThreadWithSurfaces(['write', 'write']))).toBe('write')
    expect(resolveThreadAgentSurface(legacyThreadWithSurfaces(['design', 'code']))).toBe('code')
    expect(resolveThreadAgentSurface(legacyThreadWithSurfaces(['design', undefined]))).toBe('code')
    expect(resolveThreadAgentSurface(legacyThreadWithSurfaces([]))).toBe('code')
  })

  it('infers legacy Work only from its title and persisted controlled user envelope', () => {
    const thread = legacyThreadWithSurfaces([undefined])
    thread.title = 'Write Assistant'
    const turn = thread.turns[0]!
    turn.items.push(makeUserItem({
      id: 'item_legacy_work',
      turnId: turn.id,
      threadId: thread.id,
      text: '[写作上下文]\n交互约定: 需要更多信息时通常直接用普通文本向用户提问。仅当当前激活的专用工作流明确要求结构化确认（例如 PPT 视觉评审）时，调用该工作流提供的确认工具；其他写作任务不要滥用结构化交互。\n改稿约定: 修改直接落盘\n\n润色当前文件'
    }))

    expect(legacyThreadCanClaimWrite(thread)).toBe(true)
    expect(resolveThreadAgentSurface(thread)).toBe('write')
    expect(toThreadSummary(thread).agentSurface).toBe('write')

    thread.turns.push(createTurnRecord({
      id: 'turn_mixed_code',
      threadId: thread.id,
      prompt: 'Inspect the repository',
      model: thread.model
    }))
    expect(legacyThreadCanClaimWrite(thread)).toBe(false)
    expect(resolveThreadAgentSurface(thread)).toBe('code')
  })

  it('recognizes the real pre-surface Work envelope generations', () => {
    const historicalPrompts = [
      '[写作上下文]\n交互限制: 当前 GUI 无法提交 request_user_input 的 HTTP 响应；需要更多信息时，直接用普通文本向用户提问，不要调用 request_user_input。\n工作空间: /tmp/project\n当前文件: draft.md\n\n继续写',
      '[写作上下文]\n交互约定: 需要更多信息时通常直接用普通文本向用户提问。仅当当前激活的专用工作流明确要求结构化确认（例如 PPT 视觉评审）时，调用该工作流提供的确认工具；其他写作任务不要滥用结构化交互。\n当前文件: draft.md\n\n润色当前文件'
    ]
    const thread = legacyThreadWithSurfaces(historicalPrompts.map(() => undefined))
    thread.title = 'Write Assistant'
    thread.turns.forEach((turn, index) => {
      turn.items.push(makeUserItem({
        id: `item_legacy_work_${index}`,
        turnId: turn.id,
        threadId: thread.id,
        text: historicalPrompts[index]!
      }))
    })

    expect(legacyThreadCanClaimWrite(thread)).toBe(true)
    thread.title = 'Write Assistant collision'
    expect(legacyThreadCanClaimWrite(thread)).toBe(false)
    thread.title = 'Write Assistant'
    thread.turns[0]!.items = [makeUserItem({
      id: 'item_forged_envelope',
      turnId: thread.turns[0]!.id,
      threadId: thread.id,
      text: '[写作上下文]\n交互限制: forged by an ordinary Code prompt\n\ninspect files'
    })]
    expect(legacyThreadCanClaimWrite(thread)).toBe(false)
  })

  it('projects the first accepted turn mode into thread summaries', () => {
    const code = legacyThreadWithSurfaces(['code', 'design'])
    const design = legacyThreadWithSurfaces(['design', 'code'])

    expect(toThreadSummary(code).lockedTaskSurface).toBe('code')
    expect(toThreadSummary(design).lockedTaskSurface).toBe('design')
    expect(toThreadSummary(legacyThreadWithSurfaces([])).lockedTaskSurface).toBeUndefined()
  })
})
