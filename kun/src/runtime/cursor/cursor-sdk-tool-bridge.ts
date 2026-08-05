import type {
  SDKCustomTool,
  SDKCustomToolContext,
  SDKJsonValue
} from '@cursor/sdk'
import type { CapabilityToolSpec } from '../../adapters/tool/capability-registry.js'
import {
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

const CURSOR_BRIDGE_EXCLUDED_TOOL_NAMES = new Set(['echo'])

export function selectCursorBridgeTools(
  tools: readonly CursorBridgeTool[]
): CursorBridgeTool[] {
  const seen = new Set<string>()
  return tools.filter((tool) => {
    const name = tool.name.trim()
    if (!name || seen.has(name) || CURSOR_BRIDGE_EXCLUDED_TOOL_NAMES.has(name)) return false
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
