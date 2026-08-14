import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path'
import type { ExtensionPrincipal } from './extension-agent-service.js'
import {
  ExtensionMediaHandleService,
  fileIdentityFromStat,
  identifiesSameFile,
  matchesFileIdentity,
  ExtensionMediaHandleError,
  type CompletedMediaOutputRecovery,
  type MediaOutputCompletionTransaction,
  type MediaHandleProjection,
  type PendingMediaOutputTransaction,
  type ResolvedMediaHandle
} from './extension-media-handle-service.js'
import {
  EXTENSION_MEDIA_INPUT_FORMAT_WHITELIST,
  EXTENSION_MEDIA_INPUT_PROTOCOL_WHITELIST,
  ExtensionMediaProcessError,
  ExtensionMediaProcessService
} from './extension-media-process-service.js'
import { BINDING_NAME, type ExtensionFfmpegRequest, FILTER_OPTION_BASES, FORBIDDEN_OPTION_BASES, MAX_SUBTITLE_TEXT_OUTPUT_BYTES, MAX_TEXT_OUTPUT_BYTES, PLACEHOLDER, SAFE_DRAWTEXT_OPTIONS, SAFE_EXPLICIT_FORMATS, SAFE_FILTERS, SAFE_FLAG_OPTIONS, SAFE_TEXT_OUTPUT_MIME_TYPES, SAFE_VALUE_OPTION_BASES } from './extension-media-ffmpeg-service-core.js'
import { invalidArgument } from './extension-media-ffmpeg-service-progress.js'

export function validateAndSubstituteFfmpegArguments(
  args: string[],
  inputs: Record<string, string>,
  outputs: Record<string, string>
): string[] {
  if (!Array.isArray(args) || args.length < 1 || args.length > 1024) {
    throw invalidArgument('FFmpeg arguments must contain between 1 and 1024 entries')
  }
  const usedInputs = new Set<string>()
  const usedOutputs = new Set<string>()
  const result: string[] = []
  for (let index = 0; index < args.length;) {
    const argument = args[index]!
    validateArgumentEntry(argument)
    const normalized = argument.toLowerCase()
    const base = optionBase(normalized)
    if (normalized === '-i') {
      const resource = args[index + 1]
      validateArgumentEntry(resource)
      const placeholder = PLACEHOLDER.exec(resource!)
      const name = placeholder?.[1] === 'input' ? placeholder[2] : undefined
      if (!name || !Object.hasOwn(inputs, name)) {
        throw invalidArgument('Input placeholders must be declared and immediately follow -i')
      }
      usedInputs.add(name)
      result.push(
        '-protocol_whitelist', EXTENSION_MEDIA_INPUT_PROTOCOL_WHITELIST,
        '-format_whitelist', EXTENSION_MEDIA_INPUT_FORMAT_WHITELIST,
        '-i', inputs[name]!
      )
      index += 2
      continue
    }
    if (argument.startsWith('-')) {
      if (FORBIDDEN_OPTION_BASES.has(normalized) || FORBIDDEN_OPTION_BASES.has(base)) {
        throw invalidArgument('FFmpeg argument uses a Host-reserved or unsafe option')
      }
      if (SAFE_FLAG_OPTIONS.has(normalized)) {
        result.push(argument)
        index += 1
        continue
      }
      const value = args[index + 1]
      if (base === '-f') {
        validateArgumentEntry(value)
        if (!SAFE_EXPLICIT_FORMATS.has(value!.toLowerCase())) {
          throw invalidArgument('FFmpeg format is not in the reviewed single-file allowlist')
        }
        result.push(argument, value!)
        index += 2
        continue
      }
      if (FILTER_OPTION_BASES.has(base)) {
        validateArgumentEntry(value)
        validateFilterGraph(value!)
        result.push(argument, value!)
        index += 2
        continue
      }
      if (SAFE_VALUE_OPTION_BASES.has(base)) {
        validateArgumentEntry(value)
        validateNonResourceValue(value!)
        result.push(argument, value!)
        index += 2
        continue
      }
      throw invalidArgument('FFmpeg option is not in the reviewed allowlist')
    }
    const placeholder = PLACEHOLDER.exec(argument)
    const name = placeholder?.[1] === 'output' ? placeholder[2] : undefined
    if (!name || !Object.hasOwn(outputs, name)) {
      if (argument.includes('{{') || argument.includes('}}')) {
        throw invalidArgument('Media placeholders must occupy a complete resource position')
      }
      throw invalidArgument('FFmpeg positional arguments must be declared output placeholders')
    }
    if (usedOutputs.has(name)) {
      throw invalidArgument('Each output placeholder may be used only once')
    }
    usedOutputs.add(name)
    result.push(outputs[name]!)
    index += 1
  }
  for (const name of Object.keys(inputs)) {
    if (!usedInputs.has(name)) throw invalidArgument('Every declared input must be used')
  }
  for (const name of Object.keys(outputs)) {
    if (!usedOutputs.has(name)) throw invalidArgument('Every declared output must be used exactly once')
  }
  return result
}

export function validateArgumentEntry(argument: string | undefined): asserts argument is string {
  if (typeof argument !== 'string' || argument.length < 1 || argument.length > 8192 ||
    containsAsciiControl(argument)) {
    throw invalidArgument('FFmpeg argument is invalid')
  }
}

export function optionBase(option: string): string {
  const streamSpecifier = option.indexOf(':')
  return streamSpecifier < 0 ? option : option.slice(0, streamSpecifier)
}

export function containsAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}

export function validateNonResourceValue(argument: string): void {
  if (argument.startsWith('@') || argument.includes('{{') || argument.includes('}}')) {
    throw invalidArgument('FFmpeg option values cannot reference external resources')
  }
  if (isAbsolute(argument) || argument.startsWith('\\\\') || argument.startsWith('//') ||
    argument.includes(`..${sep}`) || argument.includes('../') || argument.includes('..\\') ||
    argument.includes('$') || argument.includes('%') || argument.includes('`')) {
    throw invalidArgument('FFmpeg arguments cannot contain filesystem paths or expansion syntax')
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(argument) || /^[a-z]:/iu.test(argument)) {
    throw invalidArgument('FFmpeg arguments cannot open protocols or devices')
  }
  if ((argument.includes('/') || argument.includes('\\')) && !/^\d{1,10}\/\d{1,10}$/u.test(argument)) {
    throw invalidArgument('FFmpeg arguments cannot contain raw paths')
  }
}

export function validateFilterGraph(graph: string): void {
  const filters = splitFilterSyntax(graph, new Set([',', ';']))
  if (filters.length < 1) throw invalidArgument('FFmpeg filter graph is empty')
  for (const rawFilter of filters) {
    const filter = rawFilter.replace(/^(?:\s*\[[^\]\r\n]{1,128}\])+\s*/u, '')
    const match = /^([a-z][a-z0-9_]*)(?:@[a-z0-9_-]+)?(?:=(.*))?$/isu.exec(filter)
    const name = match?.[1]?.toLowerCase()
    if (!name || !SAFE_FILTERS.has(name)) {
      throw invalidArgument('FFmpeg filter is not in the reviewed allowlist')
    }
    if (name === 'drawtext') validateDrawtextOptions(match?.[2] ?? '')
  }
}

export function validateDrawtextOptions(raw: string): void {
  // FFmpeg first removes the filtergraph escaping layer and only then parses
  // drawtext's colon-delimited options. Decode exactly that one layer so our
  // validator sees the same boundaries while preserving drawtext escapes.
  const options = splitFilterSyntax(unescapeFilterGraphLayer(raw), new Set([':']))
  const seen = new Map<string, string>()
  for (const option of options) {
    const separator = option.indexOf('=')
    if (separator <= 0) {
      throw invalidArgument('FFmpeg drawtext requires reviewed named inline options')
    }
    const name = option.slice(0, separator).trim().toLowerCase()
    if (!SAFE_DRAWTEXT_OPTIONS.has(name)) {
      throw invalidArgument('FFmpeg drawtext path-loading or unknown options are not supported')
    }
    const value = option.slice(separator + 1)
    if (name === 'font') validateDrawtextFontFamily(value)
    seen.set(name, value)
  }
  if (!seen.has('text') || seen.get('expansion')?.toLowerCase() !== 'none') {
    throw invalidArgument('FFmpeg drawtext requires inline text with expansion=none')
  }
}

export function validateDrawtextFontFamily(value: string): void {
  if (value.length < 1 || value.length > 128 || containsAsciiControl(value) ||
    !/^[\p{L}\p{N}][\p{L}\p{N} ._+-]*$/u.test(value)) {
    throw invalidArgument('FFmpeg drawtext font must be a bounded inline font family')
  }
}

export function unescapeFilterGraphLayer(value: string): string {
  let result = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    if (character === '\\' && index + 1 < value.length) {
      result += value[index + 1]!
      index += 1
    } else {
      result += character
    }
  }
  return result
}

export function splitFilterSyntax(value: string, separators: Set<string>): string[] {
  const result: string[] = []
  let start = 0
  let quote: "'" | '"' | undefined
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (separators.has(character)) {
      const part = value.slice(start, index).trim()
      if (!part) throw invalidArgument('FFmpeg filter graph syntax is invalid')
      result.push(part)
      start = index + 1
    }
  }
  if (escaped || quote !== undefined) {
    throw invalidArgument('FFmpeg filter graph syntax is invalid')
  }
  const tail = value.slice(start).trim()
  if (!tail) throw invalidArgument('FFmpeg filter graph syntax is invalid')
  result.push(tail)
  return result
}

export function validateBindings(
  bindings: Record<string, string>,
  kind: string,
  max: number,
  allowEmpty = false
): void {
  if (!bindings || Array.isArray(bindings) || typeof bindings !== 'object') {
    throw invalidArgument(`FFmpeg ${kind} bindings are invalid`)
  }
  const entries = Object.entries(bindings)
  if ((!allowEmpty && entries.length < 1) || entries.length > max) {
    throw invalidArgument(`FFmpeg ${kind} binding count is outside the allowed limit`)
  }
  for (const [name, handleId] of entries) {
    if (!BINDING_NAME.test(name) || typeof handleId !== 'string' || handleId.length < 16 || handleId.length > 512) {
      throw invalidArgument(`FFmpeg ${kind} binding is invalid`)
    }
  }
}

export function validateRequestShape(
  request: ExtensionFfmpegRequest,
  textOutputs: ReturnType<typeof validateTextOutputs>,
  maxInputs: number,
  maxOutputs: number
): boolean {
  if (!Array.isArray(request.arguments) || request.arguments.length > 1024) {
    throw invalidArgument('FFmpeg arguments must contain at most 1024 entries')
  }
  validateBindings(request.inputs, 'input', maxInputs, true)
  validateBindings(request.outputs, 'output', maxOutputs, true)
  const inputCount = Object.keys(request.inputs).length
  const ffmpegOutputCount = Object.keys(request.outputs).length
  if (ffmpegOutputCount + textOutputs.length > maxOutputs) {
    throw invalidArgument('FFmpeg output binding count is outside the allowed limit')
  }
  for (const output of textOutputs) {
    if (Object.hasOwn(request.outputs, output.name)) {
      throw invalidArgument('FFmpeg and text output binding names must be distinct')
    }
  }

  if (ffmpegOutputCount === 0) {
    if (textOutputs.length === 0) {
      throw invalidArgument('A text-only media job requires at least one text output')
    }
    if (inputCount !== 0 || request.arguments.length !== 0) {
      throw invalidArgument('A text-only media job cannot declare FFmpeg inputs or arguments')
    }
    return false
  }

  if (inputCount === 0 || request.arguments.length === 0) {
    throw invalidArgument('An FFmpeg media job requires input, output, and argument bindings')
  }
  return true
}

export function validateTextOutputs(
  bindings: ExtensionFfmpegRequest['textOutputs'],
  max: number
): Array<{
    name: string
    handleId: string
    mimeType: 'application/x-subrip' | 'application/x-otio+json' | 'text/vtt'
    content: string
  }> {
  if (bindings === undefined) return []
  if (!bindings || Array.isArray(bindings) || typeof bindings !== 'object') {
    throw invalidArgument('FFmpeg text output bindings are invalid')
  }
  const entries = Object.entries(bindings)
  if (entries.length > max) {
    throw invalidArgument('FFmpeg text output binding count is outside the allowed limit')
  }
  let totalBytes = 0
  return entries.map(([name, binding]) => {
    if (!BINDING_NAME.test(name) || !binding || Array.isArray(binding) ||
      typeof binding !== 'object' || typeof binding.handleId !== 'string' ||
      binding.handleId.length < 16 || binding.handleId.length > 512 ||
      !SAFE_TEXT_OUTPUT_MIME_TYPES.has(binding.mimeType) || typeof binding.content !== 'string' ||
      binding.content.includes('\0')) {
      throw invalidArgument('FFmpeg text output binding is invalid')
    }
    const bytes = Buffer.byteLength(binding.content, 'utf8')
    totalBytes += bytes
    if (bytes < 1 || bytes > MAX_TEXT_OUTPUT_BYTES || totalBytes > MAX_TEXT_OUTPUT_BYTES) {
      throw invalidArgument('FFmpeg text outputs exceed their UTF-8 byte limit')
    }
    if (binding.mimeType !== 'application/x-otio+json' && bytes > MAX_SUBTITLE_TEXT_OUTPUT_BYTES) {
      throw invalidArgument('FFmpeg subtitle text output exceeds its UTF-8 byte limit')
    }
    if (binding.mimeType === 'application/x-otio+json') {
      validateOpenTimelineIoJson(binding.content)
    }
    return {
      name,
      handleId: binding.handleId,
      mimeType: binding.mimeType,
      content: binding.content
    }
  })
}

export function validateOpenTimelineIoJson(content: string): void {
  let root: unknown
  try {
    root = JSON.parse(content)
  } catch {
    throw invalidArgument('OpenTimelineIO text output is not valid JSON')
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw invalidArgument('OpenTimelineIO text output root must be an object')
  }
  const schema = (root as Record<string, unknown>).OTIO_SCHEMA
  if (schema !== 'SerializableCollection.1' && schema !== 'Timeline.1') {
    throw invalidArgument('OpenTimelineIO text output root schema is unsupported')
  }
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    nodes += 1
    if (nodes > 100_000 || current.depth > 64) {
      throw invalidArgument('OpenTimelineIO text output structure exceeds its bound')
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 })
      continue
    }
    if (!current.value || typeof current.value !== 'object') continue
    for (const [key, child] of Object.entries(current.value as Record<string, unknown>)) {
      if (key === 'target_url' && (
        typeof child !== 'string' ||
        !/^kun-media:\/\/[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(child)
      )) {
        throw invalidArgument('OpenTimelineIO media references must use opaque kun-media URLs')
      }
      pending.push({ value: child, depth: current.depth + 1 })
    }
  }
}
