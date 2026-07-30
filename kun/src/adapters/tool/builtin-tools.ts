import type { LocalTool } from './local-tool-host.js'
import type {
  BuiltinLocalToolsOptions,
  BuiltinToolName,
  ToolName,
  ToolsOptions
} from './builtin-tool-types.js'
import { createBashLocalTool } from './builtin-bash-tool.js'
import { createEditLocalTool, createWriteLocalTool } from './builtin-file-tools.js'
import { createLspLocalTool } from './builtin-lsp-tool.js'
import { createReadLocalTool } from './builtin-read-tool.js'
import { createFindLocalTool, createGlobLocalTool, createGrepLocalTool, createLsLocalTool } from './builtin-search-tools.js'
import { createRepoMapLocalTool } from './builtin-repo-map-tool.js'
import { createGitInspectLocalTool } from './builtin-git-inspect-tool.js'
import { createVerifyChangesLocalTool } from './builtin-verify-tool.js'
import { createSendImAttachmentLocalTool } from './im-attachment-tool.js'

export * from './builtin-tool-types.js'
export * from './builtin-tool-operations.js'
export * from './builtin-read-tool.js'
export * from './builtin-file-tools.js'
export * from './builtin-search-tools.js'
export * from './builtin-repo-map-tool.js'
export * from './builtin-git-inspect-tool.js'
export * from './builtin-bash-tool.js'
export * from './builtin-verify-tool.js'
export * from './im-attachment-tool.js'

export function createBuiltinLocalTool(
  toolName: BuiltinToolName,
  options: BuiltinLocalToolsOptions = {}
): LocalTool {
  switch (toolName) {
    case 'read':
      return createReadLocalTool(options.read)
    case 'bash':
      return createBashLocalTool(options.bash)
    case 'edit':
      return createEditLocalTool(options.edit)
    case 'write':
      return createWriteLocalTool(options.write)
    case 'grep':
      return createGrepLocalTool(options.grep)
    case 'glob':
      return createGlobLocalTool(options.glob ?? options.find)
    case 'find':
      return createFindLocalTool(options.find)
    case 'ls':
      return createLsLocalTool(options.ls)
    case 'lsp':
      return createLspLocalTool()
    case 'repo_map':
      return createRepoMapLocalTool()
    case 'git_inspect':
      return createGitInspectLocalTool()
    case 'verify_changes':
      return createVerifyChangesLocalTool()
    case 'send_im_attachment':
      return createSendImAttachmentLocalTool()
  }
}

export function createTool(toolName: ToolName, options: ToolsOptions = {}): LocalTool {
  return createBuiltinLocalTool(toolName, options)
}

export function createToolDefinition(toolName: ToolName, options: ToolsOptions = {}): LocalTool {
  return createBuiltinLocalTool(toolName, options)
}

export function buildBuiltinLocalTools(options: BuiltinLocalToolsOptions = {}): LocalTool[] {
  return [
    createReadLocalTool(options.read),
    createBashLocalTool(options.bash),
    createEditLocalTool(options.edit),
    createWriteLocalTool(options.write),
    createGrepLocalTool(options.grep),
    createGlobLocalTool(options.glob ?? options.find),
    createFindLocalTool(options.find),
    createLsLocalTool(options.ls),
    createLspLocalTool(),
    createRepoMapLocalTool(),
    createGitInspectLocalTool(),
    createVerifyChangesLocalTool(),
    createSendImAttachmentLocalTool()
  ]
}

export function createAllTools(options: ToolsOptions = {}): Record<ToolName, LocalTool> {
  return buildBuiltinLocalToolRecord(options)
}

export function buildCodingBuiltinLocalTools(options: BuiltinLocalToolsOptions = {}): LocalTool[] {
  return [
    createReadLocalTool(options.read),
    createBashLocalTool(options.bash),
    createEditLocalTool(options.edit),
    createWriteLocalTool(options.write)
  ]
}

export function createCodingTools(options: ToolsOptions = {}): LocalTool[] {
  return buildCodingBuiltinLocalTools(options)
}

export function buildReadOnlyBuiltinLocalTools(options: BuiltinLocalToolsOptions = {}): LocalTool[] {
  return [
    createReadLocalTool(options.read),
    createGrepLocalTool(options.grep),
    createGlobLocalTool(options.glob ?? options.find),
    createFindLocalTool(options.find),
    createLsLocalTool(options.ls),
    createRepoMapLocalTool(),
    createGitInspectLocalTool()
  ]
}

export function createReadOnlyTools(options: ToolsOptions = {}): LocalTool[] {
  return buildReadOnlyBuiltinLocalTools(options)
}

export function buildBuiltinLocalToolRecord(
  options: BuiltinLocalToolsOptions = {}
): Record<BuiltinToolName, LocalTool> {
  return {
    read: createReadLocalTool(options.read),
    bash: createBashLocalTool(options.bash),
    edit: createEditLocalTool(options.edit),
    write: createWriteLocalTool(options.write),
    grep: createGrepLocalTool(options.grep),
    glob: createGlobLocalTool(options.glob ?? options.find),
    find: createFindLocalTool(options.find),
    ls: createLsLocalTool(options.ls),
    lsp: createLspLocalTool(),
    repo_map: createRepoMapLocalTool(),
    git_inspect: createGitInspectLocalTool(),
    verify_changes: createVerifyChangesLocalTool(),
    send_im_attachment: createSendImAttachmentLocalTool()
  }
}

export function createAllToolDefinitions(options: ToolsOptions = {}): Record<ToolName, LocalTool> {
  return buildBuiltinLocalToolRecord(options)
}

export function createCodingToolDefinitions(options: ToolsOptions = {}): LocalTool[] {
  return buildCodingBuiltinLocalTools(options)
}

export function createReadOnlyToolDefinitions(options: ToolsOptions = {}): LocalTool[] {
  return buildReadOnlyBuiltinLocalTools(options)
}
