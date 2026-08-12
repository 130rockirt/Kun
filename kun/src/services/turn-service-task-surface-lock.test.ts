import { describe, expect, it } from 'vitest'
import type { DesignTaskProfileInput } from '../contracts/design-task-profile.js'
import { createThreadRecord } from '../domain/thread.js'
import { createTurnRecord } from '../domain/turn.js'
import { TaskSurfaceLockedError } from './turn-service-core.js'
import { legacyThreadCanClaimWrite, resolveDesignTurnAdmission } from './turn-service-design-admission.js'

const profile: DesignTaskProfileInput = {
  version: 1,
  documentTarget: { documentId: 'doc_1', boardArtifactId: 'board_1' },
  outputMedium: 'html',
  target: 'web',
  preset: 'none',
  context: { tone: [] }
}

function codeWorkbench() {
  return createThreadRecord({
    id: 'thr_mode_lock',
    title: 'Code workbench',
    workspace: '/tmp/workspace',
    model: 'test',
    agentSurface: 'code'
  })
}

describe('turn task-surface lock', () => {
  it('allows either mode before the first accepted turn', () => {
    const admission = resolveDesignTurnAdmission({
      thread: codeWorkbench(),
      request: {
        prompt: 'Design the dashboard',
        agentSurface: 'design',
        designProfile: profile,
        designDocumentTarget: profile.documentTarget
      },
      turnId: 'turn_design'
    })

    expect(admission).toMatchObject({
      effectiveSurface: 'design',
      locksProfile: true
    })
  })

  it('rejects Design after the first accepted Code turn', () => {
    const thread = codeWorkbench()
    thread.turns.push({
      ...createTurnRecord({
        id: 'turn_code',
        threadId: thread.id,
        prompt: 'Inspect the code',
        model: thread.model,
        agentSurface: 'code'
      }),
      admissionCompletedAt: '2026-08-12T12:00:00.000Z'
    })

    expect(() => resolveDesignTurnAdmission({
      thread,
      request: {
        prompt: 'Switch to Design',
        agentSurface: 'design',
        designProfile: profile,
        designDocumentTarget: profile.documentTarget
      },
      turnId: 'turn_rejected'
    })).toThrow(TaskSurfaceLockedError)
  })

  it('keeps the first accepted mode authoritative for migrated mixed history', () => {
    const thread = codeWorkbench()
    thread.turns.push({
      ...createTurnRecord({
        id: 'turn_legacy_code',
        threadId: thread.id,
        prompt: 'Legacy Code turn',
        model: thread.model,
        agentSurface: 'code'
      }),
      admissionCompletedAt: '2026-08-12T12:00:00.000Z'
    })
    thread.designProfile = { ...profile, lockedAtTurnId: 'turn_legacy_design' }

    expect(resolveDesignTurnAdmission({
      thread,
      request: { prompt: 'Switch to Code', agentSurface: 'code' },
      turnId: 'turn_code_continue'
    })).toMatchObject({ effectiveSurface: 'code', locksProfile: false })

    expect(() => resolveDesignTurnAdmission({
      thread,
      request: {
        prompt: 'Continue Design',
        agentSurface: 'design',
        designProfile: profile,
        designDocumentTarget: profile.documentTarget
      },
      turnId: 'turn_rejected'
    })).toThrow(TaskSurfaceLockedError)
  })

  it('ignores a failed provisional Design profile when choosing the first mode', () => {
    const thread = codeWorkbench()
    thread.turns.push(createTurnRecord({
      id: 'turn_failed_design',
      threadId: thread.id,
      prompt: 'Design admission that never committed',
      model: thread.model,
      agentSurface: 'design',
      admissionPending: true,
      status: 'failed'
    }))
    thread.designProfile = { ...profile, lockedAtTurnId: 'turn_failed_design' }

    expect(resolveDesignTurnAdmission({
      thread,
      request: { prompt: 'Start in Code', agentSurface: 'code' },
      turnId: 'turn_code'
    })).toMatchObject({ effectiveSurface: 'code', locksProfile: false })
  })

  it('does not let a title collision or ordinary legacy Code history claim Work', () => {
    const collision = createThreadRecord({
      id: 'thr_title_collision',
      title: 'Write Assistant',
      workspace: '/tmp/workspace',
      model: 'test'
    })
    collision.turns.push(createTurnRecord({
      id: 'turn_code',
      threadId: collision.id,
      prompt: 'Inspect the repository',
      model: collision.model
    }))

    expect(legacyThreadCanClaimWrite(collision)).toBe(false)
    expect(() => resolveDesignTurnAdmission({
      thread: collision,
      request: { prompt: 'try Work', agentSurface: 'write' },
      turnId: 'turn_rejected'
    })).toThrow(TaskSurfaceLockedError)
  })
})
