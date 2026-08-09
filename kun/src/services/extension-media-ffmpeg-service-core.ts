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
import { validateAndSubstituteFfmpegArguments, validateRequestShape, validateTextOutputs } from './extension-media-ffmpeg-service-argument-validation.js'
import { assertNoAliases, cleanupBackups, cleanupStaging, commitRecoveredOutput, outputTransaction, promoteAll, PromotionRollbackError, recoveryOutputHandleIds, rollbackInterruptedOutput, rollbackPromotion, safeStagingExtension, sameIdentity, stagingDirectoryBytes, transactionPaths } from './extension-media-ffmpeg-service-output-transaction.js'
import { assertNotCancelled, boundedInteger, FfmpegProgressParser, invalidArgument, requirePermissions, speed } from './extension-media-ffmpeg-service-progress.js'

export const BINDING_NAME = /^[a-z][a-z0-9_-]{0,63}$/u

export const PLACEHOLDER = /^\{\{(input|output):([a-z][a-z0-9_-]{0,63})\}\}$/u

export const FORBIDDEN_OPTION_BASES = new Set([
  '-attach',
  '-dump_attachment',
  '-filter_complex_script',
  '-filter_script',
  '-format_whitelist',
  '-init_hw_device',
  '-pass',
  '-passlogfile',
  '-progress',
  '-protocol_whitelist',
  '-report',
  '-sdp_file',
  '-vstats_file',
  '-y'
])

export const SAFE_FLAG_OPTIONS = new Set([
  '-accurate_seek',
  '-an',
  '-autorotate',
  '-copyts',
  '-dn',
  '-noaccurate_seek',
  '-noautorotate',
  '-nostdin',
  '-re',
  '-shortest',
  '-sn',
  '-start_at_zero',
  '-vn'
])

export const SAFE_VALUE_OPTION_BASES = new Set([
  '-ac',
  '-afade',
  '-ar',
  '-aspect',
  '-b',
  '-bf',
  '-brand',
  '-bufsize',
  '-c',
  '-channel_layout',
  '-codec',
  '-coder',
  '-context',
  '-crf',
  '-disposition',
  '-filter_complex_threads',
  '-filter_threads',
  '-frames',
  '-framerate',
  '-g',
  '-itsscale',
  '-itsoffset',
  '-keyint_min',
  '-level',
  '-map',
  '-map_chapters',
  '-map_metadata',
  '-maxrate',
  '-minrate',
  '-movflags',
  '-pix_fmt',
  '-preset',
  '-profile',
  '-q',
  '-qp',
  '-qscale',
  '-r',
  '-refs',
  '-s',
  '-sample_fmt',
  '-sc_threshold',
  '-sseof',
  '-ss',
  '-stream_loop',
  '-t',
  '-tag',
  '-threads',
  '-to',
  '-tune',
  '-vframes',
  '-aframes',
  '-vsync'
])

export const FILTER_OPTION_BASES = new Set(['-af', '-filter', '-filter_complex', '-vf'])

export const SAFE_EXPLICIT_FORMATS = new Set([
  'aac',
  'adts',
  'aiff',
  'avi',
  'flac',
  'gif',
  'image2',
  'image2pipe',
  'matroska',
  'mjpeg',
  'mov',
  'mp3',
  'mp4',
  'null',
  'ogg',
  'opus',
  'wav',
  'webm',
  'webp'
])

export const SAFE_FILTERS = new Set([
  'adelay',
  'afade',
  'amix',
  'anull',
  'aresample',
  'asetpts',
  'atrim',
  'color',
  'colorchannelmixer',
  'concat',
  'crop',
  'drawtext',
  'eq',
  'fade',
  'format',
  'fps',
  'loudnorm',
  'null',
  'overlay',
  'pad',
  'rotate',
  'scale',
  'setdar',
  'setpts',
  'setsar',
  'settb',
  'showwavespic',
  'tile',
  'transpose',
  'trim',
  'volume',
  'boxblur',
  'colorbalance',
  'unsharp',
  'vignette'
])

export const SAFE_DRAWTEXT_OPTIONS = new Set([
  'alpha',
  'bordercolor',
  'borderw',
  'box',
  'boxborderw',
  'boxcolor',
  'enable',
  'expansion',
  'fix_bounds',
  'font',
  'fontcolor',
  'fontsize',
  'line_spacing',
  'shadowcolor',
  'shadowx',
  'shadowy',
  'start_number',
  'tabsize',
  'text',
  'text_align',
  'x',
  'y',
  'y_align'
])

export const SAFE_TEXT_OUTPUT_MIME_TYPES = new Set([
  'application/x-subrip',
  'application/x-otio+json',
  'text/vtt'
])

export const MAX_SUBTITLE_TEXT_OUTPUT_BYTES = 192 * 1024

export const MAX_TEXT_OUTPUT_BYTES = 2 * 1024 * 1024

export type ExtensionFfmpegRequest = {
  arguments: string[]
  inputs: Record<string, string>
  outputs: Record<string, string>
  textOutputs?: Record<string, {
    handleId: string
    mimeType: 'application/x-subrip' | 'application/x-otio+json' | 'text/vtt'
    content: string
  }>
}

export type ExtensionFfmpegProgress = {
  outTimeMicros?: number
  outputBytes?: number
  speed?: number
  frame?: number
  terminal: boolean
}

export type ExtensionFfmpegResult = {
  generatedMedia: MediaHandleProjection[]
}

/** Core-only output transaction retained until the durable job terminal fence. */
export type ExtensionFfmpegOutputTransaction = ExtensionFfmpegResult & {
  commit(): Promise<void>
  rollback(): Promise<void>
}

export class ExtensionMediaFfmpegError extends Error {
  constructor(
    readonly code:
      | 'permission_denied'
      | 'invalid_argument'
      | 'output_alias'
      | 'output_limit'
      | 'invalid_output'
      | 'process_failed',
    message: string
  ) {
    super(message)
  }
}

export type PreparedOutput = {
  name: string
  handleId: string
  target: ResolvedMediaHandle
  stagingDirectory: string
  stagingPath: string
  backupPath: string
  source: 'ffmpeg' | 'text'
  textContent?: string
}

export type PromotedOutput = PreparedOutput & { hadTarget: boolean; promoted: boolean }

export class ExtensionMediaFfmpegService {
  private readonly maxOutputBytes: number
  private readonly maxInputs: number
  private readonly maxOutputs: number

  constructor(private readonly options: {
    handleService: ExtensionMediaHandleService
    processService: ExtensionMediaProcessService
    maxOutputBytes?: number
    maxInputs?: number
    maxOutputs?: number
  }) {
    this.maxOutputBytes = boundedInteger(
      options.maxOutputBytes,
      20 * 1024 * 1024 * 1024,
      1024,
      Number.MAX_SAFE_INTEGER
    )
    this.maxInputs = boundedInteger(options.maxInputs, 16, 1, 64)
    this.maxOutputs = boundedInteger(options.maxOutputs, 8, 1, 16)
  }

  async execute(
    principal: ExtensionPrincipal,
    request: ExtensionFfmpegRequest,
    options: {
      operationId?: string
      signal?: AbortSignal
      onProgress?: (progress: ExtensionFfmpegProgress) => void
    } = {}
  ): Promise<ExtensionFfmpegResult> {
    const transaction = await this.executeTransaction(principal, request, options)
    await transaction.commit()
    return { generatedMedia: transaction.generatedMedia }
  }

  /**
   * Runs and atomically promotes all outputs while keeping their prior target
   * bytes and handle state reversible. The durable media-job adapter commits
   * this transaction only after semantic probe/artifact validation wins its
   * terminal fence; every other outcome rolls it back.
   */
  async executeTransaction(
    principal: ExtensionPrincipal,
    request: ExtensionFfmpegRequest,
    options: {
      operationId?: string
      signal?: AbortSignal
      onProgress?: (progress: ExtensionFfmpegProgress) => void
    } = {}
  ): Promise<ExtensionFfmpegOutputTransaction> {
    requirePermissions(principal)
    const operationId = options.operationId ?? `ffmpeg_${randomUUID()}`
    const prepared = await this.prepare(principal, request, operationId)
    const controller = new AbortController()
    const cancelFromCaller = () => controller.abort()
    options.signal?.addEventListener('abort', cancelFromCaller, { once: true })
    if (options.signal?.aborted) controller.abort(options.signal.reason)
    let quotaExceeded = false
    let quotaCheckRunning = false
    const quotaTimer = setInterval(() => {
      if (quotaCheckRunning) return
      quotaCheckRunning = true
      void Promise.all(prepared.outputs.map(async (output) => {
        try {
          const bytes = await stagingDirectoryBytes(output.stagingDirectory, this.maxOutputBytes)
          if (bytes > this.maxOutputBytes) {
            quotaExceeded = true
            controller.abort()
          }
        } catch {
          // Missing staging outputs are normal while ffmpeg is starting.
        }
      })).finally(() => {
        quotaCheckRunning = false
      })
    }, 250)
    quotaTimer.unref?.()
    const progress = new FfmpegProgressParser(options.onProgress)
    let promotion: PromotedOutput[] | undefined
    let completion: MediaOutputCompletionTransaction | undefined
    let handedOff = false
    let preserveBackups = false
    try {
      assertNotCancelled(controller.signal)
      if (prepared.runFfmpeg) {
        const run = await this.options.processService.runFfmpegForCore(
          principal,
          prepared.arguments,
          { signal: controller.signal, onProgressChunk: (chunk) => progress.push(chunk) }
        )
        assertNotCancelled(controller.signal)
        progress.finish()
        if (run.exitCode !== 0) {
          throw new ExtensionMediaFfmpegError('process_failed', 'Media export failed')
        }
      }
      assertNotCancelled(controller.signal)
      await this.writeTextOutputs(prepared.outputs)
      await this.validateStagingOutputs(prepared.outputs)
      await this.reauthorizeOutputs(principal, prepared.outputs)
      assertNotCancelled(controller.signal)
      promotion = await promoteAll(prepared.outputs)
      assertNotCancelled(controller.signal)
      completion = await this.options.handleService.completeOutputsReversibly(
        principal,
        prepared.outputs.map((output) => ({
          handleId: output.handleId,
          reservationId: operationId
        })),
        { signal: controller.signal }
      )
      assertNotCancelled(controller.signal)
      const transaction = outputTransaction({
        principal,
        operationId,
        outputs: prepared.outputs,
        promotion,
        completion,
        handleService: this.options.handleService
      })
      handedOff = true
      return transaction
    } catch (error) {
      if (promotion !== undefined && !handedOff && !preserveBackups &&
        promotion.some((output) => output.promoted || output.hadTarget)) {
        const rolledBack = await rollbackPromotion(promotion)
        preserveBackups = !rolledBack
        if (!rolledBack) {
          throw new ExtensionMediaFfmpegError(
            'invalid_output',
            'Media export could not safely roll back its promoted outputs'
          )
        }
        if (completion !== undefined) await completion.rollback()
      }
      if (error instanceof PromotionRollbackError) {
        preserveBackups = true
        throw new ExtensionMediaFfmpegError(
          'invalid_output',
          'Media export could not safely roll back its promoted outputs'
        )
      }
      if (quotaExceeded) {
        throw new ExtensionMediaFfmpegError('output_limit', 'Media output exceeded its byte limit')
      }
      if (error instanceof ExtensionMediaProcessError && error.code === 'output_limit') {
        throw new ExtensionMediaFfmpegError('output_limit', 'Media process output exceeded its limit')
      }
      throw error
    } finally {
      clearInterval(quotaTimer)
      options.signal?.removeEventListener('abort', cancelFromCaller)
      await cleanupStaging(prepared.outputs)
      if (!handedOff) {
        if (!preserveBackups) await cleanupBackups(prepared.outputs)
        await Promise.all(prepared.outputs.map((output) =>
          this.options.handleService.releaseOutputReservation(principal, output.handleId, operationId)
        ))
      }
    }
  }

  /**
   * Reconciles filesystem and handle state left by an FFmpeg attempt whose
   * process disappeared with the prior Kun runtime. Paths are derived from the
   * persisted job id and output handles, so recovery never scans or guesses at
   * sibling files.
   */
  async rollbackInterruptedTransaction(
    principal: ExtensionPrincipal,
    request: ExtensionFfmpegRequest,
    operationId: string
  ): Promise<void> {
    requirePermissions(principal)
    const outputHandleIds = recoveryOutputHandleIds(request, this.maxInputs, this.maxOutputs)
    const pending: Array<{
      state: PendingMediaOutputTransaction
      stagingDirectory: string
      backupPath: string
    }> = []
    for (const handleId of outputHandleIds) {
      try {
        const state = await this.options.handleService.inspectOutputTransaction(
          principal,
          handleId,
          operationId
        )
        const paths = transactionPaths(state.absolutePath, operationId, handleId)
        pending.push({ state, ...paths })
      } catch (error) {
        if (error instanceof ExtensionMediaHandleError &&
          (error.code === 'handle_reserved' || error.code === 'not_found')) {
          continue
        }
        throw error
      }
    }
    if (pending.length === 0) return
    for (const output of pending) await rollbackInterruptedOutput(output)
    await this.options.handleService.rollbackOutputTransaction(
      principal,
      pending.map(({ state }) => state.handleId),
      operationId
    )
  }

  /** Finishes core-private output state after a completed job survives restart. */
  async commitRecoveredTransaction(
    principal: ExtensionPrincipal,
    request: ExtensionFfmpegRequest,
    operationId: string
  ): Promise<void> {
    requirePermissions(principal)
    const outputHandleIds = recoveryOutputHandleIds(request, this.maxInputs, this.maxOutputs)
    const provisionalHandleIds: string[] = []
    for (const handleId of outputHandleIds) {
      let pending: PendingMediaOutputTransaction | undefined
      let completed: CompletedMediaOutputRecovery
      try {
        pending = await this.options.handleService.inspectOutputTransaction(
          principal,
          handleId,
          operationId
        )
        if (!pending.completed || pending.completedIdentity === undefined) {
          throw new ExtensionMediaFfmpegError(
            'invalid_output',
            'Completed media job retained an unfinished output transaction'
          )
        }
        completed = {
          handleId,
          absolutePath: pending.absolutePath,
          completedIdentity: pending.completedIdentity
        }
        provisionalHandleIds.push(handleId)
      } catch (error) {
        if (!(error instanceof ExtensionMediaHandleError) ||
          (error.code !== 'handle_reserved' && error.code !== 'not_found')) {
          throw error
        }
        try {
          completed = await this.options.handleService.inspectCompletedOutput(principal, handleId)
        } catch (completedError) {
          if (completedError instanceof ExtensionMediaHandleError &&
            (completedError.code === 'handle_consumed' || completedError.code === 'not_found')) {
            continue
          }
          throw completedError
        }
      }
      const paths = transactionPaths(completed.absolutePath, operationId, handleId)
      await commitRecoveredOutput({ completed, pending, ...paths })
    }
    if (provisionalHandleIds.length > 0) {
      await this.options.handleService.commitOutputTransaction(
        principal,
        provisionalHandleIds,
        operationId
      )
    }
  }

  private async prepare(
    principal: ExtensionPrincipal,
    request: ExtensionFfmpegRequest,
    operationId: string
  ): Promise<{ arguments: string[]; outputs: PreparedOutput[]; runFfmpeg: boolean }> {
    const textOutputs = validateTextOutputs(request.textOutputs, this.maxOutputs)
    const runFfmpeg = validateRequestShape(
      request,
      textOutputs,
      this.maxInputs,
      this.maxOutputs
    )
    const inputs = new Map<string, ResolvedMediaHandle>()
    for (const [name, handleId] of Object.entries(request.inputs)) {
      const input = await this.options.handleService.resolve(principal, handleId, 'read')
      if (input.absolutePath.includes('%')) {
        throw invalidArgument('Media input names cannot contain FFmpeg pattern syntax')
      }
      inputs.set(name, input)
    }
    const outputs: PreparedOutput[] = []
    try {
      const allOutputBindings = [
        ...Object.entries(request.outputs).map(([name, handleId]) => ({
          name,
          handleId,
          source: 'ffmpeg' as const
        })),
        ...textOutputs.map((output) => ({ ...output, source: 'text' as const }))
      ]
      for (const binding of allOutputBindings) {
        const { name, handleId } = binding
        const target = await this.options.handleService.reserveOutput(principal, handleId, operationId)
        let extension: string
        try {
          extension = safeStagingExtension(target.absolutePath)
        } catch (error) {
          await this.options.handleService.releaseOutputReservation(principal, handleId, operationId)
          throw error
        }
        const paths = transactionPaths(target.absolutePath, operationId, handleId)
        outputs.push({
          name,
          handleId,
          target,
          stagingDirectory: paths.stagingDirectory,
          stagingPath: join(paths.stagingDirectory, `output${extension}`),
          backupPath: paths.backupPath,
          source: binding.source,
          ...(binding.source === 'text'
            ? { textContent: binding.content }
            : {})
        })
        if (binding.source === 'text' && target.mimeType !== binding.mimeType) {
          throw invalidArgument('Text output MIME type does not match its export target')
        }
        await mkdir(paths.stagingDirectory, { mode: 0o700 })
      }
      assertNoAliases([...inputs.values()], outputs.map((output) => output.target))
      const inputPaths = Object.fromEntries([...inputs].map(([name, handle]) => [name, handle.absolutePath]))
      const outputPaths = Object.fromEntries(outputs
        .filter((output) => output.source === 'ffmpeg')
        .map((output) => [output.name, output.stagingPath]))
      const substituted = runFfmpeg
        ? validateAndSubstituteFfmpegArguments(request.arguments, inputPaths, outputPaths)
        : []
      return {
        arguments: runFfmpeg
          ? [
              '-nostdin',
              '-hide_banner',
              '-nostats',
              '-progress', 'pipe:1',
              '-y',
              ...substituted
            ]
          : [],
        outputs,
        runFfmpeg
      }
    } catch (error) {
      await cleanupStaging(outputs)
      await Promise.all(outputs.map((output) =>
        this.options.handleService.releaseOutputReservation(principal, output.handleId, operationId)
      ))
      throw error
    }
  }

  private async validateStagingOutputs(outputs: PreparedOutput[]): Promise<void> {
    for (const output of outputs) {
      const entries = await readdir(output.stagingDirectory, { withFileTypes: true })
      if (entries.length !== 1 || entries[0]?.name !== basename(output.stagingPath) ||
        !entries[0].isFile() || entries[0].isSymbolicLink()) {
        throw new ExtensionMediaFfmpegError(
          'invalid_output',
          'Media export created undeclared output or sidecar files'
        )
      }
      let info
      try {
        info = await lstat(output.stagingPath)
      } catch {
        throw new ExtensionMediaFfmpegError('invalid_output', 'Media export did not create its declared output')
      }
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) {
        throw new ExtensionMediaFfmpegError('invalid_output', 'Media export output is not a regular non-empty file')
      }
      if (info.size > this.maxOutputBytes) {
        throw new ExtensionMediaFfmpegError('output_limit', 'Media output exceeded its byte limit')
      }
      const parentInfo = await lstat(output.stagingDirectory)
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.dev !== info.dev) {
        throw new ExtensionMediaFfmpegError('invalid_output', 'Media output crossed its approved filesystem boundary')
      }
    }
  }

  private async writeTextOutputs(outputs: PreparedOutput[]): Promise<void> {
    await Promise.all(outputs.flatMap((output) => output.source === 'text'
      ? [writeFile(output.stagingPath, output.textContent!, { encoding: 'utf8', flag: 'wx', mode: 0o600 })]
      : []))
  }

  private async reauthorizeOutputs(
    principal: ExtensionPrincipal,
    outputs: PreparedOutput[]
  ): Promise<void> {
    for (const output of outputs) {
      const current = await this.options.handleService.resolve(principal, output.handleId, 'write')
      if (current.absolutePath !== output.target.absolutePath ||
        !sameIdentity(current.identity, output.target.identity)) {
        throw new ExtensionMediaFfmpegError('invalid_output', 'Media export target changed while processing')
      }
    }
  }
}
