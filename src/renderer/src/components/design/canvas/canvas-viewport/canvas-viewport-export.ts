import type { DesignExportFormat } from '@shared/design-export'
import type { DesignArtifact } from '../../../../design/design-types'
import { useCallback, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useCanvasShapeStore } from '../../../../design/canvas/canvas-shape-store'
import {
  exportCanvasFromSvg,
  type CanvasExportFormat
} from '../../../../design/canvas/canvas-export'

export async function exportDesignPrototypeArtifact(options: {
  artifacts: readonly DesignArtifact[]
  preferredArtifactId: string | null
  workspaceRoot: string
  format: DesignExportFormat
  unavailableMessage: string
  failedMessage: string
}): Promise<void> {
  const artifact = options.artifacts.find((candidate) => (
    candidate.kind === 'html' && candidate.id === options.preferredArtifactId
  )) ?? options.artifacts.find((candidate) => candidate.kind === 'html')
  if (!artifact) throw new Error(options.unavailableMessage)
  if (typeof window.kunGui?.exportDesignPrototype !== 'function') {
    throw new Error(options.failedMessage)
  }
  const result = await window.kunGui.exportDesignPrototype({
    workspaceRoot: options.workspaceRoot,
    path: artifact.relativePath,
    format: options.format,
    filename: artifact.title
  })
  if (!result.ok && !result.canceled) {
    throw new Error(result.message || options.failedMessage)
  }
}

export function useCanvasViewportExports(options: {
  svgRef: RefObject<SVGSVGElement | null>
  containerRef: RefObject<HTMLDivElement | null>
  workspaceRoot: string
  designArtifacts: readonly DesignArtifact[]
  initialPrototypeArtifactId: string | null
}): {
  exportCanvas: (format: CanvasExportFormat) => Promise<void>
  exportPrototype: (format: DesignExportFormat) => Promise<void>
} {
  const { t } = useTranslation('common')
  const exportCanvas = useCallback(async (format: CanvasExportFormat): Promise<void> => {
    const sourceSvg = options.svgRef.current
    if (!sourceSvg) throw new Error(t('canvasExportUnavailable'))
    await exportCanvasFromSvg({
      sourceSvg,
      document: useCanvasShapeStore.getState().document,
      format,
      workspaceRoot: options.workspaceRoot,
      filename: 'kun-whiteboard',
      backgroundColor: options.containerRef.current
        ? getComputedStyle(options.containerRef.current).backgroundColor
        : '#ffffff'
    })
  }, [options.containerRef, options.svgRef, options.workspaceRoot, t])
  const exportPrototype = useCallback(async (format: DesignExportFormat): Promise<void> => {
    await exportDesignPrototypeArtifact({
      artifacts: options.designArtifacts,
      preferredArtifactId: options.initialPrototypeArtifactId,
      workspaceRoot: options.workspaceRoot,
      format,
      unavailableMessage: t('designPrototypePlayUnavailable'),
      failedMessage: t('designExportFailed')
    })
  }, [options.designArtifacts, options.initialPrototypeArtifactId, options.workspaceRoot, t])
  return { exportCanvas, exportPrototype }
}
