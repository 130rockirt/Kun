import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileProjectBoardStore } from '../adapters/file/file-project-board-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { createThreadRecord } from '../domain/thread.js'
import { SequentialIdGenerator } from '../ports/id-generator.js'
import { ProjectBoardService } from './project-board-service.js'

const temporary: string[] = []
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'kun-project-board-service-'))
  temporary.push(root)
  const workspace = join(root, 'project')
  await mkdir(join(workspace, '.kunsdd', 'plan'), { recursive: true })
  await writeFile(join(workspace, '.kunsdd', 'plan', 'demo.md'), [
    '## Runtime',
    '- [ ] Build board API',
    '  Persist project tasks safely.'
  ].join('\n'))
  const threads = new InMemoryThreadStore()
  let tick = 0
  const nowIso = () => `2026-08-31T00:00:0${tick++}.000Z`
  const service = new ProjectBoardService({
    store: new FileProjectBoardStore({ dataDir: join(root, 'data'), nowIso }),
    threadStore: threads,
    ids: new SequentialIdGenerator(),
    nowIso
  })
  return { workspace, threads, service }
}

describe('ProjectBoardService', () => {
  it('federates only Plan todos and keeps manual cards workspace-scoped', async () => {
    const { workspace, threads, service } = await harness()
    const thread = createThreadRecord({ id: 'thr_plan', title: 'Plan thread', workspace, model: 'test' })
    thread.todos = {
      threadId: thread.id,
      updatedAt: '2026-08-31T00:00:00.000Z',
      items: [
        {
          id: 'todo_plan', content: 'Build board API', status: 'pending',
          source: { kind: 'plan', planId: 'plan_1', relativePath: '.kunsdd/plan/demo.md', ordinal: 0, contentHash: 'hash' },
          createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z'
        },
        {
          id: 'todo_temp', content: 'Temporary agent step', status: 'pending',
          createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z'
        }
      ]
    }
    await threads.upsert(thread)

    const initial = await service.snapshot({ workspace })
    expect(initial.cards).toHaveLength(1)
    expect(initial.cards[0]).toMatchObject({
      id: 'todo:thr_plan:todo_plan',
      description: 'Persist project tasks safely.',
      source: { sectionTitle: 'Runtime' }
    })

    const next = await service.createManualCard({
      workspace, expectedRevision: initial.revision, title: 'Manual card', description: '',
      status: 'in_progress', category: 'bug', priority: 'P0'
    })
    expect(next.revision).toBe(1)
    expect(next.counts).toMatchObject({ total: 2, inProgress: 1 })
    expect(next.cards[0]).toMatchObject({ kind: 'manual', priority: 'P0' })
  })

  it('stores overlays by thread and todo identity without changing Plan titles', async () => {
    const { workspace, threads, service } = await harness()
    const thread = createThreadRecord({ id: 'thr_plan', title: 'Plan thread', workspace, model: 'test' })
    thread.todos = {
      threadId: thread.id, updatedAt: '2026-08-31T00:00:00.000Z',
      items: [{
        id: 'same_id', content: 'Authoritative title', status: 'pending',
        source: { kind: 'plan', planId: 'plan_1', relativePath: '.kunsdd/plan/demo.md', ordinal: 0, contentHash: 'hash' },
        createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z'
      }]
    }
    await threads.upsert(thread)
    const initial = await service.snapshot({ workspace })
    const next = await service.patchTodoOverlay('thr_plan', 'same_id', {
      workspace, expectedRevision: initial.revision, category: 'api', priority: 'P1',
      description: 'Board-only detail'
    })
    expect(next.cards[0]).toMatchObject({
      title: 'Authoritative title', category: 'api', priority: 'P1', description: 'Board-only detail'
    })
  })

  it('folds a custom Git worktree thread into its main project board', async () => {
    const { workspace, threads, service } = await harness()
    const worktree = `${workspace}.worktrees/feature-board`
    await mkdir(worktree, { recursive: true })
    await writeFile(join(worktree, '.git'), `gitdir: ${workspace}/.git/worktrees/feature-board\n`)
    const thread = createThreadRecord({ id: 'thr_worktree', title: 'Worktree', workspace: worktree, model: 'test' })
    thread.todos = {
      threadId: thread.id, updatedAt: '2026-08-31T00:00:00.000Z',
      items: [{
        id: 'todo_worktree', content: 'Build in worktree', status: 'pending',
        source: { kind: 'plan', planId: 'plan_1', relativePath: '.kunsdd/plan/demo.md', ordinal: 0, contentHash: 'hash' },
        createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z'
      }]
    }
    await threads.upsert(thread)
    const snapshot = await service.snapshot({ workspace })
    expect(snapshot.cards.map((card) => card.id)).toContain('todo:thr_worktree:todo_worktree')
  })

  it('builds batch summaries from one thread inventory read', async () => {
    const { workspace, threads, service } = await harness()
    const other = `${workspace}-other`
    await mkdir(other)
    const list = vi.spyOn(threads, 'list')

    const summaries = await service.summaries([workspace, other])

    expect(summaries).toHaveLength(2)
    expect(list).toHaveBeenCalledTimes(1)
  })
})
