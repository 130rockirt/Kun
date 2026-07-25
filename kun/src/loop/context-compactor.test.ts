import { describe, expect, it } from 'vitest'
import { createImmutablePrefix } from '../cache/immutable-prefix.js'
import type { TurnItem } from '../contracts/items.js'
import {
  makeAssistantTextItem,
  makeCompactionItem,
  makeToolCallItem,
  makeToolResultItem,
  makeUserItem
} from '../domain/item.js'
import { repairModelHistoryItems } from '../domain/model-history-repair.js'
import { ContextCompactor } from './context-compactor.js'
import { modelContextProfilesFromConfig } from './model-context-profile.js'

describe('ContextCompactor', () => {
  it('resolves same-id context thresholds from the active provider profile', () => {
    const providerProfiles = modelContextProfilesFromConfig({
      profiles: {
        shared: { contextWindowTokens: 1_000_000 }
      }
    })
    const compactor = new ContextCompactor({
      models: {
        profiles: {
          shared: { contextWindowTokens: 100_000 }
        }
      },
      profilesForProvider: (providerId) =>
        providerId === 'provider-b' ? providerProfiles : []
    })

    expect(compactor.thresholds('shared')).toEqual({
      softThreshold: 75_000,
      hardThreshold: 85_000
    })
    expect(compactor.thresholds('shared', 'provider-b')).toEqual({
      softThreshold: 750_000,
      hardThreshold: 850_000
    })
  })

  it('does not replace an existing summary when no new history can be folded', () => {
    const threadId = 'thr_compaction_no_progress'
    const turnId = 'turn_compaction_no_progress'
    const previousSummary = makeCompactionItem({
      id: 'compaction_previous',
      threadId,
      turnId,
      summary: 'Existing handoff summary',
      replacedTokens: 50_000,
      pinnedConstraints: [],
      auto: true
    })
    const recent = makeUserItem({
      id: 'item_recent',
      threadId,
      turnId,
      text: 'Keep this recent request verbatim.'
    })

    const result = new ContextCompactor().compact({
      threadId,
      turnId,
      history: [previousSummary, recent],
      prefix: createImmutablePrefix(),
      keepRecent: 1,
      mode: 'force'
    })

    expect(result.replacedTokens).toBe(0)
    expect(result.next).toEqual([previousSummary, recent])
  })

  it('retains a complete parallel tool batch when force compaction starts inside its results', () => {
    const threadId = 'thr_single_turn_tools'
    const turnId = 'turn_single_turn_tools'
    const finalCallIds = ['call_final_a', 'call_final_b', 'call_final_c']
    const finalCalls = finalCallIds.map((callId) =>
      makeToolCallItem({
        id: `item_${callId}`,
        threadId,
        turnId,
        callId,
        toolName: 'read',
        arguments: { path: `${callId}.ts` },
        status: 'completed'
      })
    )
    const finalResults = finalCallIds.map((callId) =>
      makeToolResultItem({
        id: `result_${callId}`,
        threadId,
        turnId,
        callId,
        toolName: 'read',
        output: `contents for ${callId}`
      })
    )
    const history: TurnItem[] = [
      makeUserItem({
        id: 'item_user',
        threadId,
        turnId,
        text: 'Inspect the repository with several tool batches.'
      }),
      makeAssistantTextItem({
        id: 'item_progress',
        threadId,
        turnId,
        text: 'Earlier findings that can be summarized.',
        status: 'completed'
      }),
      makeToolCallItem({
        id: 'item_old_call',
        threadId,
        turnId,
        callId: 'call_old',
        toolName: 'grep',
        arguments: { pattern: 'old' },
        status: 'completed'
      }),
      makeToolResultItem({
        id: 'item_old_result',
        threadId,
        turnId,
        callId: 'call_old',
        toolName: 'grep',
        output: 'old result'
      }),
      ...finalCalls,
      ...finalResults
    ]

    const result = new ContextCompactor().compact({
      threadId,
      turnId,
      history,
      prefix: createImmutablePrefix(),
      keepRecent: 1,
      mode: 'force'
    })
    const retainedIds = [...finalCalls, ...finalResults].map((item) => item.id)

    expect(result.next.map((item) => item.id)).toEqual([
      result.summaryItem.id,
      ...retainedIds
    ])
    expect(repairModelHistoryItems([...result.next])).toEqual(result.next)
    expect(result.next.at(-1)).toMatchObject({
      kind: 'tool_result',
      callId: 'call_final_c',
      output: 'contents for call_final_c'
    })
    expect(result.summaryItem.kind === 'compaction' ? result.summaryItem.sourceItemIds : [])
      .toEqual(history.slice(0, 4).map((item) => item.id))
  })

  it('cancels compaction when a retained tool result has no matching call', () => {
    const threadId = 'thr_malformed_tools'
    const turnId = 'turn_malformed_tools'
    const history: TurnItem[] = [
      makeUserItem({ id: 'item_user', threadId, turnId, text: 'Keep this request.' }),
      makeAssistantTextItem({
        id: 'item_answer',
        threadId,
        turnId,
        text: 'Partial answer',
        status: 'completed'
      }),
      makeToolResultItem({
        id: 'item_orphan_result',
        threadId,
        turnId,
        callId: 'missing_call',
        toolName: 'read',
        output: 'orphaned output'
      })
    ]

    const result = new ContextCompactor().compact({
      threadId,
      turnId,
      history,
      prefix: createImmutablePrefix(),
      keepRecent: 1,
      mode: 'force'
    })

    expect(result.replacedTokens).toBe(0)
    expect(result.next).toEqual(history)
  })

  it('preserves numbered problem outlines when heuristic compaction is the fallback', () => {
    const threadId = 'thr_compaction_outline'
    const turnId = 'turn_compaction_outline'
    const problems = Array.from(
      { length: 80 },
      (_, index) => `Problem ${index + 1}: preserve finding ${index + 1}`
    )
    const history: TurnItem[] = [
      makeUserItem({
        id: 'item_user_start',
        threadId,
        turnId,
        text: 'Repeat this instruction verbatim.'
      }),
      makeAssistantTextItem({
        id: 'item_problem_list',
        threadId,
        turnId,
        status: 'completed',
        text: ['Current problem list:', ...problems].join('\n')
      }),
      ...Array.from({ length: 50 }, (_, index) =>
        makeAssistantTextItem({
          id: `item_filler_${index}`,
          threadId,
          turnId,
          status: 'completed',
          text: `Routine progress note ${index + 1}.`
        })
      ),
      makeUserItem({
        id: 'item_recent_tail',
        threadId,
        turnId,
        text: 'Active Skill: retained-tail-only-skill\nRepeat this instruction verbatim.'
      })
    ]

    const result = new ContextCompactor().compact({
      threadId,
      turnId,
      history,
      prefix: createImmutablePrefix({
        pinnedConstraints: ['system: preserve user intent across compaction']
      }),
      keepRecent: 1,
      reason: 'test forced fallback summary'
    })

    expect(result.summaryItem.kind).toBe('compaction')
    if (result.summaryItem.kind !== 'compaction') return
    expect(result.summaryItem.summary).toContain('Problem 1: preserve finding 1')
    expect(result.summaryItem.summary).toContain('Problem 42: preserve finding 42')
    expect(result.summaryItem.summary).toContain('Problem 80: preserve finding 80')
    expect(result.summaryItem.summary).not.toContain('middle item(s) omitted from this compact summary')
    // The retained tail is sent verbatim after the summary. It must not be
    // repeated inside the summary as well. A repeated instruction in a
    // different turn is still preserved: the folded copy is summarized and
    // the newest copy stays verbatim in the tail.
    expect(result.summaryItem.summary).toContain('Repeat this instruction verbatim.')
    expect(result.summaryItem.summary).not.toContain('Active Skill: retained-tail-only-skill')
    expect(result.next.at(-1)).toMatchObject({
      id: 'item_recent_tail',
      text: 'Active Skill: retained-tail-only-skill\nRepeat this instruction verbatim.'
    })
  })
})
