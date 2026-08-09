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
import { type ExtensionFfmpegOutputTransaction, type ExtensionFfmpegRequest, ExtensionMediaFfmpegError, type PreparedOutput, type PromotedOutput } from './extension-media-ffmpeg-service-core.js'
import { validateRequestShape, validateTextOutputs } from './extension-media-ffmpeg-service-argument-validation.js'
import { invalidArgument } from './extension-media-ffmpeg-service-progress.js'

export function recoveryOutputHandleIds(
  request: ExtensionFfmpegRequest,
  maxInputs: number,
  maxOutputs: number
): string[] {
  const textOutputs = validateTextOutputs(request.textOutputs, maxOutputs)
  validateRequestShape(request, textOutputs, maxInputs, maxOutputs)
  const handleIds = [
    ...Object.values(request.outputs),
    ...textOutputs.map(({ handleId }) => handleId)
  ]
  if (new Set(handleIds).size !== handleIds.length) {
    throw new ExtensionMediaFfmpegError('output_alias', 'Media outputs must be distinct')
  }
  return handleIds
}

export function transactionPaths(
  absolutePath: string,
  operationId: string,
  handleId: string
): { stagingDirectory: string; backupPath: string } {
  const token = createHash('sha256')
    .update('kun-media-output\0', 'utf8')
    .update(operationId, 'utf8')
    .update('\0', 'utf8')
    .update(handleId, 'utf8')
    .digest('hex')
    .slice(0, 32)
  return {
    stagingDirectory: join(dirname(absolutePath), `.kun-media-${token}.kun-stage`),
    backupPath: join(dirname(absolutePath), `.${basename(absolutePath)}.${token}.kun-backup`)
  }
}

export async function rollbackInterruptedOutput(output: {
  state: PendingMediaOutputTransaction
  stagingDirectory: string
  backupPath: string
}): Promise<void> {
  const { state } = output
  const backup = await lstatIfPresent(output.backupPath)
  const target = await lstatIfPresent(state.absolutePath)
  if (backup !== undefined) {
    if (!state.hadTarget || !backup.isFile() || backup.isSymbolicLink() ||
      state.originalIdentity === undefined || !sameStatIdentity(backup, state.originalIdentity)) {
      throw new ExtensionMediaFfmpegError(
        'invalid_output',
        'Interrupted media export backup could not be authenticated'
      )
    }
    if (target !== undefined) {
      if (!target.isFile() || target.isSymbolicLink()) {
        throw new ExtensionMediaFfmpegError(
          'invalid_output',
          'Interrupted media export target could not be restored safely'
        )
      }
      await rm(state.absolutePath)
    }
    await rename(output.backupPath, state.absolutePath)
  } else if (state.hadTarget) {
    if (target === undefined || !target.isFile() || target.isSymbolicLink() ||
      state.originalIdentity === undefined || !sameStatIdentity(target, state.originalIdentity)) {
      throw new ExtensionMediaFfmpegError(
        'invalid_output',
        'Interrupted media export lost its authenticated prior target'
      )
    }
  } else if (target !== undefined) {
    if (!target.isFile() || target.isSymbolicLink() ||
      (state.completedIdentity !== undefined &&
        !sameStatIdentity(target, state.completedIdentity))) {
      throw new ExtensionMediaFfmpegError(
        'invalid_output',
        'Interrupted media export target could not be removed safely'
      )
    }
    await rm(state.absolutePath)
  }
  await rm(output.stagingDirectory, { recursive: true, force: true })
}

export async function commitRecoveredOutput(output: {
  completed: CompletedMediaOutputRecovery
  pending?: PendingMediaOutputTransaction
  stagingDirectory: string
  backupPath: string
}): Promise<void> {
  const target = await lstatIfPresent(output.completed.absolutePath)
  if (target === undefined || !target.isFile() || target.isSymbolicLink() ||
    !sameStatIdentity(target, output.completed.completedIdentity)) {
    throw new ExtensionMediaFfmpegError(
      'invalid_output',
      'Recovered completed media output no longer matches its recorded identity'
    )
  }
  const backup = await lstatIfPresent(output.backupPath)
  if (backup !== undefined) {
    if (!backup.isFile() || backup.isSymbolicLink() ||
      (output.pending !== undefined &&
        (!output.pending.hadTarget || output.pending.originalIdentity === undefined ||
          !sameStatIdentity(backup, output.pending.originalIdentity)))) {
      throw new ExtensionMediaFfmpegError(
        'invalid_output',
        'Recovered completed media backup could not be authenticated'
      )
    }
    await rm(output.backupPath)
  }
  await rm(output.stagingDirectory, { recursive: true, force: true })
}

export async function lstatIfPresent(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export function sameStatIdentity(
  info: Awaited<ReturnType<typeof lstat>>,
  identity: NonNullable<PendingMediaOutputTransaction['originalIdentity']>
): boolean {
  return matchesFileIdentity(identity, fileIdentityFromStat(info))
}

export function safeStagingExtension(path: string): string {
  const extension = extname(path)
  if (extension && !/^\.[a-z0-9]{1,12}$/iu.test(extension)) {
    throw invalidArgument('Media output extension contains unsupported pattern syntax')
  }
  return extension.toLowerCase()
}

export function assertNoAliases(inputs: ResolvedMediaHandle[], outputs: ResolvedMediaHandle[]): void {
  for (let index = 0; index < outputs.length; index += 1) {
    const output = outputs[index]!
    for (const input of inputs) {
      if (sameFile(input, output)) {
        throw new ExtensionMediaFfmpegError('output_alias', 'Media output cannot alias an input')
      }
    }
    for (const other of outputs.slice(0, index)) {
      if (sameFile(other, output)) {
        throw new ExtensionMediaFfmpegError('output_alias', 'Media outputs must be distinct')
      }
    }
  }
}

export function sameFile(left: ResolvedMediaHandle, right: ResolvedMediaHandle): boolean {
  return left.absolutePath === right.absolutePath ||
    Boolean(left.identity && right.identity && identifiesSameFile(left.identity, right.identity))
}

export function sameIdentity(
  left: ResolvedMediaHandle['identity'],
  right: ResolvedMediaHandle['identity']
): boolean {
  if (!left || !right) return left === right
  return matchesFileIdentity(left, right)
}

export function outputTransaction(input: {
  principal: ExtensionPrincipal
  operationId: string
  outputs: PreparedOutput[]
  promotion: PromotedOutput[]
  completion: MediaOutputCompletionTransaction
  handleService: ExtensionMediaHandleService
}): ExtensionFfmpegOutputTransaction {
  let state: 'pending' | 'committed' | 'rolled-back' = 'pending'
  let transition = Promise.resolve()
  const serialize = async (
    target: 'committed' | 'rolled-back',
    operation: () => Promise<void>
  ): Promise<void> => {
    const prior = transition
    let release!: () => void
    transition = new Promise<void>((resolvePromise) => { release = resolvePromise })
    await prior
    try {
      if (state === target) return
      if (state !== 'pending') {
        throw new ExtensionMediaFfmpegError(
          'invalid_output',
          'Media output transaction already reached another terminal state'
        )
      }
      await operation()
      state = target
    } finally {
      release()
    }
  }
  const releaseReservations = async () => {
    await Promise.all(input.outputs.map((output) =>
      input.handleService.releaseOutputReservation(
        input.principal,
        output.handleId,
        input.operationId
      )
    ))
  }
  return {
    generatedMedia: input.completion.generatedMedia,
    commit: () => serialize('committed', async () => {
      await input.completion.commit()
      // A valid completed target is authoritative. Backup deletion failure is
      // safe (and recoverable cleanup), so it must not turn a completed export
      // into a failed job after the durable terminal fence has won.
      await cleanupBackups(input.outputs).catch(() => undefined)
    }),
    rollback: () => serialize('rolled-back', async () => {
      const restored = await rollbackPromotion(input.promotion)
      if (!restored) {
        throw new ExtensionMediaFfmpegError(
          'invalid_output',
          'Media export could not safely restore its prior targets'
        )
      }
      await input.completion.rollback()
      await releaseReservations()
      await cleanupBackups(input.outputs)
    })
  }
}

export class PromotionRollbackError extends Error {}

export async function promoteAll(outputs: PreparedOutput[]): Promise<PromotedOutput[]> {
  const prepared: PromotedOutput[] = []
  try {
    for (const output of outputs) {
      let hadTarget = false
      try {
        const target = await lstat(output.target.absolutePath)
        if (!target.isFile() || target.isSymbolicLink()) {
          throw new ExtensionMediaFfmpegError('invalid_output', 'Media export target is no longer a regular file')
        }
        if (!output.target.identity || !sameIdentity(
          output.target.identity,
          fileIdentityFromStat(target)
        )) {
          throw new ExtensionMediaFfmpegError('invalid_output', 'Media export target changed before promotion')
        }
        await rename(output.target.absolutePath, output.backupPath)
        hadTarget = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (output.target.identity) {
          throw new ExtensionMediaFfmpegError('invalid_output', 'Media export target disappeared before promotion')
        }
      }
      const item = { ...output, hadTarget, promoted: false }
      prepared.push(item)
      await rename(output.stagingPath, output.target.absolutePath)
      item.promoted = true
    }
    return prepared
  } catch (error) {
    if (!await rollbackPromotion(prepared)) {
      throw new PromotionRollbackError('Media export promotion could not be safely rolled back')
    }
    throw error
  }
}

export async function rollbackPromotion(outputs: PromotedOutput[]): Promise<boolean> {
  let complete = true
  for (const output of [...outputs].reverse()) {
    if (output.promoted) {
      try {
        await rm(output.target.absolutePath, { force: true })
        output.promoted = false
      } catch {
        complete = false
        continue
      }
    }
    if (output.hadTarget) {
      try {
        await rename(output.backupPath, output.target.absolutePath)
        output.hadTarget = false
      } catch {
        complete = false
      }
    }
  }
  return complete
}

export async function cleanupBackups(outputs: PreparedOutput[]): Promise<void> {
  await Promise.all(outputs.map((output) => rm(output.backupPath, { force: true })))
}

export async function cleanupStaging(outputs: PreparedOutput[]): Promise<void> {
  await Promise.all(outputs.map((output) =>
    rm(output.stagingDirectory, { recursive: true, force: true })
  ))
}

export async function stagingDirectoryBytes(path: string, limit: number): Promise<number> {
  const pending = [path]
  let bytes = 0
  let entriesSeen = 0
  while (pending.length > 0) {
    const directory = pending.pop()!
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entriesSeen += 1
      if (entriesSeen > 128) return limit + 1
      const entryPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(entryPath)
        continue
      }
      if (!entry.isFile() || entry.isSymbolicLink()) return limit + 1
      bytes += (await stat(entryPath)).size
      if (bytes > limit) return bytes
    }
  }
  return bytes
}
