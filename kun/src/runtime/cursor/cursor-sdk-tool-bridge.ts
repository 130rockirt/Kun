import type {
  SDKCustomTool,
  SDKCustomToolContext,
  SDKJsonValue
} from '@cursor/sdk'
import type { CapabilityToolSpec } from '../../adapters/tool/capability-registry.js'
import {
  DEFAULT_EXCLUDED_TOOL_NAMES,
  DEFAULT_OVERLAP_TOOL_NAMES,
  mapKunResultToSdkContent,
  type KunToolResult
} from '../agent-sdk/sdk-tool-bridge.js'

export type CursorBridgeTool = Pick<
  CapabilityToolSpec,
  'name' | 'description' | 'inputSchema' | 'toolKind' | 'providerId' | 'providerKind'
>

export type CursorKunToolCall = {
  toolName: string
  args: Record<string, unknown>
  toolCallId?: string
  /** Kun catalog provider the tool belongs to; forwarded to ToolHost.execute. */
  providerId?: string
  /** Kun catalog tool classification; forwarded to ToolHost.execute. */
  toolKind?: 'tool_call' | 'command_execution' | 'file_change'
}

export type CursorKunToolExecutor = (call: CursorKunToolCall) => Promise<KunToolResult>

/**
 * Kun built-ins that overlap Cursor Agent built-ins — use the SDK's native
 * tools instead of re-exposing them as customTools (which Cursor registers as
 * the `custom-user-tools` MCP server).
 */
export const CURSOR_OVERLAP_TOOL_NAMES: ReadonlySet<string> = DEFAULT_OVERLAP_TOOL_NAMES

/** Kun tools that are meaningless or internal-only on a Cursor SDK turn. */
export const CURSOR_EXCLUDED_TOOL_NAMES: ReadonlySet<string> = DEFAULT_EXCLUDED_TOOL_NAMES

export interface SelectCursorBridgeToolsOptions {
  overlap?: ReadonlySet<string>
  excluded?: ReadonlySet<string>
}

/**
 * Filter the Kun catalog down to Kun-exclusive tools worth bridging.
 * Overlapping file/shell/search tools stay on Cursor's native toolset.
 */
export function selectCursorBridgeTools(
  tools: readonly CursorBridgeTool[],
  opts: SelectCursorBridgeToolsOptions = {}
): CursorBridgeTool[] {
  const overlap = opts.overlap ?? CURSOR_OVERLAP_TOOL_NAMES
  const excluded = opts.excluded ?? CURSOR_EXCLUDED_TOOL_NAMES
  const seen = new Set<string>()
  return tools.filter((tool) => {
    const name = tool.name.trim()
    if (!name || seen.has(name) || overlap.has(name) || excluded.has(name)) return false
    seen.add(name)
    return true
  })
}

export function buildCursorCustomTools(
  tools: readonly CursorBridgeTool[],
  execute: CursorKunToolExecutor
): Record<string, SDKCustomTool> {
  const customTools: Record<string, SDKCustomTool> = {}
  for (const rawTool of selectCursorBridgeTools(tools)) {
    // Tool names are the SDK-facing identity. Normalize catalog whitespace
    // once so the callback name, the custom-tools key, and the Kun lookup
    // always agree.
    const tool = rawTool.name.trim() === rawTool.name
      ? rawTool
      : { ...rawTool, name: rawTool.name.trim() }
    customTools[tool.name] = {
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, SDKJsonValue>,
      execute: async (
        args: Record<string, SDKJsonValue>,
        context: SDKCustomToolContext
      ) => {
        try {
          return mapKunResultToSdkContent(await execute({
            toolName: tool.name,
            args,
            ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
            ...(tool.providerId ? { providerId: tool.providerId } : {}),
            ...(tool.toolKind ? { toolKind: tool.toolKind } : {})
          }))
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Kun tool "${tool.name}" failed: ${
                error instanceof Error ? error.message : String(error)
              }`
            }],
            isError: true
          }
        }
      }
    }
  }
  return customTools
}
