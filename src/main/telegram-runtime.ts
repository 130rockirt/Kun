import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { AppSettingsV1, ClawImChannelV1 } from '../shared/app-settings'
import {
  BACKOFF_JITTER_MS,
  inferImageExtension,
  isGroupChat,
  MAX_BACKOFF_MS,
  MAX_DOWNLOAD_BYTES,
  MIN_BACKOFF_MS,
  parseAllowedChatIds,
  POLL_HTTP_TIMEOUT_MS,
  POLL_TIMEOUT_SECONDS,
  senderDisplayName,
  sleep,
  splitForTelegram,
  TELEGRAM_API_BASE,
  telegramFetch,
  type TelegramApiResponse,
  type TelegramBotInfo,
  type TelegramFile,
  type TelegramInboundPayload,
  type TelegramLogFn,
  type TelegramMessage,
  type TelegramRuntimeDeps,
  type TelegramUpdate,
  type TelegramVerifyResult
} from './telegram-runtime-support'

export { parseAllowedChatIds } from './telegram-runtime-support'
export type {
  TelegramInboundPayload,
  TelegramLogFn,
  TelegramRuntimeDeps,
  TelegramVerifyResult
} from './telegram-runtime-support'

class TelegramChannel {
  private abort: AbortController | null = null
  private running = false
  private pollTask: Promise<void> | null = null
  private readonly inboundTasks = new Set<Promise<void>>()
  private offset = 0
  private consecutiveErrors = 0

  constructor(
    private readonly channelId: string,
    private readonly token: string,
    private readonly allowedChatIds: ReadonlySet<number>,
    private readonly deps: { logError: TelegramLogFn; onInbound: (payload: TelegramInboundPayload) => void | Promise<void> }
  ) {}

  get id(): string {
    return this.channelId
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.abort = new AbortController()
    const task = this.pollLoop().catch((error) => {
      if (!this.running) return
      this.deps.logError('claw-telegram', 'Telegram poll loop stopped unexpectedly.', {
        channelId: this.channelId,
        message: error instanceof Error ? error.message : String(error)
      })
    })
    this.pollTask = task
    void task.finally(() => {
      if (this.pollTask === task) this.pollTask = null
    })
  }

  async stop(): Promise<void> {
    this.running = false
    const controller = this.abort
    controller?.abort()
    const pollTask = this.pollTask
    if (pollTask) await Promise.allSettled([pollTask])
    while (this.inboundTasks.size > 0) {
      await Promise.allSettled([...this.inboundTasks])
    }
    if (this.abort === controller) this.abort = null
  }

  /**
   * Sends a plain text message (no parse mode) to a chat. Used for agent
   * replies that are forwarded verbatim. Splits long text at the Telegram
   * 4096-char limit with paragraph/line awareness.
   */
  async sendMessage(chatId: string, text: string): Promise<{ ok: true; messageId?: number } | { ok: false; message: string }> {
    const trimmed = text.trim()
    if (!trimmed) return { ok: true }
    const chunks = splitForTelegram(trimmed)
    let lastMessageId: number | undefined
    for (const chunk of chunks) {
      const result = await this.callApi<{ message_id: number }>('sendMessage', {
        chat_id: chatId,
        text: chunk,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
      if (!result.ok) {
        // HTML parse failure is common with agent output; retry the chunk as
        // plain text so the user still gets a reply instead of an error.
        const fallback = await this.callApi<{ message_id: number }>('sendMessage', {
          chat_id: chatId,
          text: chunk,
          disable_web_page_preview: true
        })
        if (!fallback.ok) return { ok: false, message: fallback.message }
        lastMessageId = fallback.result?.message_id
        continue
      }
      lastMessageId = result.result?.message_id
    }
    return { ok: true, messageId: lastMessageId }
  }

  async sendFile(
    chatId: string,
    filePath: string,
    fileName?: string
  ): Promise<{ ok: true; messageId?: number } | { ok: false; message: string }> {
    try {
      const buffer = await readFile(filePath)
      const form = new FormData()
      form.append('chat_id', chatId)
      form.append('document', new Blob([new Uint8Array(buffer)]), fileName?.trim() || basename(filePath) || 'attachment')
      const res = await telegramFetch(`${TELEGRAM_API_BASE}/bot${this.token}/sendDocument`, {
        method: 'POST',
        body: form,
        signal: this.abort?.signal
      })
      const data = (await res.json().catch(() => null)) as TelegramApiResponse<{ message_id: number }> | null
      if (!data) return { ok: false, message: `HTTP ${res.status}: empty body` }
      if (!data.ok) return { ok: false, message: data.description || `HTTP ${res.status}` }
      return { ok: true, messageId: data.result?.message_id }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), POLL_HTTP_TIMEOUT_MS)
      // Chain to the outer stop signal so a settings change tears the loop down promptly.
      const stopWatcher = () => controller.abort()
      this.abort?.signal.addEventListener('abort', stopWatcher, { once: true })
      try {
        const response = await this.callApi<TelegramUpdate[]>('getUpdates', {
          offset: this.offset || undefined,
          timeout: POLL_TIMEOUT_SECONDS,
          allowed_updates: ['message']
        }, controller.signal)
        if (!this.running) break
        if (!response.ok) {
          await this.handlePollError(response)
          continue
        }
        this.consecutiveErrors = 0
        const updates = Array.isArray(response.result) ? response.result : []
        for (const update of updates) {
          if (!this.running) break
          this.offset = update.update_id + 1
          this.dispatchUpdate(update)
        }
      } catch (error) {
        if (!this.running) break
        await this.handlePollException(error)
      } finally {
        clearTimeout(timeout)
        this.abort?.signal.removeEventListener('abort', stopWatcher)
      }
    }
  }

  /**
   * Dispatches a single update synchronously into the inbound handler.
   * Fire-and-forget: the agent loop runs independently; errors here only log.
   */
  private dispatchUpdate(update: TelegramUpdate): void {
    if (!this.running) return
    const message = update.message ?? update.edited_message
    if (!message) return
    const chat = message.chat
    if (!chat) return
    // Block multi-party chats: the bot is personal-only.
    if (isGroupChat(chat)) return
    if (!this.isChatAllowed(chat.id)) return
    const sender = message.from
    const senderId = sender ? String(sender.id) : String(chat.id)
    const senderName = senderDisplayName(sender) || String(chat.id)
    const text = (message.text ?? '').trim()
    const caption = (message.caption ?? '').trim()
    const photo = Array.isArray(message.photo) && message.photo.length > 0 ? message.photo : undefined

    const payload: TelegramInboundPayload = {
      channelId: this.channelId,
      chatId: String(chat.id),
      messageId: String(message.message_id),
      senderId,
      senderName,
      text: caption || text,
      updateId: update.update_id
    }

    if (!payload.text && !photo) return

    const task = (async () => {
      if (photo) {
        const downloaded = await this.downloadLargestPhoto(photo, chat.id, message.message_id)
        if (downloaded) payload.localFilePath = downloaded
        if (!payload.text) payload.text = '[image]'
      }
      if (!this.running) return
      await this.deps.onInbound(payload)
    })().catch((error) => {
      this.deps.logError('claw-telegram', 'Inbound handler threw for a Telegram update.', {
        channelId: this.channelId,
        chatId: payload.chatId,
        message: error instanceof Error ? error.message : String(error)
      })
    })
    this.inboundTasks.add(task)
    void task.finally(() => this.inboundTasks.delete(task))
  }

  private isChatAllowed(chatId: number): boolean {
    if (this.allowedChatIds.size === 0) return true
    return this.allowedChatIds.has(chatId)
  }

  private async downloadLargestPhoto(
    photo: NonNullable<TelegramMessage['photo']>,
    chatId: number,
    messageId: number
  ): Promise<string | undefined> {
    // Telegram sends multiple thumbnail sizes; pick the largest.
    const largest = [...photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0]
    if (!largest?.file_id) return undefined
    if (largest.file_size && largest.file_size > MAX_DOWNLOAD_BYTES) {
      this.deps.logError('claw-telegram', 'Skipping inbound Telegram photo: exceeds the 20 MB cap.', {
        channelId: this.channelId,
        chatId,
        messageId,
        bytes: largest.file_size
      })
      return undefined
    }
    try {
      const fileMeta = await this.callApi<TelegramFile>('getFile', { file_id: largest.file_id })
      if (!fileMeta.ok) {
        this.deps.logError('claw-telegram', 'Telegram getFile failed while downloading an inbound photo.', {
          channelId: this.channelId,
          chatId,
          message: fileMeta.message
        })
        return undefined
      }
      if (!fileMeta.result?.file_path) {
        this.deps.logError('claw-telegram', 'Telegram getFile returned no file_path.', {
          channelId: this.channelId,
          chatId
        })
        return undefined
      }
      const downloadUrl = `${TELEGRAM_API_BASE}/file/bot${this.token}/${fileMeta.result.file_path}`
      const timeoutSignal = AbortSignal.timeout(30_000)
      const signal = this.abort
        ? AbortSignal.any([this.abort.signal, timeoutSignal])
        : timeoutSignal
      const res = await telegramFetch(downloadUrl, { signal })
      if (!res.ok) {
        this.deps.logError('claw-telegram', 'Telegram file download returned a non-OK status.', {
          channelId: this.channelId,
          chatId,
          status: res.status
        })
        return undefined
      }
      const buffer = Buffer.from(await res.arrayBuffer())
      if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
        this.deps.logError('claw-telegram', 'Downloaded Telegram photo exceeds the 20 MB cap.', {
          channelId: this.channelId,
          chatId,
          bytes: buffer.byteLength
        })
        return undefined
      }
      const ext = inferImageExtension(fileMeta.result.file_path)
      const dir = join(tmpdir(), 'kun-telegram-attachments')
      await mkdir(dir, { recursive: true })
      const fileName = `tg-${chatId}-${messageId}-${createHash('sha1').update(largest.file_id).digest('hex').slice(0, 10)}.${ext}`
      const filePath = join(dir, fileName)
      await writeFile(filePath, buffer)
      // Resolve to the real path so the workspace-escape check in ClawRuntime sees the final location.
      return realpath(filePath).catch(() => filePath)
    } catch (error) {
      this.deps.logError('claw-telegram', 'Failed to download an inbound Telegram photo.', {
        channelId: this.channelId,
        chatId,
        message: error instanceof Error ? error.message : String(error)
      })
      return undefined
    }
  }

  private async handlePollError(response: { ok: false; message: string; retryAfterMs?: number }): Promise<void> {
    this.consecutiveErrors += 1
    this.deps.logError('claw-telegram', 'Telegram getUpdates failed.', {
      channelId: this.channelId,
      message: response.message,
      retryAfterMs: response.retryAfterMs
    })
    const wait = response.retryAfterMs
      ? Math.min(MAX_BACKOFF_MS, response.retryAfterMs)
      : this.nextBackoff()
    await sleep(wait, this.abort?.signal)
  }

  private async handlePollException(error: unknown): Promise<void> {
    if (!this.running) return
    this.consecutiveErrors += 1
    this.deps.logError('claw-telegram', 'Telegram poll loop caught an exception.', {
      channelId: this.channelId,
      message: error instanceof Error ? error.message : String(error)
    })
    await sleep(this.nextBackoff(), this.abort?.signal)
  }

  /** Exponential backoff with jitter, clamped to [1.5s, 30s]. */
  private nextBackoff(): number {
    const exponent = Math.min(this.consecutiveErrors, 6)
    const base = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** exponent)
    return Math.max(MIN_BACKOFF_MS, base - Math.floor(Math.random() * BACKOFF_JITTER_MS))
  }

  private async callApi<T>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ ok: true; result?: T } | { ok: false; message: string; retryAfterMs?: number }> {
    const url = `${TELEGRAM_API_BASE}/bot${this.token}/${method}`
    try {
      const res = await telegramFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ?? this.abort?.signal
      })
      const data = (await res.json().catch(() => null)) as TelegramApiResponse<T> | null
      if (!data) {
        return { ok: false, message: `HTTP ${res.status}: empty body` }
      }
      if (!data.ok) {
        const retryAfter = data.parameters?.retry_after
        return {
          ok: false,
          message: data.description || `HTTP ${res.status}`,
          retryAfterMs: typeof retryAfter === 'number' ? retryAfter * 1000 : undefined
        }
      }
      return { ok: true, result: data.result }
    } catch (error) {
      if (!this.running && method === 'getUpdates') {
        // Aborted during shutdown — not a real error.
        return { ok: false, message: 'aborted' }
      }
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }
}

export type TelegramRuntime = {
  /** Reconciles running channels against the current settings. */
  sync(settings: AppSettingsV1): void
  /** Stops every running channel. */
  stop(): Promise<void>
  /** Whether a channel is currently connected and can push outbound messages. */
  has(channelId: string): boolean
  /** Sends a text reply through the channel owning this bot. */
  sendMessage(channelId: string, chatId: string, text: string): Promise<{ ok: true } | { ok: false; message: string }>
  /** Sends a local file through the channel owning this bot. */
  sendFile(channelId: string, chatId: string, filePath: string, fileName?: string): Promise<{ ok: true } | { ok: false; message: string }>
}

/**
 * Verifies a bot token by calling `getMe`. Exposed as a standalone function
 * so the IPC handler can validate user input before a channel is ever written
 * to the settings store.
 */
export async function verifyTelegramBotToken(botToken: string): Promise<TelegramVerifyResult> {
  const token = botToken.trim()
  if (!token || !/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
    return {
      ok: false,
      code: 'invalid_format',
      message: 'Invalid token format. Expected "<numeric-id>:<35+ chars>".'
    }
  }
  const url = `${TELEGRAM_API_BASE}/bot${token}/getMe`
  try {
    const res = await telegramFetch(url, { signal: AbortSignal.timeout(15_000) })
    const data = (await res.json().catch(() => null)) as TelegramApiResponse<TelegramBotInfo> | null
    if (!data || !data.ok || !data.result) {
      return {
        ok: false,
        code: 'rejected',
        message: data?.description || `Telegram rejected the token (HTTP ${res.status}).`
      }
    }
    return {
      ok: true,
      botId: data.result.id,
      botUsername: data.result.username,
      botFirstName: data.result.first_name ?? data.result.username
    }
  } catch (error) {
    return {
      ok: false,
      code: 'network',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

export function createTelegramRuntime(deps: TelegramRuntimeDeps): TelegramRuntime {
  const channels = new Map<string, TelegramChannel>()
  const channelKeys = new Map<string, string>()
  const syncTasks = new Set<Promise<void>>()
  let syncVersion = 0
  let stopped = false
  let stopPromise: Promise<void> | null = null

  function resolveTargets(settings: AppSettingsV1): Array<{ channel: ClawImChannelV1; token: string; allowed: Set<number> }> {
    if (!settings.claw.enabled || !settings.claw.im.enabled) return []
    const targets: Array<{ channel: ClawImChannelV1; token: string; allowed: Set<number> }> = []
    for (const channel of settings.claw.channels) {
      if (!channel.enabled || channel.provider !== 'telegram') continue
      const credential = channel.platformCredential
      if (credential?.kind !== 'telegram') continue
      const token = credential.botToken.trim()
      if (!token) continue
      targets.push({
        channel,
        token,
        allowed: parseAllowedChatIds(credential.allowedChatIds)
      })
    }
    return targets
  }

  function buildKey(channel: ClawImChannelV1, token: string, allowed: Set<number>): string {
    const sortedAllowed = [...allowed].sort((a, b) => a - b).join(',')
    return `${channel.id}|${token}|${sortedAllowed}`
  }

  async function closeChannel(channelId: string): Promise<void> {
    const channel = channels.get(channelId)
    if (!channel) return
    channels.delete(channelId)
    channelKeys.delete(channelId)
    await channel.stop().catch(() => undefined)
  }

  function trackSyncTask(task: Promise<void>): void {
    const tracked = task.catch((error) => {
      deps.logError('claw-telegram', 'Failed to reconcile Telegram channels.', {
        message: error instanceof Error ? error.message : String(error)
      })
    })
    syncTasks.add(tracked)
    void tracked.finally(() => syncTasks.delete(tracked))
  }

  async function reconcile(
    settings: AppSettingsV1,
    version: number
  ): Promise<void> {
    const targets = resolveTargets(settings)
    const targetMap = new Map(targets.map((entry) => [entry.channel.id, entry]))

    await Promise.all(
      [...channels.keys()]
        .filter((channelId) => !targetMap.has(channelId))
        .map((channelId) => closeChannel(channelId))
    )
    if (stopped || version !== syncVersion) return

    for (const target of targets) {
      if (stopped || version !== syncVersion) return
      const nextKey = buildKey(target.channel, target.token, target.allowed)
      const currentKey = channelKeys.get(target.channel.id)
      if (channels.has(target.channel.id) && currentKey === nextKey) continue
      if (channels.has(target.channel.id)) {
        await closeChannel(target.channel.id)
        if (stopped || version !== syncVersion) return
      }
      const channel = new TelegramChannel(
        target.channel.id,
        target.token,
        target.allowed,
        {
          logError: deps.logError,
          onInbound: (payload) => deps.onInbound(payload)
        }
      )
      try {
        await channel.start()
        if (stopped || version !== syncVersion) {
          await channel.stop().catch(() => undefined)
          return
        }
        channels.set(target.channel.id, channel)
        channelKeys.set(target.channel.id, nextKey)
      } catch (error) {
        deps.logError('claw-telegram', 'Failed to start a Telegram channel.', {
          channelId: target.channel.id,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  return {
    sync(settings: AppSettingsV1): void {
      if (stopped) return
      const version = ++syncVersion
      trackSyncTask(reconcile(settings, version))
    },

    stop(): Promise<void> {
      if (stopPromise) return stopPromise
      stopped = true
      syncVersion += 1
      const activeChannels = [...channels.values()]
      channels.clear()
      channelKeys.clear()
      stopPromise = (async () => {
        await Promise.allSettled(activeChannels.map((channel) => channel.stop()))
        while (syncTasks.size > 0) {
          await Promise.allSettled([...syncTasks])
        }
        const lateChannels = [...channels.values()]
        channels.clear()
        channelKeys.clear()
        await Promise.allSettled(lateChannels.map((channel) => channel.stop()))
      })()
      return stopPromise
    },

    has(channelId: string): boolean {
      return channels.has(channelId)
    },

    async sendMessage(channelId, chatId, text): Promise<{ ok: true } | { ok: false; message: string }> {
      const channel = channels.get(channelId)
      if (!channel) return { ok: false, message: 'Telegram channel is not connected.' }
      const result = await channel.sendMessage(chatId, text)
      if (!result.ok) {
        deps.logError('claw-telegram', 'Failed to send a Telegram reply.', {
          channelId,
          chatId,
          message: result.message
        })
      }
      return result
    },

    async sendFile(channelId, chatId, filePath, fileName): Promise<{ ok: true } | { ok: false; message: string }> {
      const channel = channels.get(channelId)
      if (!channel) return { ok: false, message: 'Telegram channel is not connected.' }
      const result = await channel.sendFile(chatId, filePath, fileName)
      if (!result.ok) {
        deps.logError('claw-telegram', 'Failed to send a Telegram file attachment.', {
          channelId,
          chatId,
          filePath,
          fileName,
          message: result.message
        })
      }
      return result
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
