import { net } from 'electron'
import type { ClawImTelegramConnectErrorCode } from '../shared/kun-gui-api'
import type { JsonSettingsStore } from './settings-store'

export const TELEGRAM_API_BASE = 'https://api.telegram.org'
export const POLL_TIMEOUT_SECONDS = 25
export const POLL_HTTP_TIMEOUT_MS = (POLL_TIMEOUT_SECONDS + 10) * 1000
export const MAX_MESSAGE_LENGTH = 4096
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024 // 20 MB
export const MIN_BACKOFF_MS = 1500
export const MAX_BACKOFF_MS = 30_000
export const BACKOFF_JITTER_MS = 250

/** Telegram chat types that represent multi-party conversations. */
export const GROUP_CHAT_TYPES = new Set(['group', 'supergroup', 'channel'])

export function telegramFetch(input: string, init?: RequestInit): Promise<Response> {
  return typeof net.fetch === 'function'
    ? net.fetch(input, init)
    : fetch(input, init)
}

export type TelegramLogFn = (category: string, message: string, detail?: unknown) => void

/**
 * Normalized inbound payload handed to {@link ClawRuntime.handleTelegramUpdate}.
 * Image messages carry a downloaded `localFilePath`; the agent runtime picks
 * it up via the same contract as Feishu/WeChat attachments.
 */
export type TelegramInboundPayload = {
  channelId: string
  chatId: string
  messageId: string
  senderId: string
  senderName: string
  /** Text to forward to the agent (message text + image caption). */
  text: string
  /** Downloaded image path, if the message was a photo and download succeeded. */
  localFilePath?: string
  /** The Telegram update_id, for deduplication and offset tracking. */
  updateId: number
}

export type TelegramRuntimeDeps = {
  store: JsonSettingsStore
  logError: TelegramLogFn
  onInbound: (payload: TelegramInboundPayload) => void | Promise<void>
}

export type TelegramChat = {
  id: number
  type?: string
  first_name?: string
  last_name?: string
  username?: string
  title?: string
}

export type TelegramUser = {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}

export type TelegramMessage = {
  message_id: number
  date?: number
  chat: TelegramChat
  from?: TelegramUser
  text?: string
  caption?: string
  photo?: Array<{ file_id: string; file_size?: number; width?: number; height?: number }>
  document?: { file_id: string; file_size?: number; file_name?: string }
}

export type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  channel_post?: TelegramMessage
}

export type TelegramApiResponse<T> = {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
  parameters?: { retry_after?: number; migrate_to_chat_id?: number }
}

export type TelegramFile = {
  file_id: string
  file_unique_id?: string
  file_size?: number
  file_path?: string
}

export type TelegramBotInfo = {
  id: number
  username: string
  first_name?: string
  can_join_groups?: boolean
}

export type TelegramVerifyResult =
  | { ok: true; botId: number; botUsername: string; botFirstName: string }
  | { ok: false; code: ClawImTelegramConnectErrorCode; message: string }

/** A single bot connection with its own poll loop and offset state. */
export function isGroupChat(chat: TelegramChat): boolean {
  if (chat.id < 0) return true
  return typeof chat.type === 'string' && GROUP_CHAT_TYPES.has(chat.type)
}

export function senderDisplayName(user: TelegramUser | undefined): string {
  if (!user) return ''
  const first = (user.first_name ?? '').trim()
  const last = (user.last_name ?? '').trim()
  const full = `${first} ${last}`.trim()
  return full || (user.username ?? '').trim()
}

/**
 * Parses a comma-separated allowlist of Telegram chat ids. Duplicates and
 * non-numeric entries are dropped. An empty result means "allow all private
 * chats" (group chats are already rejected upstream).
 */
export function parseAllowedChatIds(raw: string): Set<number> {
  const set = new Set<number>()
  if (typeof raw !== 'string') return set
  for (const part of raw.split(/[\s,]+/)) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const id = Number(trimmed)
    if (!Number.isFinite(id) || id <= 0) continue
    set.add(id)
  }
  return set
}

export function inferImageExtension(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'jpg' || ext === 'jpeg' || ext === 'png' || ext === 'gif' || ext === 'webp') return ext
  return 'jpg'
}

/**
 * Splits text into chunks that fit Telegram's 4096-char limit, preferring
 * paragraph then line breaks so replies stay readable.
 */
export function splitForTelegram(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > MAX_MESSAGE_LENGTH) {
    let cut = remaining.lastIndexOf('\n\n', MAX_MESSAGE_LENGTH)
    if (cut <= 0) cut = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH)
    if (cut <= 0) cut = remaining.lastIndexOf('. ', MAX_MESSAGE_LENGTH)
    if (cut <= 0) cut = MAX_MESSAGE_LENGTH
    chunks.push(remaining.slice(0, cut).trimEnd())
    remaining = remaining.slice(cut).trimStart()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    const onAbort = (): void => finish()
    function finish(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
