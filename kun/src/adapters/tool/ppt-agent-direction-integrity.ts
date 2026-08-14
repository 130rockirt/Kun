import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { PptReviewManifestV1 } from '../../ppt/ppt-review-manifest.js'
import { detectPptImageDimensions } from '../../ppt/ppt-geometry-qa-image.js'
import { resolveWorkspacePath } from './builtin-tool-utils.js'
import { assertPptScopedExistingPath } from './ppt-agent-physical-path.js'

export async function pptDirectionPreviewIntegrityError(
  manifest: PptReviewManifestV1,
  context: ToolHostContext
): Promise<string> {
  if (!manifest.directions) return 'persisted visual directions are unavailable'
  const imageRoot = await resolveWorkspacePath('.kun/images', context, { enforceWorkspaceBoundary: true })
  for (const candidate of manifest.directions.candidates) {
    for (const preview of candidate.previews) {
      if (!preview.imagePath.replaceAll('\\', '/').startsWith('.kun/images/')) {
        return `persisted direction preview left the managed image directory: ${preview.imagePath}`
      }
      try {
        const image = await resolveWorkspacePath(preview.imagePath, context, { enforceWorkspaceBoundary: true })
        const proof = await assertPptScopedExistingPath({
          workspaceRoot: image.workspaceRoot,
          scopeRoot: imageRoot.absolutePath,
          targetPath: image.absolutePath,
          label: 'PPT direction preview',
          expected: 'file'
        })
        const bytes = await readFile(proof.physicalPath)
        const dimensions = detectPptImageDimensions(bytes, proof.physicalPath)
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        if (!dimensions || sha256 !== preview.sha256 ||
          dimensions.width !== preview.width || dimensions.height !== preview.height) {
          return `persisted direction preview changed after host validation: ${preview.imagePath}`
        }
      } catch {
        return `persisted direction preview is unavailable or changed: ${preview.imagePath}`
      }
    }
  }
  return ''
}
