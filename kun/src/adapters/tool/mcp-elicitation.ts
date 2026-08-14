import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { ElicitResult } from '@modelcontextprotocol/client'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { UserInputAnswer, UserInputQuestion } from '../../ports/user-input-gate.js'

type McpPrimitive = string | number | boolean | string[]

type McpFormSchema = {
  type: 'object'
  properties: Record<string, Record<string, unknown>>
  required?: string[]
}

type McpElicitationParams =
  | { mode?: 'form'; message: string; requestedSchema: McpFormSchema }
  | { mode: 'url'; message: string; url: string; elicitationId?: string }

const MAX_LOCAL_FORM_ATTEMPTS = 3

export class McpInteractionRequiredError extends Error {
  constructor(serverId: string) {
    super(`MCP server "${serverId}" requires user input, but user input is disabled for this turn`)
    this.name = 'McpInteractionRequiredError'
  }
}

/** Bind a connection-global SDK handler to the exact turn that initiated it. */
export class McpElicitationRuntime {
  private readonly contexts = new AsyncLocalStorage<ToolHostContext | undefined>()

  constructor(
    private readonly serverId: string,
    private readonly openExternal?: (url: URL) => void | Promise<void>
  ) {}

  run<T>(context: ToolHostContext | undefined, operation: () => Promise<T>): Promise<T> {
    return this.contexts.run(context, operation)
  }

  async handle(params: McpElicitationParams): Promise<ElicitResult> {
    const context = this.contexts.getStore()
    if (!context?.awaitUserInput) throw new McpInteractionRequiredError(this.serverId)
    if (params.mode === 'url') return this.handleUrl(context, params)
    return this.handleForm(context, params)
  }

  private async handleForm(
    context: ToolHostContext,
    params: Extract<McpElicitationParams, { mode?: 'form' }>
  ): Promise<ElicitResult> {
    const fields = Object.entries(params.requestedSchema.properties)
    const required = new Set(params.requestedSchema.required ?? [])
    const questions = fields.length > 0
      ? fields.map(([name, schema]) => formQuestion(name, schema, required.has(name)))
      : [confirmationQuestion()]
    let validationMessage: string | undefined
    for (let attempt = 0; attempt < MAX_LOCAL_FORM_ATTEMPTS; attempt += 1) {
      const id = `mcp_elicitation_${randomUUID()}`
      const resolution = await context.awaitUserInput?.({
        id,
        itemId: `${id}_item`,
        prompt: validationMessage ? `${params.message}\n\n${validationMessage}` : params.message,
        questions
      })
      if (!resolution || resolution.status !== 'submitted') return { action: 'cancel' }
      if (fields.length === 0) {
        const accepted = normalizedAnswerValue(resolution.answers[0]) === 'accept'
        return accepted ? { action: 'accept', content: {} } : { action: 'decline' }
      }
      const parsed = parseFormAnswers(fields, required, resolution.answers)
      if (parsed.ok) return { action: 'accept', content: parsed.content }
      validationMessage = parsed.message
    }
    throw new Error(`MCP server "${this.serverId}" elicitation received invalid answers too many times`)
  }

  private async handleUrl(
    context: ToolHostContext,
    params: Extract<McpElicitationParams, { mode: 'url' }>
  ): Promise<ElicitResult> {
    let target: URL
    try {
      target = new URL(params.url)
    } catch {
      return { action: 'decline' }
    }
    if ((target.protocol !== 'http:' && target.protocol !== 'https:') || !this.openExternal) {
      return { action: 'decline' }
    }
    const id = `mcp_url_elicitation_${randomUUID()}`
    const resolution = await context.awaitUserInput?.({
      id,
      itemId: `${id}_item`,
      prompt: params.message,
      questions: [{
        id: 'consent',
        header: 'External link',
        question: `Open this URL in your browser?\n${target.toString()}`,
        options: [
          { label: 'Open', description: 'Open the external URL and continue.' },
          { label: 'Decline', description: 'Do not open the URL.' }
        ],
        selectionMode: 'single'
      }]
    })
    if (!resolution || resolution.status !== 'submitted') return { action: 'cancel' }
    if (normalizedAnswerValue(resolution.answers[0]) !== 'open') return { action: 'decline' }
    await this.openExternal(target)
    return { action: 'accept' }
  }
}

function confirmationQuestion(): UserInputQuestion {
  return {
    id: '_confirm',
    header: 'Confirmation',
    question: 'Continue?',
    options: [
      { label: 'Accept', description: 'Continue the MCP operation.' },
      { label: 'Decline', description: 'Decline the MCP operation.' }
    ],
    selectionMode: 'single'
  }
}

function formQuestion(name: string, schema: Record<string, unknown>, required: boolean): UserInputQuestion {
  const options = schemaOptions(schema)
  const question = stringValue(schema.description) ?? stringValue(schema.title) ?? `Enter ${name}`
  const multiple = schema.type === 'array'
  return {
    id: name,
    header: `${stringValue(schema.title) ?? name}${required ? ' *' : ''}`,
    question,
    options,
    selectionMode: multiple ? 'multiple' : 'single',
    ...(multiple && positiveInteger(schema.minItems) ? { minSelections: positiveInteger(schema.minItems) } : {}),
    ...(multiple && positiveInteger(schema.maxItems) ? { maxSelections: positiveInteger(schema.maxItems) } : {})
  }
}

function schemaOptions(schema: Record<string, unknown>): UserInputQuestion['options'] {
  if (schema.type === 'boolean') {
    return [
      { label: 'true', description: 'Yes' },
      { label: 'false', description: 'No' }
    ]
  }
  const direct = stringArray(schema.enum)
  const itemSchema = objectValue(schema.items)
  const itemEnum = stringArray(itemSchema?.enum)
  const titled = [...arrayValue(schema.anyOf), ...arrayValue(itemSchema?.anyOf)].flatMap((entry) => {
    const item = objectValue(entry)
    return typeof item?.const === 'string'
      ? [{ label: item.const, description: stringValue(item.title) ?? item.const }]
      : []
  })
  if (titled.length > 0) return titled
  return [...new Set([...direct, ...itemEnum])].map((value) => ({ label: value, description: value }))
}

function parseFormAnswers(
  fields: Array<[string, Record<string, unknown>]>,
  required: ReadonlySet<string>,
  answers: UserInputAnswer[]
): { ok: true; content: Record<string, McpPrimitive> } | { ok: false; message: string } {
  const byId = new Map(answers.map((answer) => [answer.id, answer]))
  const content: Record<string, McpPrimitive> = {}
  for (const [name, schema] of fields) {
    const answer = byId.get(name)
    const raw = answer?.values ?? (answer?.value !== undefined ? [answer.value] : [])
    if (raw.length === 0 || (raw.length === 1 && raw[0]?.trim() === '')) {
      if (required.has(name)) return { ok: false, message: `A value is required for ${name}.` }
      continue
    }
    const parsed = parsePrimitive(schema, raw)
    if (!parsed.ok) return { ok: false, message: `${name}: ${parsed.message}` }
    content[name] = parsed.value
  }
  return { ok: true, content }
}

function parsePrimitive(
  schema: Record<string, unknown>,
  raw: string[]
): { ok: true; value: McpPrimitive } | { ok: false; message: string } {
  if (schema.type === 'array') return { ok: true, value: raw }
  const value = raw[0] ?? ''
  if (schema.type === 'number' || schema.type === 'integer') {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return { ok: false, message: 'enter a valid number' }
    if (schema.type === 'integer' && !Number.isInteger(parsed)) return { ok: false, message: 'enter a whole number' }
    return { ok: true, value: parsed }
  }
  if (schema.type === 'boolean') {
    const normalized = value.trim().toLowerCase()
    if (['true', 'yes', '1', 'on'].includes(normalized)) return { ok: true, value: true }
    if (['false', 'no', '0', 'off'].includes(normalized)) return { ok: true, value: false }
    return { ok: false, message: 'choose true or false' }
  }
  return { ok: true, value }
}

function normalizedAnswerValue(answer: UserInputAnswer | undefined): string {
  return (answer?.value ?? answer?.label ?? '').trim().toLowerCase()
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringArray(value: unknown): string[] {
  return arrayValue(value).filter((entry): entry is string => typeof entry === 'string')
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}
