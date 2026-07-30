import { describe, expect, it, vi } from 'vitest'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { RoutePoolModelClient } from '../src/adapters/model/route-pool-model-client.js'
import type { ModelCapabilityMetadata } from '../src/contracts/capabilities.js'
import {
  LOCAL_MODEL_GATEWAY_PROVIDER_ID,
  type ModelRoutePoolConfig
} from '../src/contracts/model-route-pool.js'
import { createThreadRecord } from '../src/domain/thread.js'
import type { ApprovalReviewPort } from '../src/ports/approval-review.js'
import type {
  ModelClient,
  ModelRequest,
  ModelStreamChunk
} from '../src/ports/model-client.js'
import { makeHarness } from './loop-test-harness.js'

const capability = (model: string): ModelCapabilityMetadata => ({
  id: model,
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportsToolCalling: true,
  messageParts: ['text'],
  contextWindowTokens: 128_000,
  maxOutputTokens: 4_096
})

const routePool: ModelRoutePoolConfig = {
  id: 'approval-route-pool',
  name: 'Approval route pool',
  modelId: 'pooled-model',
  enabled: true,
  strategy: 'priority',
  targets: [
    {
      id: 'target-a',
      providerId: 'provider-a',
      modelId: 'model-a',
      enabled: true,
      weight: 1
    },
    {
      id: 'target-b',
      providerId: 'provider-b',
      modelId: 'model-b',
      enabled: true,
      weight: 1
    }
  ],
  failurePolicy: {
    failoverHttpStatusCodes: [429],
    failoverOnNetworkError: true,
    failoverOnTimeout: true,
    failoverOnAuthError: true
  },
  healthPolicy: {
    failureThreshold: 2,
    cooldownMs: 1_000,
    halfOpenMaxAttempts: 1
  }
}

class FailoverThenToolModel implements ModelClient {
  readonly provider = 'direct-test'
  readonly model = 'direct-default'
  readonly requests: ModelRequest[] = []
  private providerBRequests = 0

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request)
    if (request.providerId === 'provider-a') {
      yield {
        kind: 'retrying',
        status: 429,
        attempt: 1,
        maxAttempts: 2,
        delayMs: 1
      }
      yield {
        kind: 'error',
        message: 'target A is rate limited',
        failure: {
          category: 'rate_limit',
          httpStatus: 429,
          failoverAllowed: true
        }
      }
      return
    }
    this.providerBRequests += 1
    if (this.providerBRequests === 1) {
      yield {
        kind: 'tool_call_complete',
        callId: 'call_side_effect',
        toolName: 'route_side_effect',
        arguments: { target: 'bounded-target' }
      }
      yield { kind: 'completed', stopReason: 'tool_calls' }
      return
    }
    yield { kind: 'assistant_text_delta', text: 'Done.' }
    yield { kind: 'completed', stopReason: 'stop' }
  }
}

describe('route-pool acting approval route', () => {
  it('pins the post-failover target before automatic tool review', async () => {
    let executions = 0
    const sideEffect = LocalToolHost.defineTool({
      name: 'route_side_effect',
      description: 'Test-only approval-gated side effect.',
      inputSchema: {
        type: 'object',
        properties: { target: { type: 'string' } },
        required: ['target']
      },
      policy: 'on-request',
      effects: {
        network: false,
        externalWrite: false,
        processExecution: false,
        guiAutomation: false
      },
      execute: async () => {
        executions += 1
        return { output: { executed: true } }
      }
    })
    const direct = new FailoverThenToolModel()
    const model = new RoutePoolModelClient(
      direct,
      [routePool],
      capability
    )
    const review = vi.fn<ApprovalReviewPort['review']>(async () => ({
      decision: 'allow',
      reviewer: 'agent',
      reviewId: 'review-route-target',
      reviewStatus: 'approved',
      riskLevel: 'low'
    }))
    const harness = makeHarness(model, {
      tools: [sideEffect],
      modelCapabilities: capability,
      approvalReview: { review }
    })
    await harness.threadStore.upsert(createThreadRecord({
      id: harness.threadId,
      title: 'Route pool approval',
      workspace: '/tmp',
      model: routePool.modelId,
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      approvalReviewer: 'agent'
    }))
    const started = await harness.turns.startTurn({
      threadId: harness.threadId,
      request: {
        prompt: 'Perform the bounded side effect.',
        model: routePool.modelId,
        providerId: LOCAL_MODEL_GATEWAY_PROVIDER_ID,
        accountId: 'selected-account',
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        approvalReviewer: 'agent'
      }
    })
    harness.turnId = started.turnId

    await expect(harness.loop.runTurn(
      harness.threadId,
      harness.turnId
    )).resolves.toBe('completed')

    expect(executions).toBe(1)
    expect(direct.requests.map((request) => [
      request.providerId,
      request.model
    ])).toEqual([
      ['provider-a', 'model-a'],
      ['provider-b', 'model-b'],
      ['provider-b', 'model-b']
    ])
    expect(review).toHaveBeenCalledTimes(1)
    expect(review.mock.calls[0]?.[0].route).toEqual({
      model: 'model-b',
      providerId: 'provider-b',
      accountId: 'selected-account'
    })
    const persisted = await harness.turns.getTurn(
      harness.threadId,
      harness.turnId
    )
    expect(persisted?.actingModelRoute).toEqual({
      model: 'model-b',
      providerId: 'provider-b',
      accountId: 'selected-account'
    })
  })
})
