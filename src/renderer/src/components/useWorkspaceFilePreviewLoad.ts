import {
  useEffect,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import type {
  WorkspaceFileReadResult,
  WorkspaceFileTarget,
  WorkspaceImageReadResult,
  WorkspacePdfReadResult,
  WorkspacePreviewLeaseResult
} from '@shared/workspace-file'
import {
  isWorkspaceRasterImagePreviewPath,
  workspaceFilePreviewKind
} from '../lib/workspace-text-preview'
import type { CachedTextDraft } from './workspace-file-preview-support'
import { useWorkspaceOfficePreview } from './useWorkspaceOfficePreview'

type Translate = (key: string, values?: Record<string, unknown>) => string
type PreviewKind = ReturnType<typeof workspaceFilePreviewKind>

type LoadParams = {
  target: WorkspaceFileTarget | null
  workspaceRoot: string
  activeTargetKey: string
  previewKind: PreviewKind
  t: Translate
  textDraftsRef: MutableRefObject<Map<string, CachedTextDraft>>
  setSvgRendered: Dispatch<SetStateAction<boolean>>
  setHtmlRendered: Dispatch<SetStateAction<boolean>>
  setTextDraft: Dispatch<SetStateAction<string>>
  setTextSaveError: Dispatch<SetStateAction<string | null>>
  setSavingText: Dispatch<SetStateAction<boolean>>
  setEditingText: Dispatch<SetStateAction<boolean>>
  setDiskConflict: Dispatch<SetStateAction<boolean>>
}

export function useWorkspaceFilePreviewLoad({
  target,
  workspaceRoot,
  activeTargetKey,
  previewKind,
  t,
  textDraftsRef,
  setSvgRendered,
  setHtmlRendered,
  setTextDraft,
  setTextSaveError,
  setSavingText,
  setEditingText,
  setDiskConflict
}: LoadParams) {
  const [result, setResult] = useState<WorkspaceFileReadResult | null>(null)
  const [imageResult, setImageResult] = useState<WorkspaceImageReadResult | null>(null)
  const [pdfResult, setPdfResult] = useState<WorkspacePdfReadResult | null>(null)
  const [previewLease, setPreviewLease] = useState<WorkspacePreviewLeaseResult | null>(null)
  const [loading, setLoading] = useState(false)
  const {
    officeResult,
    officeLoading,
    officeAgentEditing,
    officeRefreshError
  } = useWorkspaceOfficePreview({
    target,
    workspaceRoot,
    enabled: previewKind === 'office'
  })

  useEffect(() => {
    if (!target) {
      setResult(null)
      setImageResult(null)
      setPdfResult(null)
      setPreviewLease(null)
      setLoading(false)
      return
    }

    let cancelled = false
    setSvgRendered(true)
    setHtmlRendered(false)
    setTextDraft('')
    setTextSaveError(null)
    setSavingText(false)
    setEditingText(false)
    setDiskConflict(false)
    setLoading(true)
    setResult(null)
    setImageResult(null)
    setPdfResult(null)
    setPreviewLease(null)

    const readTarget = {
      ...target,
      workspaceRoot: target.workspaceRoot ?? workspaceRoot
    }

    if (isWorkspaceRasterImagePreviewPath(target.path)) {
      void window.kunGui
        .readWorkspaceImage(readTarget)
        .then((next) => {
          if (!cancelled) setImageResult(next)
        })
        .catch((error) => {
          if (!cancelled) {
            setImageResult({
              ok: false,
              message: error instanceof Error ? error.message : String(error)
            })
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })

      return () => {
        cancelled = true
      }
    }

    if (previewKind === 'pdf') {
      void window.kunGui
        .readWorkspacePdf(readTarget)
        .then((next) => {
          if (!cancelled) setPdfResult(next)
        })
        .catch((error) => {
          if (!cancelled) {
            setPdfResult({ ok: false, message: error instanceof Error ? error.message : String(error) })
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
      return () => {
        cancelled = true
      }
    }

    if (previewKind === 'office') {
      setLoading(false)
      return () => {
        cancelled = true
      }
    }

    if (previewKind === 'audio' || previewKind === 'video') {
      let leaseId = ''
      void window.kunGui
        .openWorkspacePreviewResource({
          path: readTarget.path,
          workspaceRoot: readTarget.workspaceRoot ?? workspaceRoot
        })
        .then((next) => {
          if (next.ok) leaseId = next.leaseId
          if (!cancelled) setPreviewLease(next)
        })
        .catch((error) => {
          if (!cancelled) {
            setPreviewLease({ ok: false, message: error instanceof Error ? error.message : String(error) })
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
      return () => {
        cancelled = true
        if (leaseId) void window.kunGui.releaseWorkspacePreviewResource({ leaseId })
      }
    }

    if (previewKind === 'unsupported') {
      setResult({
        ok: false,
        message: t('filePreviewUnsupported')
      })
      setLoading(false)
      return
    }

    let leaseId = ''
    void (async () => {
      const [next, htmlLease] = await Promise.all([
        window.kunGui.readWorkspaceFile(readTarget),
        previewKind === 'html'
          ? window.kunGui.openWorkspacePreviewResource({
              path: readTarget.path,
              workspaceRoot: readTarget.workspaceRoot ?? workspaceRoot
            })
          : Promise.resolve(null)
      ])
      if (htmlLease?.ok) leaseId = htmlLease.leaseId
      if (!cancelled) {
        setResult(next)
        if (next.ok) {
          const cached = textDraftsRef.current.get(activeTargetKey)
          setTextDraft(cached?.content ?? next.content)
        }
        if (htmlLease) setPreviewLease(htmlLease)
      }
    })()
      .catch((error) => {
        if (!cancelled) {
          setResult({
            ok: false,
            message: error instanceof Error ? error.message : String(error)
          })
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
      if (leaseId) void window.kunGui.releaseWorkspacePreviewResource({ leaseId })
    }
  }, [
    activeTargetKey,
    previewKind,
    setDiskConflict,
    setEditingText,
    setHtmlRendered,
    setSavingText,
    setSvgRendered,
    setTextDraft,
    setTextSaveError,
    t,
    target,
    textDraftsRef,
    workspaceRoot
  ])

  return {
    result,
    setResult,
    imageResult,
    pdfResult,
    officeResult,
    officeAgentEditing,
    officeRefreshError,
    previewLease,
    loading: previewKind === 'office' ? officeLoading : loading,
    setLoading
  }
}
