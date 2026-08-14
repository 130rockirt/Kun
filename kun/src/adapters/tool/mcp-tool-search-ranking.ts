import type { McpSearchConfig } from '../../contracts/capabilities.js'
import type { McpSearchCatalogRecord } from './mcp-tool-search.js'

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'into',
  'about',
  'there',
  'their',
  'will',
  'would',
  'could',
  'should',
  'have',
  'has',
  'are',
  'was',
  'were',
  'been',
  'not',
  'but',
  'you',
  'your',
  'our',
  'can',
  'then',
  'when',
  'what',
  'how'
])

const ACTION_SYNONYMS: Record<string, string[]> = {
  search: ['find', 'lookup', 'query', '查', '搜索', '检索', '找'],
  find: ['search', 'lookup', 'query', '查找'],
  list: ['show', 'enumerate', '列出', '列表'],
  get: ['read', 'fetch', 'retrieve', 'describe', '获取', '读取', '查看'],
  create: ['add', 'new', 'make', '创建', '新增'],
  update: ['edit', 'modify', 'set', 'change', '更新', '修改'],
  delete: ['remove', 'destroy', '删除', '移除'],
  send: ['post', 'publish', 'reply', 'comment', '发送', '回复', '评论']
}

type IndexedTool = {
  record: McpSearchCatalogRecord
  tokens: string[]
  termFrequency: Map<string, number>
  exactTokens: Set<string>
  actionTokens: Set<string>
  paramTokens: Set<string>
}

type McpSearchIndex = {
  tools: IndexedTool[]
  documentFrequency: Map<string, number>
  averageLength: number
}

type QueryModel = {
  text: string
  terms: string[]
  weights: Map<string, number>
}

type SearchResult = {
  record: McpSearchCatalogRecord
  score: number
  keywords: string[]
}

export function tokenizeMcpSearchText(text = ''): string[] {
  const source = normalizeLower(text)
  const tokens: string[] = []

  const latinTerms = source.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? []
  for (const term of latinTerms) {
    for (const part of term.split(/[_-]+/)) {
      if (tokenAllowed(part)) tokens.push(part)
    }
    if (tokenAllowed(term)) tokens.push(term)
  }

  const hanSegments = source.match(/\p{Script=Han}+/gu) ?? []
  for (const segment of hanSegments) {
    const chars = [...segment].slice(0, 80)
    if (chars.length === 1) {
      tokens.push(chars[0])
      continue
    }
    for (let size = 2; size <= Math.min(4, chars.length); size += 1) {
      for (let index = 0; index <= chars.length - size; index += 1) {
        tokens.push(chars.slice(index, index + size).join(''))
      }
    }
  }

  return tokens
}

export function searchRecords(
  records: McpSearchCatalogRecord[],
  queryText: string,
  topK: number,
  config: McpSearchConfig
): SearchResult[] {
  const query = buildQuery(queryText)
  if (query.terms.length === 0) return []
  const index = buildIndex(records)
  return index.tools
    .map((tool) => {
      const keyword = keywordScore(tool, query)
      return {
        record: tool.record,
        score: bm25Score(tool, index, query, config) + keyword.score,
        keywords: keyword.keywords
      }
    })
    .filter((result) => result.score >= config.minScore && result.keywords.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

function buildIndex(records: McpSearchCatalogRecord[]): McpSearchIndex {
  const tools = records.map(indexRecord)
  const documentFrequency = new Map<string, number>()
  let tokenCount = 0
  for (const tool of tools) {
    tokenCount += tool.tokens.length
    for (const token of new Set(tool.tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    }
  }
  return {
    tools,
    documentFrequency,
    averageLength: tools.length > 0 ? tokenCount / tools.length : 1
  }
}

function indexRecord(record: McpSearchCatalogRecord): IndexedTool {
  const descriptor = record.descriptor
  const inputSchema = descriptor.inputSchema ?? { type: 'object' }
  const paramText = extractSchemaText(inputSchema)
  const exact = [
    record.serverId,
    descriptor.name,
    descriptor.title,
    descriptor.annotations?.title,
    record.normalizedName,
    record.toolId
  ].filter(Boolean).join(' ')
  const action = actionWords(descriptor.name)
  const semantic = [descriptor.description, descriptor.title, descriptor.annotations?.title].filter(Boolean).join(' ')
  const risk = [
    descriptor.annotations?.readOnlyHint ? 'read read-only readonly safe' : '',
    descriptor.annotations?.destructiveHint ? 'delete destructive dangerous high-risk' : '',
    descriptor.annotations?.openWorldHint ? 'external network open-world' : ''
  ].join(' ')
  const server = [record.serverId, record.server.transport, record.server.trustScope].join(' ')
  const exactTokens = new Set(tokenizeMcpSearchText(exact))
  const actionTokens = new Set(tokenizeMcpSearchText(action))
  const paramTokens = new Set(tokenizeMcpSearchText(paramText))
  const tokens = [
    ...repeatTokens(exactTokens, 5),
    ...repeatTokens(actionTokens, 3),
    ...repeatTokens(paramTokens, 2),
    ...tokenizeMcpSearchText(semantic),
    ...tokenizeMcpSearchText(server),
    ...tokenizeMcpSearchText(risk)
  ]
  return {
    record,
    tokens,
    termFrequency: termFrequency(tokens),
    exactTokens,
    actionTokens,
    paramTokens
  }
}

function buildQuery(text: string): QueryModel {
  const weights = new Map<string, number>()
  for (const token of expandQueryTokens(tokenizeMcpSearchText(text))) {
    weights.set(token, (weights.get(token) ?? 0) + 1)
  }
  return {
    text,
    terms: [...weights.keys()].slice(0, 48),
    weights
  }
}

function expandQueryTokens(tokens: string[]): string[] {
  const out = [...tokens]
  for (const token of tokens) {
    const synonyms = ACTION_SYNONYMS[token]
    if (synonyms) out.push(...synonyms)
    for (const [action, values] of Object.entries(ACTION_SYNONYMS)) {
      if (values.includes(token)) out.push(action)
    }
  }
  return out
}

function bm25Score(
  tool: IndexedTool,
  index: McpSearchIndex,
  query: QueryModel,
  config: McpSearchConfig
): number {
  const totalDocs = Math.max(index.tools.length, 1)
  const averageLength = Math.max(index.averageLength, 1)
  const k1 = config.bm25.k1
  const b = config.bm25.b
  let score = 0
  for (const term of query.terms) {
    const tf = tool.termFrequency.get(term) ?? 0
    if (!tf) continue
    const df = index.documentFrequency.get(term) ?? 0
    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5))
    const normalized = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (tool.tokens.length / averageLength)))
    const weight = query.weights.get(term) ?? 1
    score += weight * idf * normalized
  }
  return score
}

function keywordScore(tool: IndexedTool, query: QueryModel): { score: number; keywords: string[] } {
  let score = 0
  const keywords: string[] = []
  for (const term of query.terms) {
    if (!tool.termFrequency.has(term)) continue
    keywords.push(term)
    const weight = query.weights.get(term) ?? 1
    if (tool.exactTokens.has(term)) score += 0.8 * weight
    if (tool.actionTokens.has(term)) score += 0.45 * weight
    if (tool.paramTokens.has(term)) score += 0.35 * weight
  }
  if (keywords.length > 0) score += Math.sqrt(keywords.length) * 0.2
  return { score, keywords: keywords.slice(0, 10) }
}

export function formatSearchResult(result: SearchResult): Record<string, unknown> {
  const descriptor = result.record.descriptor
  return {
    toolId: result.record.toolId,
    serverId: result.record.serverId,
    toolName: descriptor.name,
    title: descriptor.title ?? descriptor.annotations?.title,
    description: descriptor.description ?? '',
    score: Number(result.score.toFixed(3)),
    matchedKeywords: result.keywords,
    inputSummary: summarizeSchema(descriptor.inputSchema),
    policy: result.record.policy,
    risk: {
      readOnly: descriptor.annotations?.readOnlyHint === true,
      destructive: descriptor.annotations?.destructiveHint === true,
      openWorld: descriptor.annotations?.openWorldHint === true
    }
  }
}

export function describeRecord(record: McpSearchCatalogRecord): Record<string, unknown> {
  const descriptor = record.descriptor
  return {
    toolId: record.toolId,
    serverId: record.serverId,
    toolName: descriptor.name,
    normalizedName: record.normalizedName,
    title: descriptor.title ?? descriptor.annotations?.title,
    description: descriptor.description ?? '',
    inputSchema: descriptor.inputSchema ?? { type: 'object' },
    ...(descriptor.outputSchema ? { outputSchema: descriptor.outputSchema } : {}),
    ...(descriptor.annotations ? { annotations: descriptor.annotations } : {}),
    ...(descriptor.execution ? { execution: descriptor.execution } : {}),
    ...(descriptor.icons ? { icons: descriptor.icons } : {}),
    ...(descriptor._meta ? { meta: descriptor._meta } : {}),
    policy: record.policy
  }
}

function extractSchemaText(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return ''
  const pieces: string[] = []
  const visit = (value: unknown, keyHint = ''): void => {
    if (!value || typeof value !== 'object') return
    const obj = value as Record<string, unknown>
    if (keyHint) pieces.push(keyHint)
    if (typeof obj.title === 'string') pieces.push(obj.title)
    if (typeof obj.description === 'string') pieces.push(obj.description)
    if (Array.isArray(obj.enum)) pieces.push(obj.enum.filter((item) => typeof item === 'string').join(' '))
    const properties = obj.properties
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      for (const [key, child] of Object.entries(properties)) {
        pieces.push(key)
        visit(child, key)
      }
    }
  }
  visit(schema)
  return pieces.join(' ')
}

function summarizeSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return { required: [], parameters: [] }
  const obj = schema as { properties?: Record<string, unknown>; required?: unknown }
  const properties = obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties)
    ? obj.properties
    : {}
  return {
    required: Array.isArray(obj.required) ? obj.required.filter((item) => typeof item === 'string') : [],
    parameters: Object.keys(properties).slice(0, 12)
  }
}

function actionWords(name: string): string {
  const tokens = tokenizeMcpSearchText(name.replace(/[._:/-]+/g, ' '))
  const expanded = expandQueryTokens(tokens)
  return expanded.join(' ')
}

function repeatTokens(tokens: Iterable<string>, count: number): string[] {
  const out: string[] = []
  for (const token of tokens) {
    for (let i = 0; i < count; i += 1) out.push(token)
  }
  return out
}

function termFrequency(tokens: string[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const token of tokens) {
    map.set(token, (map.get(token) ?? 0) + 1)
  }
  return map
}

function normalizeLower(text = ''): string {
  return String(text || '').normalize('NFKC').toLowerCase()
}

function tokenAllowed(token: string): boolean {
  if (!token || STOP_WORDS.has(token)) return false
  if (/^\d+$/.test(token)) return false
  return token.length >= 2
}
