import type {
  AttachmentMetadata,
  GraphOrchestrationStrategy,
  GraphRunV1,
  ThreadGoalStatus,
  ThreadSummary,
  ThreadTodoItem,
  ThreadTodoStatus
} from '../contracts/index.js'
import {
  kunToolPermissionModeFromSettings,
  type ApprovalPolicy,
  type ApprovalReviewer,
  type SandboxMode
} from '../contracts/policy.js'
import {
  isModelConnectionProfileUsable,
  type ModelConnectionProfile,
  type ModelConnectionSnapshot
} from '../contracts/model-connections.js'
import type { ModelReasoningEffort, ModelReasoningCapabilityMetadata } from '../contracts/capabilities.js'
import { redactSecretText } from '../config/secret-redaction.js'
import {
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename as renameFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { UserInputAnswer } from './client.js'
import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import {
  KunTuiClient,
  TuiClientError,
  type TuiConnection
} from './client.js'
import type { TuiOptions } from './options.js'
import {
  applyRuntimeEvent,
  hydrateProjectedChildRuns,
  matchingRequestContextSnapshot,
  projectThreadSnapshot,
  setProjectionRunningTurn,
  type ThreadProjection
} from './state.js'
import {
  emptyTuiPersistentState,
  modelStateKey,
  readTuiPersistentState,
  writeTuiPersistentState,
  type TuiPersistentState,
  type TuiRecentModel
} from './persistence.js'
import { modelCapabilitiesForProviderModel } from '../loop/model-context-profile.js'
import { setVisualTheme, type TuiThemeName } from './visual-system.js'
import {
  KunProjectConfigSchema,
  loadKunProjectConfig,
  writeKunProjectConfig
} from '../config/project-config.js'
import { readRuntimeDiscovery } from '../server/runtime-discovery.js'
import { parsePastedFilePaths } from './pasted-paths.js'
import type { ClipboardImage } from './clipboard-image.js'
import {
  isTerminalGraphRun,
  latestTuiGraphRun,
  summarizeTuiGraphRun
} from './graph-mode.js'
import { parseTuiFileMentions } from './file-mentions.js'
const execFile = promisify(execFileCallback)
import { safeMessage, modelConnectionUnavailableMessage, isRefreshConflict, isMissingThread, replaceGraphRun, splitWords, extensionGrantArguments, todoInput, resolveTodo, attachmentIdsFromProjection, mergeAttachmentMetadata, attachmentMimeType, isLikelyUtf8Text, isVideoPath, formatBytes, normalizeSkillId, skillTemplate, assertPathMissing, writeTextAtomically, isPathInside, validateSkillImportTree } from './controller-utils.js'
import { TuiControllerModes } from './controller-modes.js'

export abstract class TuiControllerAttachments extends TuiControllerModes {
  async manageAttachments(value?: string): Promise<void> {
    const action = value?.trim() ?? ''
    if (!action || action === 'list') {
      this.inspect('Attachments', this.stateValue.pendingAttachments.length
        ? this.stateValue.pendingAttachments.map((attachment, index) =>
            `${index + 1}. ${attachment.name} · ${attachment.mimeType} · ${formatBytes(attachment.byteSize)}`
          )
        : ['No files are attached to the next message.', 'Usage: /attach <path>'])
      return
    }
    if (action === 'clear') {
      this.clearPendingAttachments()
      return
    }
    if (action.startsWith('remove ')) {
      const index = Number(action.slice('remove '.length).trim()) - 1
      if (!Number.isSafeInteger(index) || !this.stateValue.pendingAttachments[index]) {
        this.notify('Usage: /attach remove <number>', 'error')
        return
      }
      const removed = this.stateValue.pendingAttachments[index]!
      this.patch({
        pendingAttachments: this.stateValue.pendingAttachments.filter((_attachment, itemIndex) => itemIndex !== index)
      })
      void this.releasePendingAttachment(removed)
      this.notify(`Removed ${removed.name} from the next message.`)
      return
    }
    const workspace = this.stateValue.projection?.thread.workspace ?? this.options.workspace
    const candidate = isAbsolute(action) ? action : resolve(workspace, action)
    if (this.stateValue.pendingAttachments.length >= 8) {
      this.notify('A turn can contain at most 8 attachments; remove one before uploading another.', 'error')
      return
    }
    this.patch({ busy: true, busyLabel: 'Uploading attachment' })
    try {
      const attachment = await this.uploadLocalAttachment(candidate, workspace)
      const pending = [...this.stateValue.pendingAttachments, attachment]
        .filter((attachment, index, all) => all.findIndex((entry) => entry.id === attachment.id) === index)
      if (pending.length > 8) throw new Error('a turn can contain at most 8 attachments')
      this.patch({ busy: false, pendingAttachments: pending })
      this.notify(`Attached ${attachment.name} to the next message.`)
    } catch (error) {
      this.fail(error)
    }
  }

  /**
   * Resolve @file tokens into the existing attachment transport before the
   * composer submits. State is committed only after every distinct file has
   * uploaded successfully so a partial failure cannot alter the queued turn.
   */
  async prepareFileMentions(text: string): Promise<boolean> {
    const parsed = parseTuiFileMentions(text)
    if (parsed.invalid.length > 0) {
      const issue = parsed.invalid[0]!
      this.notify(`Could not attach ${issue.raw}: ${issue.reason}.`, 'error')
      return false
    }
    if (parsed.mentions.length === 0) return true

    const projection = this.stateValue.projection
    const graphRun = projection && projection.thread.mode === 'agent' &&
      this.stateValue.composerOrchestration === 'graph'
      ? latestTuiGraphRun(this.stateValue.graphRuns, projection.thread.id)
      : undefined
    if (projection?.runningTurnId || (graphRun && !isTerminalGraphRun(graphRun))) {
      this.notify(
        '@file references require a new turn; stop the running turn or Graph run before sending this message.',
        'error'
      )
      return false
    }

    const workspace = projection?.thread.workspace ?? this.options.workspace
    const staged: AttachmentMetadata[] = []
    const originalIds = new Set(this.stateValue.pendingAttachments.map((attachment) => attachment.id))
    try {
      const canonicalWorkspace = await realpath(workspace)
      const canonicalMentions = new Map<string, { raw: string; path: string }>()
      for (const mention of parsed.mentions) {
        let canonical: string
        try {
          canonical = await realpath(resolve(canonicalWorkspace, mention.relativePath))
        } catch {
          throw new Error(`${mention.raw} does not name a readable workspace file`)
        }
        if (!isPathInside(canonicalWorkspace, canonical)) {
          throw new Error(`${mention.raw} resolves outside the active workspace`)
        }
        const metadata = await stat(canonical)
        if (!metadata.isFile()) throw new Error(`${mention.raw} must name a regular file, not a directory`)
        canonicalMentions.set(canonical, { raw: mention.raw, path: canonical })
      }

      const pendingPaths = new Set(
        this.stateValue.pendingAttachments.flatMap((attachment) =>
          attachment.localFilePath ? [resolve(attachment.localFilePath)] : []
        )
      )
      const newFiles = [...canonicalMentions.values()].filter((mention) =>
        !pendingPaths.has(resolve(mention.path))
      )
      if (this.stateValue.pendingAttachments.length + newFiles.length > 8) {
        throw new Error('file mentions would exceed the 8-attachment limit')
      }
      if (newFiles.length === 0) return true

      this.patch({
        busy: true,
        busyLabel: newFiles.length === 1 ? 'Attaching mentioned file' : 'Attaching mentioned files',
        notification: undefined
      })
      for (const file of newFiles) {
        staged.push(await this.uploadLocalAttachment(file.path, canonicalWorkspace))
      }
      const pending = [...this.stateValue.pendingAttachments, ...staged]
        .filter((attachment, index, all) =>
          all.findIndex((candidate) => candidate.id === attachment.id) === index
        )
      if (pending.length > 8) throw new Error('file mentions would exceed the 8-attachment limit')
      this.patch({ busy: false, pendingAttachments: pending })
      return true
    } catch (error) {
      const releasable = staged.filter((attachment, index, all) =>
        !originalIds.has(attachment.id) &&
        all.findIndex((candidate) => candidate.id === attachment.id) === index
      )
      await Promise.all(releasable.map((attachment) => this.releasePendingAttachment(attachment)))
      this.fail(new Error(`Could not attach file mention: ${safeMessage(error)}`))
      return false
    }
  }

  removeLastPendingAttachment(): boolean {
    const removed = this.stateValue.pendingAttachments.at(-1)
    if (!removed) return false
    this.patch({
      pendingAttachments: this.stateValue.pendingAttachments.slice(0, -1)
    })
    void this.releasePendingAttachment(removed)
    this.notify(`Removed ${removed.name} from the next message.`)
    return true
  }

  clearPendingAttachments(): boolean {
    if (this.stateValue.pendingAttachments.length === 0) return false
    const removed = this.stateValue.pendingAttachments
    this.patch({ pendingAttachments: [] })
    void Promise.all(removed.map((attachment) => this.releasePendingAttachment(attachment)))
    this.notify('Pending attachments cleared.')
    return true
  }

  /**
   * Convert a bracketed paste that consists entirely of local file paths into
   * pending attachments. Returning false tells the composer to preserve the
   * original paste as ordinary text.
   */
  async attachPastedPaths(pastedText: string): Promise<boolean> {
    const workspace = this.stateValue.projection?.thread.workspace ?? this.options.workspace
    const paths = parsePastedFilePaths(pastedText, workspace)
    if (paths.length === 0) return false
    if (this.stateValue.pendingAttachments.length + paths.length > 8) {
      this.notify('The pasted files exceed the 8-attachment limit; their paths were kept in the composer.', 'error')
      return false
    }
    if (paths.some(isVideoPath)) {
      this.notify(
        'Kun does not support video input yet. The pasted video path was kept in the composer.',
        'error'
      )
      return false
    }

    this.patch({ busy: true, busyLabel: paths.length === 1 ? 'Attaching pasted file' : 'Attaching pasted files' })
    try {
      const uploaded: AttachmentMetadata[] = []
      for (const path of paths) {
        uploaded.push(await this.uploadLocalAttachment(path, workspace))
      }
      const pending = [...this.stateValue.pendingAttachments, ...uploaded]
        .filter((attachment, index, all) => all.findIndex((entry) => entry.id === attachment.id) === index)
      this.patch({ busy: false, pendingAttachments: pending })
      this.notify(
        uploaded.length === 1
          ? `Attached ${uploaded[0]!.name} from the pasted path.`
          : `Attached ${uploaded.length} files from pasted paths.`
      )
      return true
    } catch (error) {
      this.fail(error)
      return false
    }
  }

  /** Upload an image read directly from the operating-system clipboard. */
  async attachClipboardImage(image: ClipboardImage): Promise<boolean> {
    if (this.stateValue.pendingAttachments.length >= 8) {
      this.notify('A turn can contain at most 8 attachments; remove one before pasting another image.', 'error')
      return false
    }
    if (image.bytes.length === 0) {
      this.notify('The clipboard image was empty.', 'error')
      return false
    }
    if (image.bytes.length > 10 * 1024 * 1024) {
      this.notify('The clipboard image exceeds Kun’s 10 MiB upload limit.', 'error')
      return false
    }

    const workspace = this.stateValue.projection?.thread.workspace ?? this.options.workspace
    this.patch({ busy: true, busyLabel: 'Pasting clipboard image' })
    try {
      const extension = image.mimeType === 'image/jpeg'
        ? 'jpg'
        : image.mimeType === 'image/webp'
          ? 'webp'
          : 'png'
      const timestamp = new Date().toISOString().replaceAll(/[-:.TZ]/gu, '').slice(0, 14)
      const attachment = await this.uploadMemoryAttachment(
        `clipboard-${timestamp}.${extension}`,
        image.mimeType,
        image.bytes,
        workspace
      )
      const pending = [...this.stateValue.pendingAttachments, attachment]
        .filter((candidate, index, all) => all.findIndex((entry) => entry.id === candidate.id) === index)
      this.patch({ busy: false, pendingAttachments: pending })
      this.notify(`Pasted clipboard image as ${attachment.name}.`)
      return true
    } catch (error) {
      this.fail(error)
      return false
    }
  }

  protected override async hydrateAttachmentMetadata(
    attachmentIds: readonly string[],
    threadId: string,
    generation: number
  ): Promise<void> {
    if (typeof this.client.getAttachment !== 'function') return
    const pending = [...new Set(attachmentIds)].filter((id) =>
      !this.stateValue.attachmentMetadata[id] && !this.attachmentMetadataRequests.has(id)
    )
    if (pending.length === 0) return
    for (const id of pending) this.attachmentMetadataRequests.add(id)
    const results = await Promise.allSettled(pending.map(async (id) => {
      const response = await this.client.getAttachment(id)
      return response.attachment
    }))
    for (const id of pending) this.attachmentMetadataRequests.delete(id)
    if (
      generation !== this.attachmentHydrationGeneration ||
      this.stateValue.projection?.thread.id !== threadId
    ) return
    const resolved = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    if (resolved.length === 0) return
    this.patch({
      attachmentMetadata: mergeAttachmentMetadata(this.stateValue.attachmentMetadata, resolved)
    })
  }

  /**
   * Keep image attachments queued when the selected model is text-only. This
   * mirrors Kimi Code's send-time capability gate and lets the user switch
   * model without having to paste the path again.
   */
  validatePendingAttachmentsForCurrentModel(): boolean {
    const images = this.stateValue.pendingAttachments.filter((attachment) => attachment.kind === 'image')
    if (images.length === 0) return true
    const snapshot = this.stateValue.modelConnections
    const providerId = this.options.providerId ?? this.stateValue.projection?.thread.providerId ?? snapshot?.defaultProviderId
    const accountId = this.options.accountId ?? this.stateValue.projection?.thread.accountId ?? snapshot?.defaultAccountId
    const model = this.options.model ?? this.stateValue.projection?.thread.model ?? snapshot?.defaultModel
    if (!model) return true
    const profile = snapshot?.providers.find((candidate) =>
      candidate.id === providerId && (!accountId || candidate.accountId === accountId)
    )
    const capabilities = profile?.modelCapabilities?.[model] ?? modelCapabilitiesForProviderModel({
      providerId: profile?.id ?? providerId,
      presetSource: profile?.presetSource,
      baseUrl: profile?.baseUrl,
      kind: profile?.kind,
      model
    })
    if (capabilities.inputModalities.includes('image')) return true
    const label = providerId ? `${providerId}/${model}` : model
    this.notify(
      `${label} does not support image input. The image is still attached; switch with /model or remove it with /attach remove <number>.`,
      'error'
    )
    return false
  }
}
