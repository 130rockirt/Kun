import {
  GRAPH_CONTRACT_VERSION,
  GraphMessageV1Schema,
  type GraphMessageV1,
  type GraphRunV1
} from '../contracts/graph.js'
import type { GraphRuntimeConfig } from '../config/kun-config.js'
import {
  GraphRunConflictError,
  GraphRunNotFoundError,
  type GraphRunStore
} from './graph-run-store.js'

export type GraphMailboxSendInput = Omit<
  GraphMessageV1,
  'version' | 'status' | 'createdAt' | 'expiresAt' | 'acknowledgedAt'
> & {
  ttlMs?: number
}

export type GraphMailboxOptions = {
  store: GraphRunStore
  config: () => GraphRuntimeConfig
  nowIso?: () => string
}

export class GraphMailbox {
  private readonly nowIso: () => string
  private readonly sendQueues = new Map<string, Promise<void>>()

  constructor(private readonly options: GraphMailboxOptions) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString())
  }

  async send(
    input: GraphMailboxSendInput,
    command: { commandId: string; idempotencyKey: string }
  ): Promise<{ run: GraphRunV1; message: GraphMessageV1; duplicate: boolean }> {
    return this.withSendQueue(input.runId, () => this.sendLocked(input, command))
  }

  private async sendLocked(
    input: GraphMailboxSendInput,
    command: { commandId: string; idempotencyKey: string }
  ): Promise<{ run: GraphRunV1; message: GraphMessageV1; duplicate: boolean }> {
    const run = await this.requireRun(input.runId)
    this.validateMessage(run, input)
    const prior = run.messages.find((message) => message.id === input.id)
    if (prior) {
      if (!sameMessageInput(prior, input)) {
        throw new GraphRunConflictError(`Graph message id already exists with different content: ${input.id}`)
      }
      return { run, message: prior, duplicate: true }
    }
    const config = this.options.config().mailbox
    const now = this.nowIso()
    const perNodeCount = input.sender.nodeId
      ? run.messages.filter((message) => message.sender.nodeId === input.sender.nodeId).length
      : 0
    if (run.messages.length >= Math.min(config.maxMessagesPerRun, run.budget.limits.maxMessages)) {
      throw new GraphRunConflictError('Graph mailbox run quota exhausted')
    }
    if (input.sender.nodeId && perNodeCount >= config.maxMessagesPerNode) {
      throw new GraphRunConflictError(`Graph mailbox node quota exhausted: ${input.sender.nodeId}`)
    }
    const minuteAgo = Date.parse(now) - 60_000
    const recentCount = run.messages.filter((message) =>
      Date.parse(message.createdAt) >= minuteAgo).length
    if (recentCount >= config.maxMessagesPerMinute) {
      throw new GraphRunConflictError('Graph mailbox rate limit exceeded')
    }
    const rawBytes = Buffer.byteLength(JSON.stringify(input), 'utf8')
    if (rawBytes > config.maxMessageBytes) {
      throw new GraphRunConflictError(
        `Graph message is ${rawBytes} bytes; maximum is ${config.maxMessageBytes}`
      )
    }
    if (input.artifactRefs.length > config.maxArtifactRefsPerMessage) {
      throw new GraphRunConflictError('Graph message artifact reference quota exceeded')
    }
    const ttl = input.ttlMs ?? config.defaultTtlMs
    const message = GraphMessageV1Schema.parse({
      version: GRAPH_CONTRACT_VERSION,
      ...input,
      status: 'queued',
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + ttl).toISOString()
    })
    const appended = await this.options.store.append(run.id, {
      expectedSeq: run.lastEventSeq,
      graphRevision: run.currentRevision,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      event: { type: 'message_created', payload: { message } }
    })
    if (appended.duplicate) {
      const existing = appended.state.messages.find((entry) => entry.id === message.id)
      return { run: appended.state, message: existing ?? message, duplicate: true }
    }
    const ledger = {
      ...appended.state.budget,
      messages: appended.state.budget.messages + 1
    }
    const budgeted = await this.options.store.append(run.id, {
      expectedSeq: appended.state.lastEventSeq,
      graphRevision: appended.state.currentRevision,
      commandId: `${command.commandId}_budget`,
      idempotencyKey: `${command.idempotencyKey}:budget`,
      event: { type: 'budget_updated', payload: { ledger, reason: 'mailbox message accepted' } }
    })
    return { run: budgeted.state, message, duplicate: false }
  }

  private async withSendQueue<T>(
    runId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const prior = this.sendQueues.get(runId) ?? Promise.resolve()
    const current = prior
      .catch(() => undefined)
      .then(operation)
    const settled = current.then(
      () => undefined,
      () => undefined
    )
    this.sendQueues.set(runId, settled)
    void settled.finally(() => {
      if (this.sendQueues.get(runId) === settled) this.sendQueues.delete(runId)
    })
    return current
  }

  async receive(
    runId: string,
    recipient: GraphMessageV1['recipients'][number],
    commandPrefix: string
  ): Promise<{ run: GraphRunV1; messages: GraphMessageV1[] }> {
    let run = await this.requireRun(runId)
    run = await this.expire(run, `${commandPrefix}_expire`)
    const matching = run.messages.filter((message) =>
      (message.status === 'queued' || message.status === 'delivered') &&
      message.recipients.some((target) => sameRecipient(target, recipient)))
    for (const message of matching.filter((entry) => entry.status === 'queued')) {
      const appended = await this.options.store.append(run.id, {
        expectedSeq: run.lastEventSeq,
        graphRevision: run.currentRevision,
        commandId: `${commandPrefix}_${message.id}_deliver`,
        idempotencyKey: `${commandPrefix}:${message.id}:deliver`,
        event: {
          type: 'message_status_changed',
          payload: { messageId: message.id, status: 'delivered' }
        }
      })
      run = appended.state
    }
    return {
      run,
      messages: run.messages.filter((message) =>
        (message.status === 'delivered' || message.status === 'queued') &&
        message.recipients.some((target) => sameRecipient(target, recipient)))
    }
  }

  async acknowledge(
    runId: string,
    messageId: string,
    recipient: GraphMessageV1['recipients'][number],
    command: { commandId: string; idempotencyKey: string }
  ): Promise<GraphRunV1> {
    const run = await this.requireRun(runId)
    const message = run.messages.find((entry) => entry.id === messageId)
    if (!message) throw new GraphRunNotFoundError(`${runId}/message/${messageId}`)
    if (!message.recipients.some((target) => sameRecipient(target, recipient))) {
      throw new GraphRunConflictError('mailbox acknowledgement recipient is not authorized')
    }
    if (message.status === 'acknowledged') return run
    if (message.status !== 'queued' && message.status !== 'delivered') {
      throw new GraphRunConflictError(`cannot acknowledge message from ${message.status}`)
    }
    return (await this.options.store.append(run.id, {
      expectedSeq: run.lastEventSeq,
      graphRevision: run.currentRevision,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      event: {
        type: 'message_status_changed',
        payload: {
          messageId,
          status: 'acknowledged',
          acknowledgedAt: this.nowIso()
        }
      }
    })).state
  }

  async expire(runInput: GraphRunV1, commandPrefix: string): Promise<GraphRunV1> {
    let run = runInput
    const now = Date.parse(this.nowIso())
    for (const message of run.messages) {
      if (
        (message.status === 'queued' || message.status === 'delivered') &&
        message.expiresAt &&
        Date.parse(message.expiresAt) <= now
      ) {
        run = (await this.options.store.append(run.id, {
          expectedSeq: run.lastEventSeq,
          graphRevision: run.currentRevision,
          commandId: `${commandPrefix}_${message.id}`,
          idempotencyKey: `${commandPrefix}:${message.id}`,
          event: {
            type: 'message_status_changed',
            payload: { messageId: message.id, status: 'expired' }
          }
        })).state
      }
    }
    return run
  }

  unresolvedBlockers(run: GraphRunV1): GraphMessageV1[] {
    const now = Date.parse(this.nowIso())
    return run.messages.filter((message) =>
      message.priority === 'blocking' &&
      message.replyRequired &&
      message.status !== 'acknowledged' &&
      message.status !== 'rejected' &&
      message.status !== 'expired' &&
      (!message.expiresAt || Date.parse(message.expiresAt) > now))
  }

  private validateMessage(run: GraphRunV1, input: GraphMailboxSendInput): void {
    if (input.sender.kind === 'worker') {
      if (!input.sender.nodeId || !input.sender.attemptId) {
        throw new GraphRunConflictError('worker messages require node and attempt identity')
      }
      const attempt = run.nodes[input.sender.nodeId]?.attempts.find(
        (entry) => entry.id === input.sender.attemptId)
      if (!attempt) throw new GraphRunConflictError('worker sender attempt is not a run member')
    } else if (input.sender.nodeId || input.sender.attemptId) {
      throw new GraphRunConflictError('non-worker sender cannot claim worker identity')
    }
    for (const recipient of input.recipients) {
      if (recipient.kind === 'worker') {
        if (!recipient.nodeId || !run.nodes[recipient.nodeId]) {
          throw new GraphRunConflictError('worker recipient is not a run member')
        }
      } else if (recipient.nodeId) {
        throw new GraphRunConflictError('non-worker recipient cannot claim node identity')
      }
      if (
        input.sender.kind === 'worker' &&
        recipient.kind === 'worker' &&
        input.sender.nodeId !== recipient.nodeId
      ) {
        const authorized = run.plans.at(-1)?.edges.some((edge) =>
          edge.kind === 'message' &&
          edge.from === input.sender.nodeId &&
          edge.to === recipient.nodeId &&
          (input.type === 'help' || input.type === 'system'
            ? false
            : new Set<string>(edge.allowedTypes).has(input.type)))
        if (!authorized) {
          throw new GraphRunConflictError(
            `message edge does not authorize ${input.sender.nodeId} -> ${recipient.nodeId}`
          )
        }
      }
    }
    const knownArtifacts = new Set(run.artifacts.map((artifact) => artifact.artifactId))
    for (const artifact of input.artifactRefs) {
      if (!knownArtifacts.has(artifact.artifactId)) {
        throw new GraphRunConflictError(`message references unauthorized artifact ${artifact.artifactId}`)
      }
    }
  }

  private async requireRun(runId: string): Promise<GraphRunV1> {
    const run = await this.options.store.get(runId)
    if (!run) throw new GraphRunNotFoundError(runId)
    return run
  }
}

function sameRecipient(
  left: GraphMessageV1['recipients'][number],
  right: GraphMessageV1['recipients'][number]
): boolean {
  return left.kind === right.kind && left.nodeId === right.nodeId
}

function sameMessageInput(
  existing: GraphMessageV1,
  input: GraphMailboxSendInput
): boolean {
  return existing.runId === input.runId &&
    JSON.stringify(existing.sender) === JSON.stringify(input.sender) &&
    JSON.stringify(existing.recipients) === JSON.stringify(input.recipients) &&
    existing.type === input.type &&
    existing.priority === input.priority &&
    existing.summary === input.summary &&
    existing.details === input.details &&
    existing.correlationId === input.correlationId &&
    existing.replyRequired === input.replyRequired &&
    JSON.stringify(existing.artifactRefs) === JSON.stringify(input.artifactRefs)
}
