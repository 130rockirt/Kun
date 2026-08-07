import type { ModelRequestTraceRecord } from './model-request-traces'
import {
  resolveToolProvenance,
  type ToolProvenance
} from './agent-tool-provenance'

export type AgentPerspectiveEventKind = 'llm_request' | 'tool_call' | 'title_generation'

export type SemanticPrompt = {
  id: string
  source: 'instructions' | 'system' | 'message'
  text: string
}

export type SemanticSkill = {
  id: string
  name: string
  description: string
  path?: string
  active: boolean
}

export type SemanticToolDefinition = {
  name: string
  description: string
  inputSchema?: Record<string, unknown>
  provenance: ToolProvenance
}

export type SemanticMessage = {
  id: string
  role: string
  text: string
  callId?: string
  name?: string
  kind?: string
}

export type SemanticParameter = {
  name: string
  value: unknown
}

export type SemanticRequest = {
  body: Record<string, unknown> | null
  model: string
  prompts: SemanticPrompt[]
  skills: SemanticSkill[]
  tools: SemanticToolDefinition[]
  messages: SemanticMessage[]
  parameters: SemanticParameter[]
  parseError?: string
}

export type AgentLlmRequestEvent = {
  id: string
  kind: 'llm_request'
  startedAt: string
  record: ModelRequestTraceRecord
  semantic: SemanticRequest
}

export type AgentTitleGenerationEvent = {
  id: string
  kind: 'title_generation'
  startedAt: string
  record: ModelRequestTraceRecord
  semantic: SemanticRequest
  title: string
}

export type AgentToolCallEvent = {
  id: string
  kind: 'tool_call'
  startedAt: string
  record: ModelRequestTraceRecord
  callId: string
  toolName: string
  arguments: Record<string, unknown>
  provenance: ToolProvenance
  result?: SemanticMessage
}

export type AgentPerspectiveEvent =
  | AgentLlmRequestEvent
  | AgentTitleGenerationEvent
  | AgentToolCallEvent

export type AgentPerspectiveRound = {
  id: string
  turnId: string | null
  system: boolean
  events: AgentPerspectiveEvent[]
  startedAt: string
  latestAt: string
}

export const AGENT_PERSPECTIVE_SYSTEM_ROUND_ID = '__agent_perspective_system_tasks__'

const TITLE_SYSTEM_SIGNATURE = 'You generate a concise title for a chat conversation.'
const TITLE_TURN_SUFFIX = '_title'
const STRUCTURAL_KEYS = new Set([
  'model', 'messages', 'input', 'instructions', 'system', 'tools'
])
const GEMINI_STRUCTURAL_KEYS = new Set([
  'contents', 'systemInstruction', 'thoughtSignature', 'tools'
])

export function projectAgentPerspectiveEvents(
  records: readonly ModelRequestTraceRecord[]
): AgentPerspectiveEvent[] {
  const ordered = [...records].sort(oldestRecordFirst)
  const semanticByRecord = new Map(ordered.map((record) => [record.id, parseSemanticRequest(record)]))
  const toolResults = collectToolResults(ordered, [...semanticByRecord.values()])
  const events: AgentPerspectiveEvent[] = []

  for (const record of ordered) {
    const semantic = semanticByRecord.get(record.id) ?? parseSemanticRequest(record)
    if (isTitleGenerationRequest(record, semantic)) {
      events.push({
        id: record.id,
        kind: 'title_generation',
        startedAt: record.startedAt,
        record,
        semantic,
        title: record.decoded?.text.trim() ?? ''
      })
      continue
    }

    events.push({
      id: record.id,
      kind: 'llm_request',
      startedAt: record.startedAt,
      record,
      semantic
    })
    for (const [index, call] of (record.decoded?.toolCalls ?? []).entries()) {
      events.push({
        id: `tool:${record.id}:${call.callId || index}`,
        kind: 'tool_call',
        startedAt: record.finishedAt ?? record.startedAt,
        record,
        callId: call.callId,
        toolName: call.toolName,
        arguments: call.arguments,
        provenance: resolveToolProvenance(call.toolName, record.toolCatalog),
        ...(toolResults.get(call.callId) ? { result: toolResults.get(call.callId) } : {})
      })
    }
  }
  return events
}

export function groupAgentPerspectiveEvents(
  events: readonly AgentPerspectiveEvent[]
): AgentPerspectiveRound[] {
  const grouped = new Map<string, AgentPerspectiveEvent[]>()
  for (const event of events) {
    const key = event.kind === 'title_generation'
      ? AGENT_PERSPECTIVE_SYSTEM_ROUND_ID
      : event.record.turnId
    const roundEvents = grouped.get(key) ?? []
    roundEvents.push(event)
    grouped.set(key, roundEvents)
  }

  return [...grouped.entries()]
    .map(([id, roundEvents]) => {
      const ordered = [...roundEvents].sort(newestEventFirst)
      const system = id === AGENT_PERSPECTIVE_SYSTEM_ROUND_ID
      return {
        id,
        turnId: system ? null : id,
        system,
        events: ordered,
        startedAt: oldestEventAt(ordered),
        latestAt: ordered[0]?.startedAt ?? ''
      }
    })
    .sort((left, right) => {
      if (left.system !== right.system) return left.system ? 1 : -1
      return compareTimestamp(right.latestAt, left.latestAt) || right.id.localeCompare(left.id)
    })
}

export function parseSemanticRequest(record: ModelRequestTraceRecord): SemanticRequest {
  if (!record.request) {
    return {
      body: null,
      model: record.model,
      prompts: [],
      skills: [],
      tools: [],
      messages: [],
      parameters: [],
      parseError: record.status === 'not_started'
        ? 'no request was attempted'
        : 'request payload unavailable'
    }
  }
  let body: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(record.request.body.text)
    if (!isRecord(value)) throw new Error('request body is not an object')
    body = value
  } catch (error) {
    return {
      body: null,
      model: record.model,
      prompts: [],
      skills: [],
      tools: [],
      messages: [],
      parameters: [],
      parseError: error instanceof Error ? error.message : String(error)
    }
  }

  const geminiRequest = geminiCodeAssistRequest(record, body)
  const prompts = geminiRequest ? parseGeminiPrompts(geminiRequest) : parsePrompts(body)
  const messages = geminiRequest ? parseGeminiMessages(geminiRequest) : parseMessages(body)
  return {
    body,
    model: stringValue(body.model) || record.model,
    prompts,
    skills: parseSkills(prompts),
    tools: geminiRequest
      ? parseGeminiToolDefinitions(geminiRequest, record.toolCatalog)
      : parseToolDefinitions(body, record.toolCatalog),
    messages,
    parameters: geminiRequest
      ? parseGeminiParameters(body, geminiRequest)
      : Object.entries(body)
        .filter(([key]) => !STRUCTURAL_KEYS.has(key))
        .map(([name, value]) => ({ name, value }))
  }
}

function newestEventFirst(left: AgentPerspectiveEvent, right: AgentPerspectiveEvent): number {
  return compareTimestamp(right.startedAt, left.startedAt) ||
    right.record.sequence - left.record.sequence ||
    right.id.localeCompare(left.id)
}

function oldestEventAt(events: readonly AgentPerspectiveEvent[]): string {
  let oldest = events[0]?.startedAt ?? ''
  for (const event of events) {
    if (compareTimestamp(event.startedAt, oldest) < 0) oldest = event.startedAt
  }
  return oldest
}

function compareTimestamp(left: string, right: string): number {
  const leftMs = Date.parse(left)
  const rightMs = Date.parse(right)
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) return leftMs - rightMs
  return left.localeCompare(right)
}

export function isTitleGenerationRequest(
  record: ModelRequestTraceRecord,
  semantic = parseSemanticRequest(record)
): boolean {
  if (record.turnId.endsWith(TITLE_TURN_SUFFIX)) return true
  return semantic.prompts.some((prompt) => prompt.text.includes(TITLE_SYSTEM_SIGNATURE)) ||
    semantic.messages.some((message) => message.text.includes(TITLE_SYSTEM_SIGNATURE))
}

export function usageNumber(
  usage: Record<string, unknown> | undefined,
  key: string
): number | undefined {
  const value = usage?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parsePrompts(body: Record<string, unknown>): SemanticPrompt[] {
  const prompts: SemanticPrompt[] = []
  pushPrompt(prompts, 'instructions', 'instructions', body.instructions)
  pushPrompt(prompts, 'system', 'system', body.system)
  for (const key of ['messages', 'input'] as const) {
    const entries = body[key]
    if (!Array.isArray(entries)) continue
    entries.forEach((entry, index) => {
      if (!isRecord(entry) || !['system', 'developer'].includes(stringValue(entry.role))) return
      const text = contentText(entry.content)
      if (text) prompts.push({ id: `${key}-${index}`, source: 'message', text })
    })
  }
  return prompts
}

function geminiCodeAssistRequest(
  record: ModelRequestTraceRecord,
  body: Record<string, unknown>
): Record<string, unknown> | null {
  if (record.endpointFormat !== 'gemini-cli-api') return null
  return isRecord(body.request) ? body.request : null
}

function parseGeminiPrompts(request: Record<string, unknown>): SemanticPrompt[] {
  const instruction = request.systemInstruction
  if (!isRecord(instruction)) return []
  const text = geminiPartsText(instruction.parts)
  return text
    ? [{ id: 'systemInstruction', source: 'system', text }]
    : []
}

function pushPrompt(
  prompts: SemanticPrompt[],
  id: string,
  source: SemanticPrompt['source'],
  value: unknown
): void {
  const text = contentText(value)
  if (text) prompts.push({ id, source, text })
}

function parseMessages(body: Record<string, unknown>): SemanticMessage[] {
  const source = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.input)
      ? body.input
      : typeof body.input === 'string'
        ? [{ role: 'user', content: body.input }]
        : []
  const messages: SemanticMessage[] = []
  source.forEach((entry, index) => {
    if (typeof entry === 'string') {
      messages.push({ id: `message-${index}`, role: 'user', text: entry })
      return
    }
    if (!isRecord(entry)) return
    const type = stringValue(entry.type)
    const role = stringValue(entry.role) || roleForItemType(type)
    if (['system', 'developer'].includes(role)) return
    const text = contentText(entry.content ?? entry.output ?? entry.input ?? entry.arguments)
    const nestedToolResults = parseNestedToolResults(entry.content, index)
    const contentOnlyContainsToolResults = Array.isArray(entry.content) &&
      entry.content.length > 0 && entry.content.every((block) => (
        isRecord(block) && stringValue(block.type) === 'tool_result'
      ))
    if (!contentOnlyContainsToolResults) {
      messages.push({
        id: `message-${index}`,
        role: role || 'unknown',
        text,
        ...(stringValue(entry.call_id ?? entry.tool_call_id) ? {
          callId: stringValue(entry.call_id ?? entry.tool_call_id)
        } : {}),
        ...(stringValue(entry.name) ? { name: stringValue(entry.name) } : {}),
        ...(type ? { kind: type } : {})
      })
    }
    nestedToolResults.forEach((message) => messages.push(message))
  })
  return messages
}

function parseGeminiMessages(request: Record<string, unknown>): SemanticMessage[] {
  if (!Array.isArray(request.contents)) return []
  const messages: SemanticMessage[] = []
  request.contents.forEach((content, contentIndex) => {
    if (!isRecord(content) || !Array.isArray(content.parts)) return
    const role = stringValue(content.role) === 'model'
      ? 'assistant'
      : stringValue(content.role) || 'unknown'
    let textParts: string[] = []
    let textPartStart = 0
    const flushText = (partIndex: number): void => {
      if (!textParts.length) return
      messages.push({
        id: `gemini-content-${contentIndex}-part-${textPartStart}`,
        role,
        text: textParts.join('\n')
      })
      textParts = []
      textPartStart = partIndex + 1
    }

    content.parts.forEach((part, partIndex) => {
      if (!isRecord(part)) return
      const functionCall = isRecord(part.functionCall) ? part.functionCall : null
      const functionResponse = isRecord(part.functionResponse) ? part.functionResponse : null
      if (functionCall) {
        flushText(partIndex)
        const callId = stringValue(functionCall.id)
        const name = stringValue(functionCall.name)
        messages.push({
          id: `gemini-content-${contentIndex}-function-call-${partIndex}`,
          role: 'assistant',
          text: contentText(functionCall.args),
          ...(callId ? { callId } : {}),
          ...(name ? { name } : {}),
          kind: 'function_call'
        })
        return
      }
      if (functionResponse) {
        flushText(partIndex)
        const callId = stringValue(functionResponse.id)
        const name = stringValue(functionResponse.name)
        messages.push({
          id: `gemini-content-${contentIndex}-function-response-${partIndex}`,
          role: 'tool',
          text: contentText(functionResponse.response),
          ...(callId ? { callId } : {}),
          ...(name ? { name } : {}),
          kind: 'function_call_output'
        })
        return
      }
      const text = geminiPartText(part)
      if (text) textParts.push(text)
    })
    flushText(content.parts.length)
  })
  return messages
}

function geminiPartsText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => isRecord(part) ? geminiPartText(part) : '')
    .filter(Boolean)
    .join('\n')
}

function geminiPartText(part: Record<string, unknown>): string {
  const text = stringValue(part.text)
  if (text) return text
  if (isRecord(part.inlineData)) {
    return `[inline data: ${stringValue(part.inlineData.mimeType) || 'unknown MIME type'}]`
  }
  if (isRecord(part.fileData)) {
    return `[file data: ${stringValue(part.fileData.mimeType) || 'unknown MIME type'}]`
  }
  return ''
}

function parseNestedToolResults(value: unknown, parentIndex: number): SemanticMessage[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((block, index) => {
    if (!isRecord(block) || stringValue(block.type) !== 'tool_result') return []
    return [{
      id: `message-${parentIndex}-tool-result-${index}`,
      role: 'tool',
      text: contentText(block.content),
      callId: stringValue(block.tool_use_id ?? block.call_id),
      kind: 'tool_result'
    }]
  })
}

function roleForItemType(type: string): string {
  if (type === 'function_call_output' || type === 'tool_result') return 'tool'
  if (type === 'function_call' || type === 'tool_use') return 'assistant'
  return ''
}

function collectToolResults(
  records: readonly ModelRequestTraceRecord[],
  requests: readonly SemanticRequest[]
): Map<string, SemanticMessage> {
  const results = new Map<string, SemanticMessage>()
  for (const record of records) {
    for (const result of record.decoded?.toolResults ?? []) {
      results.set(result.callId, {
        id: `trace-tool-result-${record.id}-${result.callId}`,
        role: 'tool',
        text: result.output,
        callId: result.callId,
        name: result.toolName,
        kind: result.isError ? 'tool_result_error' : 'tool_result'
      })
    }
  }
  for (const request of requests) {
    for (const message of request.messages) {
      if (message.role === 'tool' && message.callId) results.set(message.callId, message)
    }
  }
  return results
}

function parseToolDefinitions(
  body: Record<string, unknown>,
  catalog: ModelRequestTraceRecord['toolCatalog']
): SemanticToolDefinition[] {
  const definitions: unknown[] = Array.isArray(body.tools) ? [...body.tools] : []
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!isRecord(item) || stringValue(item.type) !== 'additional_tools') continue
      if (Array.isArray(item.tools)) definitions.push(...item.tools)
    }
  }

  const tools = new Map<string, SemanticToolDefinition>()
  for (const entry of definitions) {
    if (!isRecord(entry)) continue
    const nested = isRecord(entry.function) ? entry.function : entry
    const name = stringValue(nested.name)
    if (!name) continue
    const schema = nested.parameters ?? nested.input_schema ?? nested.inputSchema
    tools.set(name, {
      name,
      description: stringValue(nested.description),
      provenance: resolveToolProvenance(name, catalog),
      ...(isRecord(schema) ? { inputSchema: schema } : {})
    })
  }
  return [...tools.values()]
}

function parseGeminiToolDefinitions(
  request: Record<string, unknown>,
  catalog: ModelRequestTraceRecord['toolCatalog']
): SemanticToolDefinition[] {
  if (!Array.isArray(request.tools)) return []
  const tools = new Map<string, SemanticToolDefinition>()
  for (const group of request.tools) {
    if (!isRecord(group) || !Array.isArray(group.functionDeclarations)) continue
    for (const definition of group.functionDeclarations) {
      if (!isRecord(definition)) continue
      const name = stringValue(definition.name)
      if (!name) continue
      const schema = definition.parametersJsonSchema ??
        definition.parameters ??
        definition.inputSchema
      tools.set(name, {
        name,
        description: stringValue(definition.description),
        provenance: resolveToolProvenance(name, catalog),
        ...(isRecord(schema) ? { inputSchema: schema } : {})
      })
    }
  }
  return [...tools.values()]
}

function parseGeminiParameters(
  body: Record<string, unknown>,
  request: Record<string, unknown>
): SemanticParameter[] {
  return [
    ...Object.entries(body)
      .filter(([key]) => key !== 'model' && key !== 'request'),
    ...Object.entries(request)
      .filter(([key]) => !GEMINI_STRUCTURAL_KEYS.has(key))
  ].map(([name, value]) => ({ name, value }))
}

function parseSkills(prompts: readonly SemanticPrompt[]): SemanticSkill[] {
  const skills = new Map<string, SemanticSkill>()
  for (const prompt of prompts) {
    const match = prompt.text.match(/### Available skills\s*\n([\s\S]*?)(?=\n### |$)/i)
    if (match?.[1]) {
      for (const line of match[1].split('\n')) {
        if (!line.startsWith('- ') || line.startsWith('- ...and ')) continue
        const pathMatch = line.match(/\s+\(file:\s*([^\n)]+)\)\s*$/)
        const withoutPath = pathMatch ? line.slice(2, pathMatch.index).trim() : line.slice(2).trim()
        const header = withoutPath.match(/^(.+?)\s+\(([^()]+)\)(?::\s*([\s\S]*))?$/)
        if (!header) continue
        const name = header[1]?.trim() ?? ''
        const id = header[2]?.trim() ?? name
        if (!id) continue
        skills.set(id, {
          id,
          name: name || id,
          description: header[3]?.trim() ?? '',
          active: false,
          ...(pathMatch?.[1] ? { path: pathMatch[1].trim() } : {})
        })
      }
    }
    const activePattern = /Active Skill:\s*(.+?)\s+\(([^)]+)\)\s*\n\nActivation:\s*([^\n]+)(?:\n\nDescription:\s*([^\n]+))?/g
    for (const active of prompt.text.matchAll(activePattern)) {
      const name = active[1]?.trim() ?? ''
      const id = active[2]?.trim() ?? name
      if (!id) continue
      const existing = skills.get(id)
      skills.set(id, {
        id,
        name: name || existing?.name || id,
        description: active[4]?.trim() || existing?.description || active[3]?.trim() || '',
        active: true,
        ...(existing?.path ? { path: existing.path } : {})
      })
    }
  }
  return [...skills.values()]
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map((part) => contentText(part)).filter(Boolean).join('\n')
  if (!isRecord(value)) return String(value)
  for (const key of ['text', 'input_text', 'output_text', 'content', 'output'] as const) {
    const candidate: unknown = value[key]
    if (candidate !== undefined && candidate !== value) {
      const text = contentText(candidate)
      if (text) return text
    }
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function oldestRecordFirst(left: ModelRequestTraceRecord, right: ModelRequestTraceRecord): number {
  const byTime = Date.parse(left.startedAt) - Date.parse(right.startedAt)
  return Number.isNaN(byTime) || byTime === 0
    ? left.sequence - right.sequence || left.id.localeCompare(right.id)
    : byTime
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
