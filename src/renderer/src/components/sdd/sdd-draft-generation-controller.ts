import type { MutableRefObject } from 'react'
import type { WriteInfographicKind } from '@shared/write-infographic'
import { WRITE_INFOGRAPHIC_MAX_TEXT_CHARS } from '@shared/write-infographic'
import { WRITE_PROTOTYPE_MAX_TEXT_CHARS } from '@shared/write-prototype'
import type { SddDesignContext } from '../../sdd/sdd-draft-store'
import { useSddDraftStore } from '../../sdd/sdd-draft-store'
import { buildSddPrototypeTurnPrompt } from '../../sdd/sdd-prototype-prompt'
import { parseImageMarkdownLine } from '../../write/selected-image'
import { resolveWriteMarkdownResourcePath } from '@shared/write-markdown-resource'
import {
  beginPendingInfographic,
  buildPendingInfographicMarkdown,
  finishPendingInfographic,
  lineEndAfter,
  replacePendingInfographicInText,
  type PendingInfographicKind
} from '../../write/infographic-pending'
import type {
  WriteEditorSelectionState,
  WriteSelectedImage
} from '../write/WriteMarkdownEditor'
import type { WriteRichEditorHandle } from '../../write/tiptap/WriteRichEditor'
import type { WriteNotice } from '../write/write-workspace-view-utils'
import {
  PROTOTYPE_POLL_INTERVAL_MS,
  PROTOTYPE_POLL_TIMEOUT_MS,
  designReferenceTextFromImage,
  randomPrototypeFileName
} from './SddDraftEditorParts'

type Translate = (key: string, values?: Record<string, unknown>) => string

type GenerationControllerParams = {
  readOnly: boolean
  unitImageDir: string | null
  unitProtoDir: string | null
  selection: WriteEditorSelectionState
  setSelection: (selection: WriteEditorSelectionState) => void
  setOperationStatus: (status: 'idle' | 'upgrading' | 'error', error?: string) => void
  t: Translate
  richHandleRef: MutableRefObject<WriteRichEditorHandle | null>
  setContent: (content: string) => void
  draftId: string
  draftWorkspaceRoot: string
  editorFilePath: string
  docAbsolutePath: string
  content: string
  activeDraft: {
    relativePath: string
    designContext?: SddDesignContext
  }
  prototypePrompt: string
  onPrototypeTurn: (payload: {
    prompt: string
    displayText: string
    image?: { absolutePath: string; alt: string }
  }) => Promise<boolean>
  setNotice: (notice: WriteNotice | null) => void
}

export function createSddDraftGenerationController({
  readOnly,
  unitImageDir,
  unitProtoDir,
  selection,
  setSelection,
  setOperationStatus,
  t,
  richHandleRef,
  setContent,
  draftId,
  draftWorkspaceRoot,
  editorFilePath,
  docAbsolutePath,
  content,
  activeDraft,
  prototypePrompt,
  onPrototypeTurn,
  setNotice
}: GenerationControllerParams): {
  generateImage: (kind: WriteInfographicKind) => void
  generatePrototype: () => void
} {
  /** Insert the animated pending token below the selection and clear it.
   * Returns the resolution job, or null when the selection went stale. */
  const insertPendingPlaceholder = (
    kind: PendingInfographicKind,
    altText: string,
    actionLabel: string,
    maxChars: number
  ): { id: string; src: string; pendingMarkdown: string; altText: string; text: string } | null => {
    const range = selection.ranges[0]
    const richHandle = richHandleRef.current
    const text = selection.text.trim().slice(0, maxChars)
    const pending = beginPendingInfographic(kind)
    const pendingMarkdown = buildPendingInfographicMarkdown(altText, pending.src)
    const insertion = `\n\n${pendingMarkdown}\n`
    if (richHandle) {
      // Rich mode: insert at a projection offset so undo history and node
      // structure stay intact.
      const projection = richHandle.getProjectionText() ?? ''
      const insertAt = lineEndAfter(projection, range.to)
      const applied = richHandle.applyProjectedReplacement(
        { from: insertAt, to: insertAt },
        '',
        insertion,
        actionLabel
      )
      if (!applied) {
        finishPendingInfographic(pending.id)
        setOperationStatus('error', t('writeInlineEditChanged'))
        return null
      }
    } else {
      const latest = useSddDraftStore.getState()
      if (
        latest.activeDraft?.id !== draftId ||
        latest.content.slice(range.from, range.to) !== range.text
      ) {
        finishPendingInfographic(pending.id)
        setOperationStatus('error', t('writeInlineEditChanged'))
        return null
      }
      const insertAt = lineEndAfter(latest.content, range.to)
      setContent(latest.content.slice(0, insertAt) + insertion + latest.content.slice(insertAt))
    }
    setSelection({ text: '', ranges: [], charCount: 0 })
    setOperationStatus('idle')
    return { id: pending.id, src: pending.src, pendingMarkdown, altText, text }
  }

  // Inserts an animated placeholder right away and resolves it in the
  // background, so generation never blocks the editor.
  const generateImage = (kind: WriteInfographicKind): void => {
    if (readOnly || !unitImageDir) return
    if (selection.selectedImage && kind === 'design') {
      void generateDesignDraftFromImage(selection.selectedImage)
      return
    }
    if (selection.ranges.length !== 1 || !selection.text.trim()) {
      setOperationStatus('error', t('writeInlineEditNoSelection'))
      return
    }
    if (typeof window.kunGui?.generateWriteInfographic !== 'function') {
      setOperationStatus('error', t('writeInfographicUnavailable'))
      return
    }
    const job = insertPendingPlaceholder(
      kind,
      t(kind === 'design' ? 'writeDesignDraftAlt' : 'writeInfographicAlt'),
      t(kind === 'design' ? 'writeDesignDraftGenerate' : 'writeInfographicGenerate'),
      WRITE_INFOGRAPHIC_MAX_TEXT_CHARS
    )
    if (!job) return
    void completeImageGeneration({ kind, ...job })
  }

  const generateDesignDraftFromImage = async (image: WriteSelectedImage): Promise<void> => {
    if (readOnly || !unitImageDir) return
    if (typeof window.kunGui?.generateWriteInfographic !== 'function') {
      setOperationStatus('error', t('writeInfographicUnavailable'))
      return
    }
    const absoluteImagePath = resolveWriteMarkdownResourcePath(image.src, editorFilePath)
    if (!absoluteImagePath) {
      setOperationStatus('error', t('writeHtmlEmbedMissing'))
      return
    }
    const altText = t('writeDesignDraftAlt')
    const pending = beginPendingInfographic('design')
    const pendingMarkdown = buildPendingInfographicMarkdown(altText, pending.src)
    const insertion = `\n\n${pendingMarkdown}\n`
    const richHandle = richHandleRef.current
    if (richHandle) {
      if (!richHandle.insertMarkdownAfterImage(image.src, insertion)) {
        finishPendingInfographic(pending.id)
        setOperationStatus('error', t('writeInlineEditChanged'))
        return
      }
    } else {
      const latest = useSddDraftStore.getState()
      const line = image.line
      if (
        latest.activeDraft?.id !== draftId ||
        !line ||
        parseImageMarkdownLine(latest.content.slice(line.from, line.to))?.src !== image.src
      ) {
        finishPendingInfographic(pending.id)
        setOperationStatus('error', t('writeInlineEditChanged'))
        return
      }
      setContent(latest.content.slice(0, line.to) + insertion + latest.content.slice(line.to))
    }
    setSelection({ text: '', ranges: [], charCount: 0 })
    setOperationStatus('idle')
    void completeImageGeneration({
      kind: 'design',
      id: pending.id,
      src: pending.src,
      pendingMarkdown,
      altText,
      text: designReferenceTextFromImage(image, content, activeDraft.relativePath),
      referenceImagePath: absoluteImagePath
    })
  }

  const generatePrototype = (): void => {
    if (readOnly) return
    if (selection.selectedImage) {
      void generatePrototypeFromImage(selection.selectedImage)
      return
    }
    if (selection.ranges.length !== 1 || !selection.text.trim()) {
      setOperationStatus('error', t('writeInlineEditNoSelection'))
      return
    }
    if (!unitProtoDir) return
    const text = selection.text.trim().slice(0, WRITE_PROTOTYPE_MAX_TEXT_CHARS)
    const fileName = randomPrototypeFileName()
    const job = insertPendingPlaceholder(
      'prototype',
      t('writePrototypeAlt'),
      t('writePrototypeGenerate'),
      WRITE_PROTOTYPE_MAX_TEXT_CHARS
    )
    if (!job) return
    void dispatchPrototypeTurn(job, fileName, {
      prompt: buildSddPrototypeTurnPrompt({
        mode: 'text',
        text,
        prototypeRelativePath: `${unitProtoDir}/${fileName}`,
        workspaceRoot: draftWorkspaceRoot,
        customPrompt: prototypePrompt,
        ...(activeDraft?.designContext ? { designContext: activeDraft.designContext } : {})
      }),
      displayText: t('writePrototypeGenerate')
    })
  }

  const generatePrototypeFromImage = async (image: WriteSelectedImage): Promise<void> => {
    if (readOnly || !unitProtoDir) return
    const absoluteImagePath = resolveWriteMarkdownResourcePath(image.src, editorFilePath)
    if (!absoluteImagePath) {
      setOperationStatus('error', t('writeHtmlEmbedMissing'))
      return
    }
    const fileName = randomPrototypeFileName()
    const altText = t('writePrototypeAlt')
    const pending = beginPendingInfographic('prototype')
    const pendingMarkdown = buildPendingInfographicMarkdown(altText, pending.src)
    const insertion = `\n\n${pendingMarkdown}\n`
    const richHandle = richHandleRef.current
    if (richHandle) {
      if (!richHandle.insertMarkdownAfterImage(image.src, insertion)) {
        finishPendingInfographic(pending.id)
        setOperationStatus('error', t('writeInlineEditChanged'))
        return
      }
    } else {
      const latest = useSddDraftStore.getState()
      const line = image.line
      if (
        latest.activeDraft?.id !== draftId ||
        !line ||
        parseImageMarkdownLine(latest.content.slice(line.from, line.to))?.src !== image.src
      ) {
        finishPendingInfographic(pending.id)
        setOperationStatus('error', t('writeInlineEditChanged'))
        return
      }
      setContent(latest.content.slice(0, line.to) + insertion + latest.content.slice(line.to))
    }
    setSelection({ text: '', ranges: [], charCount: 0 })
    setOperationStatus('idle')
    await dispatchPrototypeTurn(
      { id: pending.id, src: pending.src, pendingMarkdown, altText, text: '' },
      fileName,
      {
        prompt: buildSddPrototypeTurnPrompt({
          mode: 'image',
          prototypeRelativePath: `${unitProtoDir}/${fileName}`,
          workspaceRoot: draftWorkspaceRoot,
          customPrompt: prototypePrompt,
          ...(activeDraft?.designContext ? { designContext: activeDraft.designContext } : {})
        }),
        displayText: t('writePrototypeGenerate'),
        image: { absolutePath: absoluteImagePath, alt: image.alt }
      }
    )
  }

  const dispatchPrototypeTurn = async (
    job: { id: string; src: string; pendingMarkdown: string; altText: string; text: string },
    fileName: string,
    payload: { prompt: string; displayText: string; image?: { absolutePath: string; alt: string } }
  ): Promise<void> => {
    let sent = false
    try {
      sent = await onPrototypeTurn(payload)
    } catch (err) {
      setOperationStatus('error', t('writePrototypeFailed', {
        message: err instanceof Error ? err.message : String(err)
      }))
    }
    if (!sent) {
      finishPendingInfographic(job.id)
      void resolvePendingImage(job, null)
      return
    }
    startPrototypePoll(job, fileName)
  }

  /** Watch for the agent-written prototype file and swap the placeholder.
   * Polling (not busy-edges) so queued turns and thread switches stay safe;
   * the closure captures the draft context and survives unmount. */
  const startPrototypePoll = (
    job: { id: string; src: string; pendingMarkdown: string; altText: string },
    fileName: string
  ): void => {
    const prototypePath = `${unitProtoDir}/${fileName}`
    // proto/ sits next to requirement.md inside the unit directory.
    const replacementMarkdown = `![${job.altText}](proto/${fileName})`
    const startedAt = Date.now()

    const placeholderStillPresent = async (): Promise<boolean> => {
      const latest = useSddDraftStore.getState()
      if (latest.activeDraft?.id === draftId) {
        return latest.content.includes(job.pendingMarkdown)
      }
      if (typeof window.kunGui?.readWorkspaceFile !== 'function') return true
      try {
        const file = await window.kunGui.readWorkspaceFile({
          path: docAbsolutePath,
          workspaceRoot: draftWorkspaceRoot
        })
        return !file.ok || file.content.includes(job.pendingMarkdown)
      } catch {
        return true
      }
    }

    // The agent writes incrementally (skeleton first, then edits), so a
    // closing </html> alone is not "done": require the content to also be
    // stable across two consecutive ticks before swapping the placeholder.
    let lastContent: string | null = null
    const tick = async (): Promise<void> => {
      try {
        const file = await window.kunGui.readWorkspaceFile({
          path: prototypePath,
          workspaceRoot: draftWorkspaceRoot
        })
        if (file.ok && file.content.includes('</html>')) {
          if (file.content === lastContent) {
            finishPendingInfographic(job.id)
            const applied = await resolvePendingImage(job, replacementMarkdown)
            if (applied) setNotice({ tone: 'success', message: t('writePrototypeReady') })
            return
          }
          lastContent = file.content
        }
      } catch {
        // File not there yet (or transient IO failure) — keep waiting.
      }
      if (!(await placeholderStillPresent())) {
        // The user deleted the placeholder: treat as cancelled.
        finishPendingInfographic(job.id)
        return
      }
      if (Date.now() - startedAt > PROTOTYPE_POLL_TIMEOUT_MS) {
        finishPendingInfographic(job.id)
        await resolvePendingImage(job, null)
        setOperationStatus('error', t('writePrototypeTimeout'))
        return
      }
      window.setTimeout(() => void tick(), PROTOTYPE_POLL_INTERVAL_MS)
    }

    window.setTimeout(() => void tick(), PROTOTYPE_POLL_INTERVAL_MS)
  }

  const completeImageGeneration = async (job: {
    kind: WriteInfographicKind
    id: string
    src: string
    pendingMarkdown: string
    altText: string
    text: string
    referenceImagePath?: string
  }): Promise<void> => {
    let replacementMarkdown: string | null = null
    let failureMessage: string | null = null
    try {
      const result = await window.kunGui.generateWriteInfographic({
        text: job.text,
        filePath: docAbsolutePath,
        workspaceRoot: draftWorkspaceRoot,
        ...(unitImageDir ? { imageDir: unitImageDir } : {}),
        kind: job.kind,
        ...(job.referenceImagePath ? { referenceImagePath: job.referenceImagePath } : {})
      })
      if (result.ok) {
        replacementMarkdown = `![${job.altText}](${result.relativePath})`
      } else {
        failureMessage = result.message
      }
    } catch (err) {
      failureMessage = err instanceof Error ? err.message : String(err)
    } finally {
      finishPendingInfographic(job.id)
    }

    const applied = await resolvePendingImage(job, replacementMarkdown)
    if (failureMessage) {
      setOperationStatus('error', t(
        job.kind === 'design' ? 'writeDesignDraftFailed' : 'writeInfographicFailed',
        { message: failureMessage }
      ))
    } else if (applied) {
      setNotice({
        tone: 'success',
        message: t(job.kind === 'design' ? 'writeDesignDraftReady' : 'writeInfographicReady')
      })
    }
  }

  /** Swap the placeholder for the generated image — or remove it when
   * `replacementMarkdown` is null. Returns false when the placeholder is
   * gone (the user deleted it, which cancels the insertion). */
  const resolvePendingImage = async (
    job: { src: string; pendingMarkdown: string },
    replacementMarkdown: string | null
  ): Promise<boolean> => {
    const latest = useSddDraftStore.getState()
    if (latest.activeDraft?.id === draftId) {
      // Node-level swap keeps the rich editor's undo history clean; the text
      // fallback covers the source editor (no rich handle mounted).
      const handle = richHandleRef.current
      if (handle?.replaceImageBySrc(job.src, replacementMarkdown ?? '')) return true
      const next = replacePendingInfographicInText(
        latest.content,
        job.pendingMarkdown,
        replacementMarkdown
      )
      if (next === null) return false
      setContent(next)
      return true
    }
    // The draft was closed mid-generation; dismissing flushed it to disk with
    // the placeholder inside, so patch it on disk.
    if (
      typeof window.kunGui?.readWorkspaceFile !== 'function' ||
      typeof window.kunGui?.writeWorkspaceFile !== 'function'
    ) {
      return false
    }
    try {
      const file = await window.kunGui.readWorkspaceFile({
        path: docAbsolutePath,
        workspaceRoot: draftWorkspaceRoot
      })
      if (!file.ok || file.truncated) return false
      const next = replacePendingInfographicInText(
        file.content,
        job.pendingMarkdown,
        replacementMarkdown
      )
      if (next === null) return false
      const written = await window.kunGui.writeWorkspaceFile({
        path: docAbsolutePath,
        workspaceRoot: draftWorkspaceRoot,
        content: next
      })
      return written.ok
    } catch {
      return false
    }
  }

  return { generateImage, generatePrototype }
}
