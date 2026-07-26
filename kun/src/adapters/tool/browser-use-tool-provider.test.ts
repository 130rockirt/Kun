import { describe, expect, it, vi } from 'vitest'
import type { KunCapabilitiesConfig } from '../../contracts/capabilities.js'
import type { BrowserController } from '../../ports/browser-controller.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { buildBrowserUseToolProviders } from './browser-use-tool-provider.js'

const config: KunCapabilitiesConfig['browserUse'] = {
  enabled: true,
  mode: 'public',
  approvalMode: 'auto-safe',
  maxTabs: 2,
  maxObservationActionsPerTurn: 2,
  maxInteractionActionsPerTurn: 1,
  maxSnapshotNodes: 250,
  maxSnapshotTextChars: 20_000,
  maxImageDimension: 1280,
  idleTimeoutMs: 300_000
}

function context(overrides: Partial<ToolHostContext> = {}): ToolHostContext {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    workspace: '/workspace',
    agentSurface: 'code',
    approvalPolicy: 'auto',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'deny',
    ...overrides
  }
}

function controller(result: Record<string, unknown> = {
  ok: true,
  code: 'snapshot',
  message: 'bounded snapshot'
}): BrowserController {
  return {
    readiness: () => ({ available: true }),
    execute: vi.fn(async () => result as never)
  }
}

describe('buildBrowserUseToolProviders', () => {
  it('is disabled or interaction-required when host supervision is absent', () => {
    expect(buildBrowserUseToolProviders({ ...config, enabled: false }).providers).toHaveLength(0)
    const unavailable = buildBrowserUseToolProviders(config, {
      controller: {
        readiness: () => ({
          available: false,
          interactionRequired: true,
          reason: 'visible GUI required'
        }),
        execute: vi.fn()
      }
    })
    expect(unavailable).toMatchObject({
      available: false,
      interactionRequired: true,
      reason: 'visible GUI required'
    })
    expect(unavailable.providers[0]?.tools).toHaveLength(0)
  })

  it('advertises one stable primary Code tool but not IM or other surfaces', () => {
    const result = buildBrowserUseToolProviders(config, { controller: controller() })
    expect(result.providers[0]?.tools.map((tool) => tool.name)).toEqual(['browser_use'])
    const tool = result.providers[0]!.tools[0]!
    expect(tool.policy).toBe('never')
    expect(tool.shouldAdvertise?.(context())).toBe(true)
    expect(tool.shouldAdvertise?.(context({ imContext: true }))).toBe(false)
    expect(tool.shouldAdvertise?.(context({ agentSurface: 'write' }))).toBe(false)
  })

  it('strictly rejects selectors/scripts before calling Main', async () => {
    const host = controller()
    const tool = buildBrowserUseToolProviders(config, { controller: host }).providers[0]!.tools[0]!
    const output = await tool.execute({
      action: 'click',
      ref: 'opaque-reference-1234',
      selector: '#buy'
    }, context()) as { isError?: boolean; output: { code?: string } }
    expect(output.isError).toBe(true)
    expect(output.output.code).toBe('invalid_action')
    expect(host.execute).not.toHaveBeenCalled()
  })

  it('keeps host approval independent from general auto approval and enforces budgets', async () => {
    const host = controller({
      ok: false,
      code: 'consent_denied',
      message: 'user denied'
    })
    const tool = buildBrowserUseToolProviders(config, { controller: host }).providers[0]!.tools[0]!
    const first = await tool.execute({
      action: 'click',
      ref: 'opaque-reference-1234'
    }, context()) as { isError?: boolean; output: { code?: string } }
    expect(first).toMatchObject({ isError: true, output: { code: 'consent_denied' } })
    expect(context().awaitApproval).toBeDefined()
    expect(host.execute).toHaveBeenCalledOnce()

    const second = await tool.execute({
      action: 'click',
      ref: 'another-reference-1234'
    }, context()) as { isError?: boolean; output: { code?: string } }
    expect(second).toMatchObject({
      isError: true,
      output: { code: 'action_budget_exhausted' }
    })
    expect(host.execute).toHaveBeenCalledOnce()
  })

  it('projects screenshots into the bounded model image pipeline', async () => {
    const host = controller({
      ok: true,
      code: 'screenshot',
      message: 'captured',
      image: { mediaType: 'image/png', data: 'PNGDATA' }
    })
    const tool = buildBrowserUseToolProviders(config, { controller: host }).providers[0]!.tools[0]!
    const output = await tool.execute({ action: 'screenshot' }, context()) as {
      output: { kind: string; images: Array<{ data_base64: string }> }
    }
    expect(output.output).toMatchObject({
      kind: 'browser_screenshot',
      images: [{ data_base64: 'PNGDATA' }]
    })
  })
})
