import { createHash } from 'node:crypto'
import { access, realpath, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { constants } from 'node:fs'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { terminateSpawnTree } from '../adapters/tool/builtin-tool-utils.js'
import type { ExtensionPrincipal } from './extension-agent-service.js'
import {
  ExtensionMediaHandleService,
  type ResolvedMediaHandle
} from './extension-media-handle-service.js'
import { ExtensionMediaProcessError, type MediaExecutableName, type MediaProbeMetadata } from './extension-media-process-service-contracts.js'

export function normalizeProbeJson(stdout: Buffer, input: ResolvedMediaHandle): MediaProbeMetadata {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.toString('utf8'))
  } catch {
    throw new ExtensionMediaProcessError('invalid_probe_output', 'Media probe returned invalid metadata')
  }
  if (!isRecord(parsed)) {
    throw new ExtensionMediaProcessError('invalid_probe_output', 'Media probe returned invalid metadata')
  }
  const rawFormat = isRecord(parsed.format) ? parsed.format : {}
  const formatNames = (boundedText(rawFormat.format_name, 4096) ?? '')
    .split(',')
    .map((value) => boundedText(value, 128))
    .filter((value): value is string => Boolean(value))
    .slice(0, 32)
  const formatLongName = boundedText(rawFormat.format_long_name, 256)
  const durationMicros = secondsToMicros(rawFormat.duration)
  const startTimeMicros = signedSecondsToMicros(rawFormat.start_time)
  const bitRate = positiveInteger(rawFormat.bit_rate, Number.MAX_SAFE_INTEGER)
  const rawStreams = Array.isArray(parsed.streams) ? parsed.streams.slice(0, 64) : []
  const streams = rawStreams.flatMap((value, fallbackIndex) => {
    if (!isRecord(value)) return []
    const index = nonnegativeInteger(value.index, fallbackIndex, 65_535)
    const kind = normalizedStreamKind(value.codec_type)
    const tags = isRecord(value.tags) ? value.tags : {}
    const disposition = isRecord(value.disposition) ? value.disposition : {}
    const frameRate = rational(value.avg_frame_rate) ?? rational(value.r_frame_rate)
    const stream: MediaProbeMetadata['streams'][number] = {
      index,
      kind,
      ...(boundedText(value.codec_name, 64) ? { codecName: boundedText(value.codec_name, 64) } : {}),
      ...(boundedText(value.codec_long_name, 256) ? { codecLongName: boundedText(value.codec_long_name, 256) } : {}),
      ...(rational(value.time_base) ? { timeBase: rational(value.time_base) } : {}),
      ...(frameRate ? { frameRate } : {}),
      ...(secondsToMicros(value.duration) !== undefined ? { durationMicros: secondsToMicros(value.duration) } : {}),
      ...(positiveInteger(value.width, 131_072) !== undefined ? { width: positiveInteger(value.width, 131_072) } : {}),
      ...(positiveInteger(value.height, 131_072) !== undefined ? { height: positiveInteger(value.height, 131_072) } : {}),
      ...(rotation(value, tags) !== undefined ? { rotationDegrees: rotation(value, tags) } : {}),
      ...(positiveInteger(value.channels, 1024) !== undefined ? { channelCount: positiveInteger(value.channels, 1024) } : {}),
      ...(positiveInteger(value.sample_rate, 10_000_000) !== undefined ? { sampleRate: positiveInteger(value.sample_rate, 10_000_000) } : {}),
      ...(boundedText(value.channel_layout, 128) ? { channelLayout: boundedText(value.channel_layout, 128) } : {}),
      ...(boundedText(tags.language, 32) ? { language: boundedText(tags.language, 32) } : {}),
      disposition: {
        default: booleanFlag(disposition.default) ?? false,
        forced: booleanFlag(disposition.forced) ?? false,
        attachedPicture: booleanFlag(disposition.attached_pic) ?? false
      }
    }
    return [stream]
  })
  return {
    schemaVersion: 1,
    handleId: input.id,
    container: {
      formatNames,
      ...(formatLongName ? { formatLongName } : {}),
      ...(durationMicros !== undefined ? { durationMicros } : {}),
      ...(startTimeMicros !== undefined ? { startTimeMicros } : {}),
      ...(bitRate !== undefined ? { bitRate } : {})
    },
    streams
  }
}

export function normalizedStreamKind(value: unknown): MediaProbeMetadata['streams'][number]['kind'] {
  return value === 'video' || value === 'audio' || value === 'subtitle' ||
    value === 'data' || value === 'attachment' ? value : 'unknown'
}

export function rational(value: unknown): { numerator: number; denominator: number } | undefined {
  const text = rationalText(value)
  if (!text) return undefined
  const [left, right] = text.split('/')
  const numerator = Number(left)
  const denominator = Number(right)
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) ||
    numerator < 0 || denominator <= 0) return undefined
  return { numerator, denominator }
}

export function rationalText(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{1,10}\/\d{1,10}$/u.test(value)) return undefined
  return value
}

export function secondsToMicros(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(number) || number < 0) return undefined
  const micros = Math.round(number * 1_000_000)
  return Number.isSafeInteger(micros) ? micros : undefined
}

export function signedSecondsToMicros(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(number)) return undefined
  const micros = Math.round(number * 1_000_000)
  return Number.isSafeInteger(micros) ? micros : undefined
}

export function rotation(stream: Record<string, unknown>, tags: Record<string, unknown>): number | undefined {
  const direct = typeof tags.rotate === 'string' || typeof tags.rotate === 'number' ? Number(tags.rotate) : Number.NaN
  if (Number.isInteger(direct) && direct >= -359 && direct <= 359) return direct
  if (!Array.isArray(stream.side_data_list)) return undefined
  for (const value of stream.side_data_list.slice(0, 16)) {
    if (!isRecord(value)) continue
    const candidate = typeof value.rotation === 'number' ? value.rotation : Number(value.rotation)
    if (Number.isInteger(candidate) && candidate >= -359 && candidate <= 359) return candidate
  }
  return undefined
}

export function positiveInteger(value: unknown, max: number): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isSafeInteger(number) && number >= 0 && number <= max ? number : undefined
}

export function nonnegativeInteger(value: unknown, fallback: number, max: number): number {
  return positiveInteger(value, max) ?? fallback
}

export function booleanFlag(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === '1') return true
  if (value === false || value === 0 || value === '0') return false
  return undefined
}

export function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = [...value.trim()].filter((character) => {
    const code = character.charCodeAt(0)
    return code > 31 && code !== 127
  }).join('')
  return text ? text.slice(0, max) : undefined
}

export function boundedVersion(line: string, name: MediaExecutableName): string | undefined {
  const match = line.match(new RegExp(`^${name} version ([^\\s]+)`, 'u'))
  return match?.[1]?.slice(0, 64)
}

export function requireProcessPermission(principal: ExtensionPrincipal): void {
  if (!principal.permissions.includes('media.process')) {
    throw new ExtensionMediaProcessError('permission_denied', 'Missing permission: media.process')
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value!)))
}
