import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { withFileMutationQueue } from './file-mutation-queue.js'
import { LocalToolHost, type LocalTool } from './local-tool-host.js'
import { assertCanWritePath } from './sandbox-policy.js'
import { resolveWorkspacePath, withToolBoundary } from './builtin-tool-utils.js'
import { resolvePathThroughSymlinks, sameFilesystemPath } from './workspace-path.js'

const OFFICECLI_TIMEOUT_MS = 60_000
const OFFICECLI_MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const OFFICECLI_MAX_OPERATIONS = 200
const OFFICECLI_MAX_PREVIEW_BYTES = 4 * 1024 * 1024
const OFFICECLI_MAX_CONCURRENCY = 2
const OFFICECLI_FORMATS = new Set(['.docx', '.xlsx', '.pptx'])

type OfficeCliRunResult = {
  stdout: string
  stderr: string
  exitCode: number
}

type OfficeCliRunnerOptions = {
  binaryPath: string
  profileDir: string
  maxConcurrency?: number
  logger?: (message: string) => void
}

type OfficeEditOperation = {
  type: 'set' | 'add' | 'remove' | 'move' | 'swap' | 'replace_text'
  target?: string
  parent?: string
  destination?: string
  with?: string
  elementType?: string
  props?: Record<string, string | number | boolean | null>
  before?: string
  after?: string
  find?: string
  replace?: string
  regex?: boolean
}

type FileIdentity = {
  device: bigint
  inode: bigint
  size: bigint
  mtimeNs: bigint
  links: bigint
  parentDevice: bigint
  parentInode: bigint
  physicalPath: string
}

type QueueWaiter = {
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  abort?: () => void
}

export class OfficeCliRunner {
  private readonly binaryPath: string
  private readonly profileDir: string
  private readonly maxConcurrency: number
  private readonly logger: (message: string) => void
  private active = 0
  private readonly waiters: QueueWaiter[] = []

  constructor(options: OfficeCliRunnerOptions) {
    this.binaryPath = options.binaryPath
    this.profileDir = options.profileDir
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? OFFICECLI_MAX_CONCURRENCY)
    this.logger = options.logger ?? ((message) => console.error(message))
  }

  async run(args: readonly string[], signal?: AbortSignal): Promise<OfficeCliRunResult> {
    const release = await this.acquire(signal)
    try {
      await mkdir(this.profileDir, { recursive: true, mode: 0o700 })
      return await this.spawn(args, signal)
    } finally {
      release()
    }
  }

  async diagnose(): Promise<void> {
    try {
      const [version, schema] = await Promise.all([
        this.run(['--version']),
        this.run(['--output-schema-crc'])
      ])
      const versionLabel = version.exitCode === 0 ? version.stdout.trim() : 'unavailable'
      const schemaCrc = schema.exitCode === 0 ? schema.stdout.trim() : 'unavailable'
      this.logger(
        `[officecli] startup version=${boundedLogValue(versionLabel)} ` +
        `arch=${process.arch} platform=${process.platform} schema_crc=${boundedLogValue(schemaCrc)}`
      )
    } catch (error) {
      this.logger(`[officecli] startup diagnostic_failed=${boundedLogValue(errorMessage(error))}`)
    }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError())
    if (this.active < this.maxConcurrency) {
      this.active += 1
      return Promise.resolve(() => this.release())
    }
    return new Promise<() => void>((resolveWaiter, rejectWaiter) => {
      const waiter: QueueWaiter = {
        resolve: resolveWaiter,
        reject: rejectWaiter,
        ...(signal ? { signal } : {})
      }
      if (signal) {
        waiter.abort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          rejectWaiter(abortError())
        }
        signal.addEventListener('abort', waiter.abort, { once: true })
      }
      this.waiters.push(waiter)
    })
  }

  private release(): void {
    const waiter = this.waiters.shift()
    if (!waiter) {
      this.active = Math.max(0, this.active - 1)
      return
    }
    if (waiter.signal && waiter.abort) {
      waiter.signal.removeEventListener('abort', waiter.abort)
    }
    waiter.resolve(() => this.release())
  }

  private spawn(args: readonly string[], signal?: AbortSignal): Promise<OfficeCliRunResult> {
    const category = args[0] || 'unknown'
    const startedAt = Date.now()
    return new Promise<OfficeCliRunResult>((resolveRun, rejectRun) => {
      let child: ChildProcess
      try {
        child = spawn(this.binaryPath, [...args], {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: officeCliEnvironment(this.profileDir)
        })
      } catch (error) {
        rejectRun(error)
        return
      }

      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      let settled = false
      let timeout: NodeJS.Timeout | undefined
      const finish = (callback: () => void, exitCode: number | 'error'): void => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        signal?.removeEventListener('abort', onAbort)
        this.logger(
          `[officecli] command=${boundedLogValue(category)} duration_ms=${Date.now() - startedAt} ` +
          `exit_code=${exitCode}`
        )
        callback()
      }
      const stopForOutputLimit = (): void => {
        child.kill()
        finish(
          () => rejectRun(new Error(`OfficeCLI output exceeds ${OFFICECLI_MAX_OUTPUT_BYTES} bytes.`)),
          'error'
        )
      }
      const append = (
        current: Buffer<ArrayBufferLike>,
        chunk: Buffer<ArrayBufferLike>
      ): Buffer<ArrayBufferLike> => {
        if (current.length + chunk.length > OFFICECLI_MAX_OUTPUT_BYTES) {
          stopForOutputLimit()
          return current
        }
        return Buffer.concat([current, chunk])
      }
      const onAbort = (): void => {
        child.kill()
        finish(() => rejectRun(abortError()), 'error')
      }

      child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
      child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
      child.once('error', (error) => finish(() => rejectRun(error), 'error'))
      child.once('close', (code) => finish(() => resolveRun({
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        exitCode: code ?? 1
      }), code ?? 1))
      signal?.addEventListener('abort', onAbort, { once: true })
      timeout = setTimeout(() => {
        child.kill()
        finish(
          () => rejectRun(new Error(`OfficeCLI timed out after ${OFFICECLI_TIMEOUT_MS}ms.`)),
          'error'
        )
      }, OFFICECLI_TIMEOUT_MS)
    })
  }
}

export function buildOfficeCliToolProviders(options: {
  binaryPath?: string
  profileDir: string
  runner?: OfficeCliRunner
}): CapabilityToolProvider[] {
  const binaryPath = options.binaryPath?.trim()
  if (!options.runner && (!binaryPath || !existsSync(binaryPath))) return []
  const runner = options.runner ?? new OfficeCliRunner({
    binaryPath: binaryPath!,
    profileDir: options.profileDir
  })
  if (!options.runner) void runner.diagnose()
  return [{
    id: 'officecli',
    kind: 'built-in',
    enabled: true,
    available: true,
    tools: buildOfficeCliLocalTools(runner)
  }]
}

export function buildOfficeCliLocalTools(runner: Pick<OfficeCliRunner, 'run'>): LocalTool[] {
  return [
    createOfficeInspectTool(runner),
    createOfficeEditTool(runner),
    createOfficePreviewTool(runner)
  ]
}

function createOfficeInspectTool(runner: Pick<OfficeCliRunner, 'run'>): LocalTool {
  return LocalToolHost.defineTool({
    name: 'office_inspect',
    description:
      'Inspect an existing DOCX, XLSX, or PPTX file. Use this before office_edit. ' +
      'Returns the resolved path, document format, current SHA-256, and bounded structured content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        action: {
          type: 'string',
          enum: ['summary', 'text', 'outline', 'query', 'issues', 'validate']
        },
        target: { type: 'string' },
        maxLines: { type: 'integer', minimum: 1, maximum: 4000 }
      },
      required: ['path', 'action'],
      additionalProperties: false
    },
    policy: 'auto',
    toolKind: 'tool_call',
    sideEffect: 'read-only',
    execute: async (args, context) => withToolBoundary(async () => {
      const rawPath = stringArgument(args.path)
      const action = stringArgument(args.action)
      const target = stringArgument(args.target)
      if (!rawPath || !isInspectAction(action)) {
        return { output: { error: 'path and a supported action are required' }, isError: true }
      }
      const resolvedPath = await resolveWorkspacePath(rawPath, context)
      const format = officeFormat(resolvedPath.absolutePath)
      const sourceSha256 = await sha256File(resolvedPath.absolutePath, context.abortSignal)
      const command = inspectCommand(
        resolvedPath.absolutePath,
        action,
        target,
        integerArgument(args.maxLines, 1, 4000) ?? 1000
      )
      const result = await runner.run(command, context.abortSignal)
      assertOfficeCliSuccess(result, `Office ${action} failed`)
      return {
        output: {
          path: resolvedPath.absolutePath,
          relative_path: resolvedPath.relativePath,
          format,
          source_sha256: sourceSha256,
          action,
          result: parseOfficeCliOutput(result.stdout)
        }
      }
    })
  })
}

function createOfficePreviewTool(runner: Pick<OfficeCliRunner, 'run'>): LocalTool {
  return LocalToolHost.defineTool({
    name: 'office_preview',
    description:
      'Generate a bounded self-contained HTML preview for an existing DOCX, XLSX, or PPTX. ' +
      'Optionally scope it to a page, slide, sheet, or cell range when OfficeCLI supports that format.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        page: { type: 'integer', minimum: 1 },
        sheet: { type: 'string' },
        range: { type: 'string' }
      },
      required: ['path'],
      additionalProperties: false
    },
    policy: 'auto',
    toolKind: 'tool_call',
    sideEffect: 'read-only',
    execute: async (args, context) => withToolBoundary(async () => {
      const rawPath = stringArgument(args.path)
      if (!rawPath) {
        return { output: { error: 'path is required' }, isError: true }
      }
      const resolvedPath = await resolveWorkspacePath(rawPath, context)
      const format = officeFormat(resolvedPath.absolutePath)
      const command = ['view', resolvedPath.absolutePath, 'html']
      const page = integerArgument(args.page, 1, 100_000)
      const sheet = stringArgument(args.sheet)
      const range = stringArgument(args.range)
      if (page || sheet || range) {
        const previewRoot = join(context.runtimeDataDir || tmpdir(), 'officecli-previews')
        const outputPath = join(previewRoot, `${randomUUID()}.png`)
        await mkdir(previewRoot, { recursive: true, mode: 0o700 })
        const screenshotCommand = [
          'view',
          resolvedPath.absolutePath,
          'screenshot',
          '--out',
          outputPath
        ]
        if (page) screenshotCommand.push('--page', String(page))
        const scopedRange = sheet
          ? `${sheet}!${range || 'A1:Z200'}`
          : range
        if (scopedRange) screenshotCommand.push('--range', scopedRange)
        try {
          const result = await runner.run(screenshotCommand, context.abortSignal)
          assertOfficeCliSuccess(result, 'Office visual preview failed')
          const image = await readFile(outputPath)
          if (image.byteLength <= 0 || image.byteLength > OFFICECLI_MAX_PREVIEW_BYTES) {
            throw new Error(
              `Office visual preview exceeds ${OFFICECLI_MAX_PREVIEW_BYTES} bytes.`
            )
          }
          return {
            output: {
              kind: 'image',
              path: resolvedPath.absolutePath,
              relative_path: resolvedPath.relativePath,
              format,
              source_sha256: await sha256File(
                resolvedPath.absolutePath,
                context.abortSignal
              ),
              mime_type: 'image/png',
              data_base64: image.toString('base64')
            }
          }
        } finally {
          await rm(outputPath, { force: true }).catch(() => undefined)
        }
      }

      const result = await runner.run(command, context.abortSignal)
      assertOfficeCliSuccess(result, 'Office HTML preview failed')
      return {
        output: {
          path: resolvedPath.absolutePath,
          relative_path: resolvedPath.relativePath,
          format,
          source_sha256: await sha256File(resolvedPath.absolutePath, context.abortSignal),
          html: result.stdout
        }
      }
    })
  })
}

function createOfficeEditTool(runner: Pick<OfficeCliRunner, 'run'>): LocalTool {
  return LocalToolHost.defineTool({
    name: 'office_edit',
    description:
      'Atomically edit an existing DOCX, XLSX, or PPTX using controlled structured operations. ' +
      'Call office_inspect first and pass its exact source_sha256 as expectedSha256. ' +
      'The original file is replaced only after the batch and OpenXML validation both succeed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        expectedSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        operations: {
          type: 'array',
          minItems: 1,
          maxItems: OFFICECLI_MAX_OPERATIONS,
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['set', 'add', 'remove', 'move', 'swap', 'replace_text']
              },
              target: { type: 'string' },
              parent: { type: 'string' },
              destination: { type: 'string' },
              with: { type: 'string' },
              elementType: { type: 'string' },
              props: {
                type: 'object',
                additionalProperties: {
                  oneOf: [
                    { type: 'string' },
                    { type: 'number' },
                    { type: 'boolean' },
                    { type: 'null' }
                  ]
                }
              },
              before: { type: 'string' },
              after: { type: 'string' },
              find: { type: 'string' },
              replace: { type: 'string' },
              regex: { type: 'boolean' }
            },
            required: ['type'],
            additionalProperties: false
          }
        }
      },
      required: ['path', 'expectedSha256', 'operations'],
      additionalProperties: false
    },
    policy: 'on-request',
    toolKind: 'file_change',
    externalWritePathArguments: ['path'],
    execute: async (args, context) => withToolBoundary(async () => {
      const rawPath = stringArgument(args.path)
      const expectedSha256 = stringArgument(args.expectedSha256).toLowerCase()
      const operations = parseOfficeEditOperations(args.operations)
      if (!rawPath || !/^[a-f0-9]{64}$/.test(expectedSha256) || operations.length === 0) {
        return {
          output: { error: 'path, expectedSha256, and at least one valid operation are required' },
          isError: true
        }
      }
      const resolvedPath = await resolveWorkspacePath(rawPath, context)
      officeFormat(resolvedPath.absolutePath)
      assertCanWritePath(resolvedPath.absolutePath, context)
      return withFileMutationQueue(resolvedPath.absolutePath, async () =>
        executeAtomicOfficeEdit({
          runner,
          context,
          absolutePath: resolvedPath.absolutePath,
          relativePath: resolvedPath.relativePath,
          expectedSha256,
          operations
        }))
    })
  })
}

async function executeAtomicOfficeEdit(input: {
  runner: Pick<OfficeCliRunner, 'run'>
  context: ToolHostContext
  absolutePath: string
  relativePath: string
  expectedSha256: string
  operations: OfficeEditOperation[]
}): Promise<{ output: unknown }> {
  const identity = await captureFileIdentity(input.absolutePath)
  const beforeSha256 = await sha256File(input.absolutePath, input.context.abortSignal)
  if (beforeSha256 !== input.expectedSha256) {
    throw new Error(
      `Office document changed since inspection: expected ${input.expectedSha256}, found ${beforeSha256}.`
    )
  }

  const inspection = await input.runner.run(
    ['view', input.absolutePath, 'outline'],
    input.context.abortSignal
  )
  assertOfficeCliSuccess(inspection, 'Office pre-edit inspection failed')

  const extension = extname(input.absolutePath)
  const stem = basename(input.absolutePath, extension)
  const temporaryPath = join(
    dirname(input.absolutePath),
    `.${stem}.kun-office-${randomUUID()}${extension}`
  )
  const commandPath = join(
    dirname(input.absolutePath),
    `.${stem}.kun-office-${randomUUID()}.json`
  )
  try {
    await copyFile(input.absolutePath, temporaryPath)
    const commands = input.operations.map(toOfficeCliBatchItem)
    await writeFile(commandPath, JSON.stringify(commands), { encoding: 'utf8', mode: 0o600 })

    const batch = await input.runner.run(
      ['batch', temporaryPath, '--input', commandPath, '--json'],
      input.context.abortSignal
    )
    assertOfficeCliSuccess(batch, 'Office edit batch failed')

    const validation = await input.runner.run(
      ['validate', temporaryPath, '--json'],
      input.context.abortSignal
    )
    assertOfficeCliSuccess(validation, 'Edited Office document failed validation')

    const afterSha256 = await sha256File(temporaryPath, input.context.abortSignal)
    await assertFileIdentityUnchanged(input.absolutePath, identity)
    const currentSha256 = await sha256File(input.absolutePath, input.context.abortSignal)
    if (currentSha256 !== beforeSha256) {
      throw new Error('Office document contents changed while the edit was being prepared.')
    }

    await rename(temporaryPath, input.absolutePath)
    return {
      output: {
        path: input.absolutePath,
        relative_path: input.relativePath,
        operations: input.operations.length,
        before_sha256: beforeSha256,
        after_sha256: afterSha256,
        validation: parseOfficeCliOutput(validation.stdout),
        preview_invalidated: true
      }
    }
  } finally {
    await Promise.all([
      rm(temporaryPath, { force: true }).catch(() => undefined),
      rm(commandPath, { force: true }).catch(() => undefined)
    ])
  }
}

function toOfficeCliBatchItem(operation: OfficeEditOperation): Record<string, unknown> {
  if (operation.type === 'set') {
    if (!operation.target || !operation.props || Object.keys(operation.props).length === 0) {
      throw new Error('set operations require target and props')
    }
    return { command: 'set', path: operation.target, props: operation.props }
  }
  if (operation.type === 'add') {
    const parent = operation.parent || operation.target
    if (!parent || !operation.elementType) {
      throw new Error('add operations require parent (or target) and elementType')
    }
    return {
      command: 'add',
      parent,
      type: operation.elementType,
      ...(operation.props ? { props: operation.props } : {}),
      ...(operation.before ? { before: operation.before } : {}),
      ...(operation.after ? { after: operation.after } : {})
    }
  }
  if (operation.type === 'remove') {
    if (!operation.target) throw new Error('remove operations require target')
    return { command: 'remove', path: operation.target }
  }
  if (operation.type === 'move') {
    if (!operation.target || !operation.destination) {
      throw new Error('move operations require target and destination')
    }
    return {
      command: 'move',
      path: operation.target,
      to: operation.destination,
      ...(operation.before ? { before: operation.before } : {}),
      ...(operation.after ? { after: operation.after } : {})
    }
  }
  if (operation.type === 'swap') {
    if (!operation.target || !operation.with) throw new Error('swap operations require target and with')
    return { command: 'swap', path: operation.target, path2: operation.with }
  }
  if (!operation.target || operation.find == null || operation.replace == null) {
    throw new Error('replace_text operations require target, find, and replace')
  }
  return {
    command: 'set',
    path: operation.target,
    props: {
      find: operation.find,
      replace: operation.replace,
      ...(operation.regex != null ? { regex: operation.regex } : {})
    }
  }
}

function parseOfficeEditOperations(value: unknown): OfficeEditOperation[] {
  if (!Array.isArray(value) || value.length > OFFICECLI_MAX_OPERATIONS) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    const type = stringArgument(record.type)
    if (!isOfficeEditOperationType(type)) return []
    const props = scalarRecord(record.props)
    return [{
      type,
      target: optionalString(record.target),
      parent: optionalString(record.parent),
      destination: optionalString(record.destination),
      with: optionalString(record.with),
      elementType: optionalString(record.elementType),
      ...(props ? { props } : {}),
      before: optionalString(record.before),
      after: optionalString(record.after),
      find: optionalRawString(record.find),
      replace: optionalRawString(record.replace),
      ...(typeof record.regex === 'boolean' ? { regex: record.regex } : {})
    }]
  })
}

function inspectCommand(
  filePath: string,
  action: 'summary' | 'text' | 'outline' | 'query' | 'issues' | 'validate',
  target: string,
  maxLines: number
): string[] {
  if (action === 'validate') return ['validate', filePath, '--json']
  if (action === 'query') {
    if (!target) throw new Error('query inspection requires target')
    return ['query', filePath, target, '--json']
  }
  if (action === 'issues') return ['view', filePath, 'issues', '--json']
  if (action === 'summary') return ['view', filePath, 'stats', '--json']
  if (action === 'text') return ['view', filePath, 'text', '--max-lines', String(maxLines)]
  return ['view', filePath, 'outline']
}

function officeFormat(filePath: string): 'docx' | 'xlsx' | 'pptx' {
  const extension = extname(filePath).toLowerCase()
  if (!OFFICECLI_FORMATS.has(extension)) {
    throw new Error('Office tools support existing .docx, .xlsx, and .pptx files only.')
  }
  return extension.slice(1) as 'docx' | 'xlsx' | 'pptx'
}

async function captureFileIdentity(filePath: string): Promise<FileIdentity> {
  const lexical = resolve(filePath)
  const linkInfo = await lstat(lexical, { bigint: true })
  if (linkInfo.isSymbolicLink()) throw new Error('Office edits do not follow symbolic links.')
  if (!linkInfo.isFile()) throw new Error('Office edit target is not a regular file.')
  if (linkInfo.nlink !== 1n) throw new Error('Office edit target must have exactly one hard link.')
  if (linkInfo.ino === 0n) throw new Error('Office edit target has no stable inode identity.')
  const physicalPath = await resolvePathThroughSymlinks(lexical)
  const parent = await stat(dirname(lexical), { bigint: true })
  if (!parent.isDirectory() || parent.ino === 0n) {
    throw new Error('Office edit target parent has no stable directory identity.')
  }
  return {
    device: linkInfo.dev,
    inode: linkInfo.ino,
    size: linkInfo.size,
    mtimeNs: linkInfo.mtimeNs,
    links: linkInfo.nlink,
    parentDevice: parent.dev,
    parentInode: parent.ino,
    physicalPath
  }
}

async function assertFileIdentityUnchanged(filePath: string, expected: FileIdentity): Promise<void> {
  const current = await captureFileIdentity(filePath)
  if (
    current.device !== expected.device ||
    current.inode !== expected.inode ||
    current.size !== expected.size ||
    current.mtimeNs !== expected.mtimeNs ||
    current.links !== expected.links ||
    current.parentDevice !== expected.parentDevice ||
    current.parentInode !== expected.parentInode ||
    !sameFilesystemPath(current.physicalPath, expected.physicalPath)
  ) {
    throw new Error('Office document identity or parent directory changed while editing.')
  }
}

function sha256File(filePath: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise<string>((resolveHash, rejectHash) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    const onAbort = (): void => {
      stream.destroy(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    stream.on('data', (chunk) => {
      hash.update(chunk)
    })
    stream.once('error', (error) => {
      signal?.removeEventListener('abort', onAbort)
      rejectHash(error)
    })
    stream.once('end', () => {
      signal?.removeEventListener('abort', onAbort)
      resolveHash(hash.digest('hex'))
    })
  })
}

function officeCliEnvironment(profileDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OFFICECLI_SKIP_UPDATE: '1',
    OFFICECLI_NO_AUTO_INSTALL: '1',
    OFFICECLI_NO_AUTO_RESIDENT: '1',
    OFFICECLI_RESIDENT_FLUSH: 'each',
    HOME: profileDir,
    USERPROFILE: profileDir,
    APPDATA: profileDir,
    LOCALAPPDATA: profileDir,
    XDG_CONFIG_HOME: profileDir
  }
}

function assertOfficeCliSuccess(result: OfficeCliRunResult, fallback: string): void {
  if (result.exitCode === 0) return
  const detail = result.stderr.trim() || result.stdout.trim()
  throw new Error(detail ? `${fallback}: ${detail}` : fallback)
}

function parseOfficeCliOutput(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  try {
    return JSON.parse(trimmed)
  } catch {
    return trimmed
  }
}

function scalarRecord(value: unknown): Record<string, string | number | boolean | null> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const output: Record<string, string | number | boolean | null> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof item !== 'string' &&
      typeof item !== 'number' &&
      typeof item !== 'boolean' &&
      item !== null
    ) {
      return undefined
    }
    output[key] = item
  }
  return output
}

function stringArgument(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function optionalString(value: unknown): string | undefined {
  const text = stringArgument(value)
  return text || undefined
}

function optionalRawString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function integerArgument(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined
}

function isInspectAction(
  value: string
): value is 'summary' | 'text' | 'outline' | 'query' | 'issues' | 'validate' {
  return ['summary', 'text', 'outline', 'query', 'issues', 'validate'].includes(value)
}

function isOfficeEditOperationType(value: string): value is OfficeEditOperation['type'] {
  return ['set', 'add', 'remove', 'move', 'swap', 'replace_text'].includes(value)
}

function abortError(): Error {
  const error = new Error('OfficeCLI operation aborted.')
  error.name = 'AbortError'
  return error
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function boundedLogValue(value: string): string {
  return value.replace(/\s+/g, '_').slice(0, 160) || 'unknown'
}
