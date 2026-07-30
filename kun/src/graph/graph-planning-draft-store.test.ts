import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FileGraphPlanningDraftStore,
  GraphPlanningDraftConflictError
} from './graph-planning-draft-store.js'

const roots: string[] = []

async function store() {
  const rootDir = await mkdtemp(join(tmpdir(), 'kun-graph-planning-'))
  roots.push(rootDir)
  let tick = 0
  return new FileGraphPlanningDraftStore({
    rootDir,
    nowIso: () => new Date(Date.UTC(2026, 6, 29, 0, 0, tick++)).toISOString()
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })))
})

describe('FileGraphPlanningDraftStore', () => {
  it('creates one recoverable draft per source turn and persists its candidate', async () => {
    const drafts = await store()
    const input = {
      id: 'draft_1',
      reservedRunId: 'run_1',
      threadId: 'thread_1',
      sourceTurnId: 'turn_1',
      projectId: 'project_1',
      goal: 'Implement the requested change.'
    }

    const first = await drafts.create(input)
    const repeated = await drafts.create({
      ...input,
      id: 'draft_should_not_replace',
      reservedRunId: 'run_should_not_replace'
    })
    await drafts.writeCandidate(first.id, { tasks: [{ key: 'work' }] })

    expect(repeated).toEqual(first)
    expect(await drafts.findBySourceTurn('turn_1')).toEqual(first)
    expect(await drafts.readCandidate(first.id)).toEqual({
      tasks: [{ key: 'work' }]
    })
  })

  it('uses revision compare-and-swap so two resume requests cannot both mutate it', async () => {
    const drafts = await store()
    const draft = await drafts.create({
      id: 'draft_1',
      reservedRunId: 'run_1',
      threadId: 'thread_1',
      sourceTurnId: 'turn_1',
      projectId: 'project_1',
      goal: 'Implement the requested change.'
    })
    const next = await drafts.update(draft.id, {
      expectedRevision: draft.revision,
      status: 'needs_correction'
    })

    expect(next.revision).toBe(draft.revision + 1)
    await expect(drafts.update(draft.id, {
      expectedRevision: draft.revision,
      status: 'planning'
    })).rejects.toBeInstanceOf(GraphPlanningDraftConflictError)
  })
})
