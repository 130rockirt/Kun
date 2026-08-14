const DEFAULT_MAX_SCHEMA_DEPTH = 16
const DEFAULT_MAX_SCHEMA_NODES = 2_000
const OMITTED_EXTERNAL_REF_DESCRIPTION = 'External schema reference omitted by Kun.'
const OMITTED_RECURSIVE_DESCRIPTION = 'Recursive schema branch omitted by Kun.'
const OMITTED_DEPTH_DESCRIPTION = 'Schema branch exceeded Kun\'s model-advertisement depth limit.'
const OMITTED_SIZE_DESCRIPTION = 'Schema exceeded Kun\'s model-advertisement size limit.'

export type McpSchemaProjectionOptions = {
  maxDepth?: number
  maxNodes?: number
}

/**
 * Produce a bounded JSON-compatible clone for model tool advertisement.
 * The original MCP schema remains untouched for SDK validation and describe.
 */
export function projectMcpSchemaForModel(
  schema: Record<string, unknown> | undefined,
  options: McpSchemaProjectionOptions = {}
): Record<string, unknown> {
  if (!schema) return { type: 'object' }
  const state = {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_SCHEMA_DEPTH,
    maxNodes: options.maxNodes ?? DEFAULT_MAX_SCHEMA_NODES,
    nodes: 0,
    ancestors: new WeakSet<object>()
  }
  const projected = projectValue(schema, 0, state)
  return isRecord(projected) ? projected : { type: 'object' }
}

function projectValue(
  value: unknown,
  depth: number,
  state: {
    maxDepth: number
    maxNodes: number
    nodes: number
    ancestors: WeakSet<object>
  }
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'object') return undefined
  state.nodes += 1
  if (state.nodes > state.maxNodes) return omittedSchema(OMITTED_SIZE_DESCRIPTION)
  if (depth >= state.maxDepth) return omittedSchema(OMITTED_DEPTH_DESCRIPTION)
  if (state.ancestors.has(value)) return omittedSchema(OMITTED_RECURSIVE_DESCRIPTION)
  state.ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.flatMap((entry) => {
        const projected = projectValue(entry, depth + 1, state)
        return projected === undefined ? [] : [projected]
      })
    }
    const record = value as Record<string, unknown>
    const ref = typeof record.$ref === 'string' ? record.$ref : undefined
    if (ref && !ref.startsWith('#/')) return omittedSchema(OMITTED_EXTERNAL_REF_DESCRIPTION)
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(record)) {
      if (key === '$schema' || key === '$id' || key.startsWith('x-')) continue
      const projected = projectValue(entry, depth + 1, state)
      if (projected !== undefined) result[key] = projected
    }
    return result
  } finally {
    state.ancestors.delete(value)
  }
}

function omittedSchema(description: string): Record<string, unknown> {
  return { description }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
