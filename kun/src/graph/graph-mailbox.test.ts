import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileArtifactStore } from '../artifacts/artifact-store.js'
import { GraphControlService } from './graph-control-service.js'
import { GraphMailbox } from './graph-mailbox.js'
import { FileGraphRunStore, GraphRunConflictError } from './graph-run-store.js'
import { testGraphConfig, testGraphPlan } from './graph-test-fixtures.test-support.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('GraphMailbox', () => {
  it('enforces membership and quotas while keeping retries idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-mailbox-'))
    roots.push(root)
    const config = testGraphConfig({
      mailbox: {
        maxMessagesPerRun: 1,
        maxMessagesPerNode: 1,
        maxMessagesPerMinute: 1
      }
    })
    const store = new FileGraphRunStore({
      rootDir: join(root, 'graphs'),
      artifactStore: new FileArtifactStore(join(root, 'artifacts')),
      config: () => config
    })
    const control = new GraphControlService({ store, config: () => config })
    await control.create({
      runId: 'run_1',
      threadId: 'thread_1',
      projectId: 'project_1',
      sourceTurnId: 'turn_1',
      plan: testGraphPlan({
        budget: { ...testGraphPlan().budget, maxMessages: 1 }
      }),
      commandId: 'create_1',
      idempotencyKey: 'create_1'
    })
    const mailbox = new GraphMailbox({ store, config: () => config })
    const input = {
      id: 'message_1',
      runId: 'run_1',
      sender: { kind: 'lead' as const },
      recipients: [{ kind: 'worker' as const, nodeId: 'finish' }],
      type: 'finding' as const,
      priority: 'normal' as const,
      summary: 'Use the verified research result.',
      artifactRefs: [],
      replyRequired: false
    }
    const first = await mailbox.send(input, {
      commandId: 'send_1',
      idempotencyKey: 'send_1'
    })
    expect(first.duplicate).toBe(false)
    expect(first.run.budget.messages).toBe(1)

    const duplicate = await mailbox.send(input, {
      commandId: 'send_retry',
      idempotencyKey: 'send_retry'
    })
    expect(duplicate.duplicate).toBe(true)
    expect(duplicate.run.budget.messages).toBe(1)

    await expect(mailbox.send({ ...input, summary: 'Different content.' }, {
      commandId: 'send_spoof',
      idempotencyKey: 'send_spoof'
    })).rejects.toBeInstanceOf(GraphRunConflictError)
    await expect(mailbox.send({
      ...input,
      id: 'message_2',
      recipients: [{ kind: 'worker', nodeId: 'unknown' }]
    }, {
      commandId: 'send_unknown',
      idempotencyKey: 'send_unknown'
    })).rejects.toThrow('not a run member')
  })

  it('delivers and acknowledges only to the authorized recipient', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-mailbox-'))
    roots.push(root)
    const config = testGraphConfig()
    const store = new FileGraphRunStore({
      rootDir: join(root, 'graphs'),
      artifactStore: new FileArtifactStore(join(root, 'artifacts')),
      config: () => config
    })
    const control = new GraphControlService({ store, config: () => config })
    await control.create({
      runId: 'run_1',
      threadId: 'thread_1',
      projectId: 'project_1',
      sourceTurnId: 'turn_1',
      plan: testGraphPlan(),
      commandId: 'create_1',
      idempotencyKey: 'create_1'
    })
    const mailbox = new GraphMailbox({ store, config: () => config })
    await mailbox.send({
      id: 'message_1',
      runId: 'run_1',
      sender: { kind: 'system' },
      recipients: [{ kind: 'worker', nodeId: 'finish' }],
      type: 'system',
      priority: 'blocking',
      summary: 'Confirm the handoff.',
      artifactRefs: [],
      replyRequired: true
    }, { commandId: 'send_1', idempotencyKey: 'send_1' })

    const delivered = await mailbox.receive(
      'run_1',
      { kind: 'worker', nodeId: 'finish' },
      'receive_1'
    )
    expect(delivered.messages[0]?.status).toBe('delivered')
    await expect(mailbox.acknowledge(
      'run_1',
      'message_1',
      { kind: 'worker', nodeId: 'research' },
      { commandId: 'ack_wrong', idempotencyKey: 'ack_wrong' }
    )).rejects.toThrow('not authorized')
    const acknowledged = await mailbox.acknowledge(
      'run_1',
      'message_1',
      { kind: 'worker', nodeId: 'finish' },
      { commandId: 'ack_1', idempotencyKey: 'ack_1' }
    )
    expect(acknowledged.messages[0]?.status).toBe('acknowledged')
    expect(mailbox.unresolvedBlockers(acknowledged)).toEqual([])
  })
})
