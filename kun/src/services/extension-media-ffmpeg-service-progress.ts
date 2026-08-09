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
import { type ExtensionFfmpegProgress, ExtensionMediaFfmpegError } from './extension-media-ffmpeg-service-core.js'

export class FfmpegProgressParser {
  private buffer = ''
  private latest: Record<string, string> = {}
  private lastEmitAt = 0

  constructor(private readonly emit?: (progress: ExtensionFfmpegProgress) => void) {}

  push(chunk: Buffer): void {
    this.buffer = (this.buffer + chunk.toString('utf8')).slice(-16_384)
    const lines = this.buffer.split(/\r?\n/u)
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      const separator = line.indexOf('=')
      if (separator <= 0 || separator > 64 || line.length > 4096) continue
      this.latest[line.slice(0, separator)] = line.slice(separator + 1, 1024)
      if (line.startsWith('progress=')) this.flush(line === 'progress=end')
    }
  }

  finish(): void {
    this.flush(true)
  }

  private flush(terminal: boolean): void {
    const now = Date.now()
    if (!terminal && now - this.lastEmitAt < 100) return
    this.lastEmitAt = now
    this.emit?.({
      ...(integer(this.latest.out_time_us) !== undefined
        ? { outTimeMicros: integer(this.latest.out_time_us) }
        : {}),
      ...(integer(this.latest.total_size) !== undefined
        ? { outputBytes: integer(this.latest.total_size) }
        : {}),
      ...(integer(this.latest.frame) !== undefined ? { frame: integer(this.latest.frame) } : {}),
      ...(speed(this.latest.speed) !== undefined ? { speed: speed(this.latest.speed) } : {}),
      terminal
    })
  }
}

export function integer(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

export function speed(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value.replace(/x$/u, ''))
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100_000 ? parsed : undefined
}

export function requirePermissions(principal: ExtensionPrincipal): void {
  for (const permission of ['media.read', 'media.process', 'media.export', 'workspace.read', 'workspace.write']) {
    if (!principal.permissions.includes(permission)) {
      throw new ExtensionMediaFfmpegError('permission_denied', `Missing permission: ${permission}`)
    }
  }
  if (!principal.workspaceTrusted) {
    throw new ExtensionMediaFfmpegError('permission_denied', 'Workspace is not trusted')
  }
}

export function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ExtensionMediaProcessError('process_cancelled', 'Media process was cancelled')
  }
}

export function invalidArgument(message: string): ExtensionMediaFfmpegError {
  return new ExtensionMediaFfmpegError('invalid_argument', message)
}

export function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value!)))
}
