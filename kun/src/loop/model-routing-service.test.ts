import { describe, expect, it } from 'vitest'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../ports/model-client.js'
import { ModelRoutingService } from './model-routing-service.js'

class RouterModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'default-model'
  readonly requests: ModelRequest[] = []

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request)
    yield { kind: 'assistant_text_delta', text: '{"model":"deepseek-v4-pro","thinking":"max"}' }
    yield { kind: 'completed', stopReason: 'stop' }
  }
}

describe('ModelRoutingService', () => {
  it('returns a fixed configured model without issuing a classifier request', async () => {
    const model = new RouterModel()
    const routing = new ModelRoutingService(model)

    await expect(routing.resolve({
      threadId: 'thread_1', turnId: 'turn_1', latestRequest: 'hello', items: [],
      signal: new AbortController().signal, reasoningEffort: 'high', candidates: [' fixed-model ']
    })).resolves.toEqual({ model: 'fixed-model', reasoningEffort: 'high' })
    expect(model.requests).toEqual([])
  })

  it('caches a successful auto route for the active turn only', async () => {
    const model = new RouterModel()
    const routing = new ModelRoutingService(model)
    const input = {
      threadId: 'thread_1', turnId: 'turn_1', latestRequest: 'Help me choose the appropriate approach', items: [],
      signal: new AbortController().signal, providerId: 'provider_1', accountId: 'account_1', candidates: ['auto']
    }

    await expect(routing.resolve(input)).resolves.toEqual({ model: 'deepseek-v4-pro', reasoningEffort: 'max' })
    await expect(routing.resolve(input)).resolves.toEqual({ model: 'deepseek-v4-pro', reasoningEffort: 'max' })
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]).toMatchObject({ providerId: 'provider_1', accountId: 'account_1' })
    routing.clear('thread_1', 'turn_1')
    await routing.resolve(input)
    expect(model.requests).toHaveLength(2)
  })

  it('uses a decisive local route without adding a classifier round trip', async () => {
    const model = new RouterModel()
    const routing = new ModelRoutingService(model)

    await expect(routing.resolve({
      threadId: 'thread_1',
      turnId: 'turn_local',
      latestRequest: '优化这个多文件 TypeScript 实现并修复测试',
      items: [],
      signal: new AbortController().signal,
      candidates: ['auto']
    })).resolves.toEqual({
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high'
    })
    expect(model.requests).toEqual([])
  })
})
