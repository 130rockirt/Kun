import { createHash } from 'node:crypto'
import type { GraphRunV1 } from '../../contracts/index.js'
import { GRAPH_WORKER_REPORT_TOOL_NAME } from '../../graph/graph-tool-boundary.js'
import type {
  GraphMailbox,
  GraphRunStore,
  GraphWorkerSessionRegistry
} from '../../graph/index.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { LocalToolHost, type LocalTool } from './local-tool-host.js'

type ReportType = 'progress' | 'finding' | 'question' | 'risk' | 'result'

export function buildGraphReportToParentTool(options: {
  store: GraphRunStore
  mailbox: GraphMailbox
  workerSessions: GraphWorkerSessionRegistry
  shouldAdvertise: (context: ToolHostContext) => boolean
  signalSupervision?: (input: {
    runId: string
    reason: 'worker_report'
    nodeIds: string[]
    digest: string
  }) => Promise<void> | void
  nextId: (prefix: string) => string
}): LocalTool {
  return LocalToolHost.defineTool({
    name: GRAPH_WORKER_REPORT_TOOL_NAME,
    description:
      'Proactively report to your owning main agent. Use progress for a useful status milestone, ' +
      'finding for reusable discoveries, question when Lead guidance is needed, risk for cross-task ' +
      'concerns, and result for an early result worth reviewing. The host infers your run, node, ' +
      'attempt, and recipient; reports never accept work or advance the graph.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['progress', 'finding', 'question', 'risk', 'result']
        },
        summary: { type: 'string', minLength: 1, maxLength: 4_096 },
        details: { type: 'string', maxLength: 32_768 },
        evidence: {
          type: 'array',
          maxItems: 32,
          items: { type: 'string', maxLength: 4_096 }
        }
      },
      required: ['type', 'summary'],
      additionalProperties: false
    },
    policy: 'auto',
    toolKind: 'tool_call',
    sideEffect: 'unknown',
    shouldAdvertise: options.shouldAdvertise,
    execute: async (args, context) => {
      try {
        const reportType = reportTypeArg(args.type)
        const summary = stringArg(args.summary)
        if (!summary) throw new Error('summary is required')
        const located = await authorizedBoundWorker(
          options.store,
          options.workerSessions,
          context
        )
        const details = stringArg(args.details)
        const evidence = stringArray(args.evidence, 32)
        const reportDetails = [
          details,
          evidence.length
            ? `Evidence:\n${evidence.map((item) => `- ${item}`).join('\n')}`
            : ''
        ].filter(Boolean).join('\n\n').slice(0, 32_768)
        const reportId = options.nextId('graph_report')
        const sent = await options.mailbox.send({
          id: reportId,
          runId: located.run.id,
          sender: {
            kind: 'worker',
            nodeId: located.nodeId,
            attemptId: located.attemptId
          },
          recipients: [{ kind: 'lead' }],
          type: reportType,
          priority: reportPriority(reportType),
          summary: summary.slice(0, 4_096),
          ...(reportDetails ? { details: reportDetails } : {}),
          artifactRefs: [],
          replyRequired: reportType === 'question'
        }, {
          commandId: options.nextId('graph_worker_report'),
          idempotencyKey:
            `worker-report:${located.attemptId}:${hash(JSON.stringify({
              reportType,
              summary,
              details,
              evidence
            })).slice(0, 24)}`
        })
        const material = reportType !== 'progress'
        if (material) {
          await options.signalSupervision?.({
            runId: located.run.id,
            reason: 'worker_report',
            nodeIds: [located.nodeId],
            digest: `${reportType}: ${summary}`
          })
        }
        return {
          output: {
            accepted: true,
            reportId: sent.message.id,
            type: reportType,
            leadNotified: material,
            workflowStateChanged: false,
            runSeq: sent.run.lastEventSeq
          }
        }
      } catch (error) {
        return {
          output: { error: errorMessage(error) },
          isError: true
        }
      }
    }
  })
}

async function authorizedBoundWorker(
  store: GraphRunStore,
  workerSessions: GraphWorkerSessionRegistry,
  context: ToolHostContext
): Promise<{ run: GraphRunV1; nodeId: string; attemptId: string }> {
  const binding = workerSessions.get(context.threadId)
  if (!binding) {
    throw new Error('current child session is not bound to an active Graph attempt')
  }
  const run = await store.get(binding.runId)
  if (!run) throw new Error(`GraphRun not found: ${binding.runId}`)
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    throw new Error(`GraphRun ${run.id} is terminal`)
  }
  const projection = run.nodes[binding.nodeId]
  const attempt = projection?.attempts.find((candidate) =>
    candidate.id === binding.attemptId
  )
  if (!projection || !attempt) {
    throw new Error('bound Graph attempt no longer exists')
  }
  if (projection.attempts.at(-1)?.id !== attempt.id) {
    throw new Error('bound Graph attempt is stale')
  }
  if (attempt.childThreadId && attempt.childThreadId !== context.threadId) {
    throw new Error('bound Graph attempt belongs to a different child session')
  }
  if (!['queued', 'running', 'waiting'].includes(attempt.status)) {
    throw new Error(`Graph worker attempt is not active: ${attempt.status}`)
  }
  return { run, nodeId: binding.nodeId, attemptId: binding.attemptId }
}

function reportTypeArg(value: unknown): ReportType {
  if (
    value === 'progress' ||
    value === 'finding' ||
    value === 'question' ||
    value === 'risk' ||
    value === 'result'
  ) return value
  throw new Error('type must be progress, finding, question, risk, or result')
}

function reportPriority(
  type: ReportType
): 'low' | 'normal' | 'high' | 'blocking' {
  if (type === 'progress') return 'low'
  if (type === 'question') return 'blocking'
  if (type === 'risk' || type === 'result') return 'high'
  return 'normal'
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stringArray(value: unknown, maxItems: number): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().slice(0, 4_096))
        .filter(Boolean)
        .slice(0, maxItems)
    : []
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_048)
}
