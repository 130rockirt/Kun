import { describe, expect, it } from 'vitest'
import type { PptDirectionBundleV1 } from '../../ppt/ppt-direction-workflow.js'
import {
  resolvePptPromptDirectionSelection,
  resolvePptUserInputDirectionSelection
} from './ppt-agent-direction-prompt.js'

const directions = [
  { directionId: 'editorial', name: 'Editorial Focus', revision: 1, recommended: false },
  { directionId: 'signal', name: 'Signal System', revision: 2, recommended: true },
  { directionId: 'warm', name: 'Warm Narrative', revision: 3, recommended: false }
] as PptDirectionBundleV1['directions']

describe('PPT conversational direction selection', () => {
  it.each([
    ['采用第 3 个方向，继续生成', 'warm'],
    ['那就方案 1 吧', 'editorial'],
    ['Use option B and continue.', 'signal'],
    ['采用 Warm Narrative，图片更有温度', 'warm'],
    ['采用推荐方案。', 'signal'],
    ['第三个吧', 'warm'],
    ['B', 'signal']
  ])('resolves %s only against persisted candidates', (prompt, directionId) => {
    expect(resolvePptPromptDirectionSelection({ prompt, directions })).toEqual({
      ok: true,
      selection: expect.objectContaining({ directionId })
    })
  })

  it('lets a conversational confirmation adopt a structured canvas selection', () => {
    expect(resolvePptPromptDirectionSelection({
      prompt: '这个效果不错，就用它继续吧。',
      directions,
      structuredSelection: [{ directionId: 'editorial', revision: 1 }]
    })).toEqual({ ok: true, selection: { directionId: 'editorial', revision: 1 } })
  })

  it.each([
    '第三个方向怎么样？',
    '不要采用推荐方案。',
    'I might use option 2 later.',
    'Inspect this selected direction.'
  ])('does not promote non-acceptance text: %s', (prompt) => {
    expect(resolvePptPromptDirectionSelection({ prompt, directions })).toMatchObject({
      ok: false,
      reason: 'acceptance_required'
    })
  })

  it('rejects an affirmative reply that does not identify a direction', () => {
    expect(resolvePptPromptDirectionSelection({
      prompt: 'Use a suitable direction and continue.',
      directions
    })).toEqual({ ok: false, reason: 'direction_required' })
  })

  it.each([
    ['3. Warm Narrative', 'warm'],
    ['Signal System (Recommended)', 'signal'],
    ['方向 1', 'editorial']
  ])('treats submitted user input as an explicit persisted selection: %s', (answer, directionId) => {
    expect(resolvePptUserInputDirectionSelection({ answer, directions })).toEqual({
      ok: true,
      selection: expect.objectContaining({ directionId })
    })
  })
})
