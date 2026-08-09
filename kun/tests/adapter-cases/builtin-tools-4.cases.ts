import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LocalToolHost, defaultLocalTools } from '../../src/adapters/tool/local-tool-host.js'

import {
  allBuiltinToolNames,
  allToolNames,
  buildCodingBuiltinLocalTools,
  buildBuiltinLocalToolRecord,
  buildReadOnlyBuiltinLocalTools,
  createBashTool,
  createBashToolDefinition,
  createToolDefinition,
  createAllToolDefinitions,
  createAllTools,
  createEditTool,
  createEditToolDefinition,
  createFindTool,
  createFindToolDefinition,
  createGrepTool,
  createGrepToolDefinition,
  createLocalBashOperations,
  defaultFindLocalToolOperations,
  defaultGrepLocalToolOperations,
  defaultReadLocalToolOperations,
  defaultWriteLocalToolOperations,
  defaultEditLocalToolOperations,
  defaultLsLocalToolOperations,
  createBashLocalTool,
  createCodingToolDefinitions,
  createCodingTools,
  createFindLocalTool,
  createGrepLocalTool,
  createReadLocalTool,
  createReadTool,
  createReadToolDefinition,
  createReadOnlyToolDefinitions,
  createReadOnlyTools,
  createTool,
  createWriteTool,
  createWriteToolDefinition,
  createLsTool,
  createLsToolDefinition
} from '../../src/adapters/tool/builtin-tools.js'

import { createBackgroundShellTool } from '../../src/adapters/tool/background-shell-tool.js'

import { createReadTool as createReadToolFromModule } from '../../src/adapters/tool/read.js'

import { createBashTool as createBashToolFromModule } from '../../src/adapters/tool/bash.js'

import { createEditTool as createEditToolFromModule } from '../../src/adapters/tool/edit.js'

import { createFindTool as createFindToolFromModule } from '../../src/adapters/tool/find.js'

import { createGrepTool as createGrepToolFromModule } from '../../src/adapters/tool/grep.js'

import { createLsTool as createLsToolFromModule } from '../../src/adapters/tool/ls.js'

import { createWriteTool as createWriteToolFromModule } from '../../src/adapters/tool/write.js'

import { computeEditDiff } from '../../src/adapters/tool/edit-diff.js'

import { withFileMutationQueue } from '../../src/adapters/tool/file-mutation-queue.js'

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from '../../src/adapters/tool/truncate.js'

import { BackgroundShellOutputWriter } from '../../src/services/background-shell-output.js'

import type { TurnItem } from '../../src/contracts/items.js'

import {
  DEFAULT_BACKGROUND_BASH_TIMEOUT_SECONDS,
  DEFAULT_BASH_TIMEOUT_SECONDS,
  type FsStats
} from '../../src/adapters/tool/builtin-tool-types.js'

import type { ToolHostContext } from '../../src/ports/tool-host.js'

function buildContext(workspace: string, overrides: Partial<ToolHostContext> = {}): ToolHostContext {
  return {
    threadId: 'thr_1',
    turnId: 'turn_1',
    workspace,
    approvalPolicy: 'on-request',
    // These tests exercise the full builtin family; product defaults are
    // intentionally safer and are covered by policy/settings tests.
    sandboxMode: 'danger-full-access',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow',
    ...overrides
  }
}

async function executeTool(
  host: LocalToolHost,
  workspace: string,
  toolName: string,
  args: Record<string, unknown>
) {
  const result = await host.execute(
    {
      callId: `call_${toolName}`,
      toolName,
      arguments: args
    },
    buildContext(workspace)
  )
  expect(result.item.kind).toBe('tool_result')
  if (result.item.kind !== 'tool_result') {
    throw new Error('expected tool_result')
  }
  return result.item.output as Record<string, unknown>
}

describe('Kun built-in tools', () => {

let workspace: string

let backgroundShellDataDir: string

let host: LocalToolHost

function createBackgroundBashLocalTool(
    options: Parameters<typeof createBashLocalTool>[0] = {}
  ): ReturnType<typeof createBashLocalTool> {
    return createBashLocalTool({
      ...options,
      backgroundShellDataDir
    })
  }

beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'kun-tools-'))
    backgroundShellDataDir = await mkdtemp(join(tmpdir(), 'kun-bg-shell-data-'))
    host = new LocalToolHost({ tools: defaultLocalTools })
  })

afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
    await rm(backgroundShellDataDir, { recursive: true, force: true })
  })

it('persists a full bash output file when truncated', async () => {
    const output = await executeTool(host, workspace, 'bash', {
      command: "node -e \"for (let i = 0; i < 8000; i++) console.log('line-' + i)\""
    })
    expect(output.full_output_path === null || typeof output.full_output_path === 'string').toBe(true)
    expect(output.truncation === null || typeof output.truncation === 'object').toBe(true)
    if (output.truncation) {
      expect(output.full_output_path).not.toBe(null)
      expect(String(output.output)).toContain('truncated')
    }
  })

})
