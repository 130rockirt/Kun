import { describe, expect, it } from 'vitest'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../ports/model-client.js'
import { generateThreadTitle, resolveRoleModel } from './title-generator.js'

describe('resolveRoleModel', () => {
  it('keeps provider and account routing aligned with the selected role model', () => {
    expect(resolveRoleModel({
      roleModel: ' title-model ',
      roleProviderId: ' title-provider ',
      roleAccountId: ' title-account ',
      roles: {
        smallModel: 'small-model',
        smallModelProviderId: 'small-provider',
        smallModelAccountId: 'small-account'
      },
      mainModel: 'main-model',
      mainProviderId: 'main-provider',
      mainAccountId: 'main-account'
    })).toEqual({
      model: 'title-model',
      providerId: 'title-provider',
      accountId: 'title-account'
    })

    expect(resolveRoleModel({
      roles: {
        smallModel: 'small-model',
        smallModelProviderId: 'small-provider',
        smallModelAccountId: 'small-account'
      },
      mainModel: 'main-model',
      mainProviderId: 'main-provider',
      mainAccountId: 'main-account'
    })).toEqual({
      model: 'small-model',
      providerId: 'small-provider',
      accountId: 'small-account'
    })

    expect(resolveRoleModel({
      mainModel: 'main-model',
      mainProviderId: 'main-provider',
      mainAccountId: 'main-account'
    })).toEqual({
      model: 'main-model',
      providerId: 'main-provider',
      accountId: 'main-account'
    })
  })
})

describe('generateThreadTitle', () => {
  it('forwards the selected provider account without exposing it in prompt content', async () => {
    let captured: ModelRequest | undefined
    const modelClient: ModelClient = {
      provider: 'test',
      model: 'test-model',
      async *stream(request): AsyncIterable<ModelStreamChunk> {
        captured = request
        yield { kind: 'assistant_text_delta', text: 'Account-aware title' }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }

    await expect(generateThreadTitle({
      threadId: 'thread_title',
      turnId: 'turn_title',
      modelClient,
      model: 'title-model',
      providerId: 'provider-extension',
      accountId: 'account-private',
      userText: 'Design an extension provider'
    })).resolves.toBe('Account-aware title')

    expect(captured).toMatchObject({
      model: 'title-model',
      providerId: 'provider-extension',
      accountId: 'account-private'
    })
    expect(JSON.stringify(captured?.history)).not.toContain('account-private')
  })

  it('builds the title prompt from user input only', async () => {
    let captured: ModelRequest | undefined
    const modelClient: ModelClient = {
      provider: 'test',
      model: 'test-model',
      async *stream(request): AsyncIterable<ModelStreamChunk> {
        captured = request
        yield { kind: 'assistant_text_delta', text: 'Release review' }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }

    await expect(generateThreadTitle({
      threadId: 'thread_title',
      turnId: 'turn_title',
      modelClient,
      model: 'title-model',
      userText: '帮我做发版前最后review'
    })).resolves.toBe('Release review')

    const historyText = JSON.stringify(captured?.history)
    expect(historyText).toContain('User message:')
    expect(historyText).toContain('帮我做发版前最后review')
    expect(historyText).not.toContain('Assistant reply')
    expect(captured?.turnId).toBe('turn_title_title')
  })
})
