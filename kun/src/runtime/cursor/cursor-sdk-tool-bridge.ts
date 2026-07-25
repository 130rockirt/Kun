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
  'name' | 'description' | 'inputSchema' | 'providerId' | 'providerKind'
>

export type CursorKunToolExecutor = (
  toolName: string,
  args: Record<string, unknown>,
  toolCallId?: string
) => Promise<KunToolResult>

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
  for (const tool of selectCursorBridgeTools(tools)) {
    customTools[tool.name] = {
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, SDKJsonValue>,
      execute: async (
        args: Record<string, SDKJsonValue>,
        context: SDKCustomToolContext
      ) => {
        try {
          return mapKunResultToSdkContent(await execute(tool.name, args, context.toolCallId))
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
