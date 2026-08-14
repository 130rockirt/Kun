import type { LocalTool } from '../adapters/tool/local-tool-host.js'
import type { ToolHostContext } from '../ports/tool-host.js'
import type { KnowledgeBaseService } from './knowledge-base-service.js'

const EFFECTS = {
  network: false,
  externalWrite: false,
  processExecution: true,
  guiAutomation: false
} as const

const SHOULD_ADVERTISE = (context: ToolHostContext): boolean =>
  Boolean(context.knowledgeBases?.length)

export function buildKnowledgeLocalTools(service: KnowledgeBaseService): LocalTool[] {
  return [catalogTool(service), browseTool(service), readTool(service)]
}

export function buildKnowledgeToolProvider(service: KnowledgeBaseService) {
  return {
    id: 'knowledge',
    kind: 'built-in' as const,
    enabled: true,
    available: true,
    effects: EFFECTS,
    tools: buildKnowledgeLocalTools(service)
  }
}

function catalogTool(service: KnowledgeBaseService): LocalTool {
  return {
    name: 'knowledge_catalog',
    description:
      'List the read-only knowledge bases mounted on this thread and their root nodes. ' +
      'Optionally rank relevant structural nodes with fast vectorless text matching. ' +
      'Start here before browsing or reading evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          maxLength: 2_000,
          description: 'Optional topic used to rank likely nodes without embeddings.'
        }
      },
      additionalProperties: false
    },
    toolKind: 'tool_call',
    sideEffect: 'read-only',
    effects: EFFECTS,
    policy: 'auto',
    shouldAdvertise: SHOULD_ADVERTISE,
    async execute(args, context) {
      const query = typeof args.query === 'string' ? args.query.trim().slice(0, 2_000) : undefined
      return { output: await service.catalog(context.threadId, query) }
    }
  }
}

function browseTool(service: KnowledgeBaseService): LocalTool {
  return {
    name: 'knowledge_browse',
    description:
      'Browse one node in a mounted knowledge base structural tree. Returns bounded children, ' +
      'summaries, and document-reference graph edges. Pass a child node id to drill down.',
    inputSchema: {
      type: 'object',
      properties: {
        mount_id: { type: 'string', minLength: 1, maxLength: 128 },
        node_id: { type: 'string', minLength: 1, maxLength: 128 },
        cursor: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 50 }
      },
      required: ['mount_id'],
      additionalProperties: false
    },
    toolKind: 'tool_call',
    sideEffect: 'read-only',
    effects: EFFECTS,
    policy: 'auto',
    shouldAdvertise: SHOULD_ADVERTISE,
    async execute(args, context) {
      return {
        output: await service.browse(
          context.threadId,
          stringArg(args, 'mount_id'),
          optionalStringArg(args, 'node_id'),
          integerArg(args, 'cursor', 0),
          integerArg(args, 'limit', 20)
        )
      }
    }
  }
}

function readTool(service: KnowledgeBaseService): LocalTool {
  return {
    name: 'knowledge_read',
    description:
      'Read exact evidence for up to six text, PDF, Word paragraph, PowerPoint slide, or spreadsheet-range nodes ' +
      'from a knowledge base mounted on this thread. Returns source-relative citations, source format, SHA-256, and precise locations.',
    inputSchema: {
      type: 'object',
      properties: {
        mount_id: { type: 'string', minLength: 1, maxLength: 128 },
        node_ids: {
          type: 'array',
          minItems: 1,
          maxItems: 6,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 128 }
        }
      },
      required: ['mount_id', 'node_ids'],
      additionalProperties: false
    },
    toolKind: 'tool_call',
    sideEffect: 'read-only',
    effects: EFFECTS,
    policy: 'auto',
    shouldAdvertise: SHOULD_ADVERTISE,
    async execute(args, context) {
      const nodeIds = Array.isArray(args.node_ids)
        ? args.node_ids.filter((value): value is string => typeof value === 'string')
        : []
      return {
        output: await service.read(context.threadId, stringArg(args, 'mount_id'), nodeIds)
      }
    }
  }
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string`)
  return value.trim()
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function integerArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
}
