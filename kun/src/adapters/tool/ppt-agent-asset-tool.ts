import { constants as fsConstants } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { LocalToolHost, type LocalTool } from './local-tool-host.js'
import { resolveWorkspacePath, withToolBoundary } from './builtin-tool-utils.js'
import { withFileMutationQueue } from './file-mutation-queue.js'
import {
  assertPptScopedExistingPath,
  assertPptScopedMutationPath
} from './ppt-agent-physical-path.js'
import { assertCanWritePath } from './sandbox-policy.js'
import {
  assertPptWorkflowBinding,
  stringArg,
  type PptAgentLocalToolOptions
} from './ppt-agent-local-tools-support.js'

export const PPT_IMPORT_ASSET_TOOL_NAME = 'ppt_import_asset'

/** Copy an approved generated image into the governed PPTD project as binary data. */
export function createPptImportAssetTool(
  options: PptAgentLocalToolOptions,
  shouldAdvertise: (context: ToolHostContext) => boolean
): LocalTool {
  return LocalToolHost.defineTool({
    name: PPT_IMPORT_ASSET_TOOL_NAME,
    description: 'Import one reviewed image from .kun/images into the current governed PPT project media directory without text transcoding. Use this before referencing an approved generated image from PPTD.',
    toolKind: 'file_change',
    policy: 'auto',
    sideEffect: 'unknown',
    effects: { network: false, externalWrite: false, processExecution: false, guiAutomation: false },
    shouldAdvertise,
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Workspace-relative reviewed image path under .kun/images.'
        },
        name: {
          type: 'string',
          description: 'Optional destination filename inside project/media; defaults to the source basename.'
        }
      },
      required: ['source'],
      additionalProperties: false
    },
    execute: async (args, context) => withToolBoundary(async () => {
      if (options.enabled?.() === false) {
        return { output: { error: 'PPT Agent is disabled in Lab settings' }, isError: true }
      }
      const scope = assertPptWorkflowBinding({
        context,
        actions: ['start', 'select_direction', 'revise_previews', 'retry_failed', 'approve_and_build']
      })
      const sourceArg = stringArg(args.source).replaceAll('\\', '/')
      if (!sourceArg.startsWith('.kun/images/') || sourceArg.includes('/../')) {
        return { output: { error: 'source must be a reviewed image under .kun/images' }, isError: true }
      }
      const source = await resolveWorkspacePath(sourceArg, context, { enforceWorkspaceBoundary: true })
      const sourceName = basename(source.relativePath)
      const requestedName = stringArg(args.name) || sourceName
      if (
        basename(requestedName) !== requestedName ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requestedName) ||
        !/\.(?:png|jpe?g|webp)$/i.test(requestedName) ||
        extname(requestedName).toLowerCase() !== extname(sourceName).toLowerCase()
      ) {
        return { output: { error: 'name must be a safe PNG, JPEG, or WebP filename with the source extension' }, isError: true }
      }

      const imageRoot = await resolveWorkspacePath('.kun/images', context, { enforceWorkspaceBoundary: true })
      const project = await resolveWorkspacePath(scope.projectDir, context, { enforceWorkspaceBoundary: true })
      const sourceProof = await assertPptScopedExistingPath({
        workspaceRoot: source.workspaceRoot,
        scopeRoot: imageRoot.absolutePath,
        targetPath: source.absolutePath,
        label: 'PPT image source',
        expected: 'file'
      })
      if (!sourceProof.bytes) {
        return { output: { error: 'source must be a non-empty image file' }, isError: true }
      }
      const mediaDirectory = join(project.absolutePath, 'media')
      const destination = join(mediaDirectory, requestedName)
      assertCanWritePath(destination, context)
      await assertPptScopedMutationPath({
        workspaceRoot: project.workspaceRoot,
        scopeRoot: mediaDirectory,
        targetPath: destination,
        label: 'PPT imported asset destination',
        expected: 'file'
      })
      return withFileMutationQueue(destination, async () => {
        const currentSource = await assertPptScopedExistingPath({
          workspaceRoot: source.workspaceRoot,
          scopeRoot: imageRoot.absolutePath,
          targetPath: source.absolutePath,
          label: 'PPT image source',
          expected: 'file'
        })
        const currentProject = await assertPptScopedMutationPath({
          workspaceRoot: project.workspaceRoot,
          scopeRoot: project.absolutePath,
          targetPath: project.absolutePath,
          label: 'PPT project directory',
          expected: 'directory'
        })
        await mkdir(mediaDirectory, { recursive: true })
        const currentDestination = await assertPptScopedMutationPath({
          workspaceRoot: project.workspaceRoot,
          scopeRoot: mediaDirectory,
          targetPath: destination,
          label: 'PPT imported asset destination',
          expected: 'file'
        })
        assertPptWorkflowBinding({
          context,
          projectDir: relative(
            currentProject.physicalWorkspaceRoot,
            currentProject.physicalPath
          ).replaceAll('\\', '/') || '.'
        })
        await copyFile(currentSource.physicalPath, currentDestination.physicalPath, fsConstants.COPYFILE_EXCL)
        const copied = await assertPptScopedExistingPath({
          workspaceRoot: project.workspaceRoot,
          scopeRoot: mediaDirectory,
          targetPath: destination,
          label: 'PPT imported asset destination',
          expected: 'file'
        })
        const imported = relative(copied.physicalWorkspaceRoot, copied.physicalPath).replaceAll('\\', '/')
        return { output: { source: source.relativePath, importedPath: imported, bytes: copied.bytes } }
      })
    })
  })
}
