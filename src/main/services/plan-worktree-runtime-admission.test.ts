import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PlanWorktreeRunRecord } from '../../shared/plan-worktree'
import { fingerprintStartTurnRequest } from '../../../kun/src/services/turn-service-core.js'
import {
  matchesPlanWorktreeAdmission,
  planWorktreeForkRequest,
  planWorktreeStartTurnFingerprint,
  planWorktreeStartTurnRequest
} from './plan-worktree-runtime-admission'
import { currentExecutionWorkspace } from './plan-worktree-admission-fence'

function record(): PlanWorktreeRunRecord {
  const executionPrompt = 'Exact authoritative plan prompt'
  return {
    version: 1,
    runId: 'run-1',
    operationId: 'operation-1',
    planId: 'plan-1',
    planRelativePath: '.kunsdd/plan/auth.md',
    planTitle: 'Auth',
    goalObjective: 'Implement and validate Auth',
    executionPrompt,
    executionDisplayText: 'Build Auth',
    executionPromptSha256: createHash('sha256').update(executionPrompt).digest('hex'),
    admissionClientRequestId: 'plan-build:run-1',
    sourceThreadId: 'thread-source',
    orchestration: 'direct',
    sourceWorkspaceRoot: '/repo',
    sourceCheckoutRoot: '/repo',
    primaryRepositoryRoot: '/repo',
    repositoryIdentity: '/repo/.git',
    targetBranch: 'feature/auth',
    baseCommit: 'a'.repeat(40),
    executionBranch: 'codex/auth-run',
    worktreePath: '/managed/run-1/repo',
    status: 'executing',
    cleanup: {
      threadRebound: false,
      worktreeRemoved: false,
      branchDeleted: false,
      metadataPruned: false
    },
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z'
  }
}

describe('plan worktree runtime admission identity', () => {
  it('matches Kun canonical StartTurnRequest defaults and key ordering', () => {
    const request = planWorktreeStartTurnRequest(record())
    expect(request).toEqual({
      prompt: 'Exact authoritative plan prompt',
      displayText: 'Build Auth',
      clientRequestId: 'plan-build:run-1',
      mode: 'agent',
      orchestration: 'direct',
      clientSurface: 'gui',
      agentSurface: 'code',
      attachmentIds: [],
      composerContexts: [],
      fileReferences: []
    })
    expect(planWorktreeStartTurnFingerprint(record()))
      .toBe('0a13751cda55d3b6913dfeee74b1a5bab906da084f1e65c4fbdd2bf1cd2c2035')
    expect(fingerprintStartTurnRequest(request!))
      .toBe(planWorktreeStartTurnFingerprint(record()))
  })

  it('verifies a redacted runtime turn from its canonical request fingerprint', () => {
    const durable = record()
    expect(matchesPlanWorktreeAdmission(durable, {
      id: 'turn-execution',
      prompt: '',
      clientRequestId: durable.admissionClientRequestId,
      clientRequestFingerprint: planWorktreeStartTurnFingerprint(durable),
      orchestration: 'direct',
      agentSurface: 'code'
    })).toBe(true)
  })

  it('binds a new run to an opaque capability and rejects prompt-hash fallback', () => {
    const durable = {
      ...record(),
      admissionCapability: 'a'.repeat(43)
    }
    const request = planWorktreeStartTurnRequest(durable)
    expect(request).toMatchObject({
      planBuildAdmissionCapability: durable.admissionCapability
    })
    expect(fingerprintStartTurnRequest(request!))
      .toBe(planWorktreeStartTurnFingerprint(durable))
    expect(planWorktreeForkRequest(durable, '/managed/run-1/repo')).toEqual({
      relation: 'side',
      workspace: '/managed/run-1/repo',
      planBuildRunId: 'run-1',
      planBuildAgentSurface: 'code',
      planBuildAdmissionFingerprint: planWorktreeStartTurnFingerprint(durable),
      planBuildAdmissionCapability: durable.admissionCapability
    })
    expect(matchesPlanWorktreeAdmission(durable, {
      id: 'turn-execution',
      prompt: durable.executionPrompt,
      clientRequestId: durable.admissionClientRequestId,
      orchestration: 'direct',
      agentSurface: 'code'
    })).toBe(false)
  })

  it('retains the prompt hash fallback for legacy unredacted projections', () => {
    const durable = record()
    expect(matchesPlanWorktreeAdmission(durable, {
      id: 'turn-execution',
      prompt: durable.executionPrompt,
      clientRequestId: durable.admissionClientRequestId,
      orchestration: 'direct',
      agentSurface: 'code'
    })).toBe(true)
  })

  it('fails closed when a legacy run has no durable admission request id', () => {
    const { admissionClientRequestId: _admissionClientRequestId, ...legacy } = record()
    expect(matchesPlanWorktreeAdmission(legacy, {
      id: 'turn-execution',
      prompt: record().executionPrompt,
      orchestration: 'direct',
      agentSurface: 'code'
    })).toBe(false)
  })

  it('keeps the canonical rebound workspace for later admission-fence transitions', () => {
    const rebound: PlanWorktreeRunRecord = {
      ...record(),
      sourceWorkspaceRoot: '/var/folders/source',
      executionWorkspace: '/private/var/folders/source',
      cleanup: {
        threadRebound: true,
        worktreeRemoved: true,
        branchDeleted: true,
        metadataPruned: true
      }
    }
    expect(currentExecutionWorkspace(rebound)).toBe('/private/var/folders/source')
  })
})
