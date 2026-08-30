import { describe, expect, it } from 'vitest'
import {
  appendPlanTask,
  buildPlanBoardCards,
  deletePlanTask,
  replacePlanTaskTitle
} from './plan-board-model'
import type { ThreadTodoList } from '../agent/types'

const now = '2026-01-01T00:00:00.000Z'

function todos(): ThreadTodoList {
  return {
    threadId: 'thr_1',
    updatedAt: now,
    items: [{
      id: 'todo_1', content: 'Build board', status: 'in_progress', createdAt: now, updatedAt: now,
      source: { kind: 'plan', planId: 'plan_1', relativePath: '.kunsdd/plan/demo.md', ordinal: 0, contentHash: 'hash' }
    }, {
      id: 'other', content: 'Other plan', status: 'completed', createdAt: now, updatedAt: now,
      source: { kind: 'plan', planId: 'plan_2', relativePath: '.kunsdd/plan/other.md', ordinal: 0, contentHash: 'other' }
    }]
  }
}

describe('plan-board-model', () => {
  it('projects H2/H3 tasks, ignores fenced tasks, and merges current plan todos', () => {
    const markdown = [
      '# Demo', '## Implementation', '- [ ] Build board', '```md', '- [x] Ignore me', '```',
      '### Tests', '* [X] Add tests', '+ [ ] Ship'
    ].join('\r\n')
    const cards = buildPlanBoardCards({
      markdown, planId: 'plan_1', relativePath: '.kunsdd\\plan\\demo.md', todos: todos()
    })
    expect(cards.map((card) => ({ title: card.title, section: card.sectionTitle, status: card.status }))).toEqual([
      { title: 'Build board', section: 'Implementation', status: 'in_progress' },
      { title: 'Add tests', section: 'Tests', status: 'completed' },
      { title: 'Ship', section: 'Tests', status: 'pending' }
    ])
    expect(cards[0]?.todoId).toBe('todo_1')
    expect(markdown.slice(cards[0]!.from, cards[0]!.to)).toBe('- [ ] Build board')
  })

  it('keeps longer fences open across shorter and trailing-content markers', () => {
    const markdown = [
      '## Tasks', '````md', '- [ ] Hidden one', '```', '- [ ] Hidden two',
      '```` not-a-close', '- [ ] Hidden three', '````',
      '~~~', '- [ ] Hidden tilde', '~~~', '- [ ] Visible'
    ].join('\r\n')
    const cards = buildPlanBoardCards({
      markdown, planId: 'plan_1', relativePath: '.kunsdd/plan/demo.md', todos: null
    })
    expect(cards.map((card) => card.title)).toEqual(['Visible'])
  })

  it('edits, deletes, and appends task lines without rewriting the document', () => {
    const markdown = '# Demo\n\n## Implementation\n\n- [ ] Build board\n\nNotes\n'
    const [card] = buildPlanBoardCards({ markdown, planId: 'plan_1', relativePath: 'demo.md', todos: null })
    expect(replacePlanTaskTitle(markdown, card!, 'Build better board')).toContain('- [ ] Build better board')
    expect(deletePlanTask(markdown, card!)).not.toContain('Build board')
    expect(appendPlanTask(markdown, 'Add tests')).toContain('## Tasks\n\n- [ ] Add tests')
  })
})
