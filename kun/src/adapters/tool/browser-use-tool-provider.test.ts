import { describe, expect, it, vi } from 'vitest'
import type { KunCapabilitiesConfig } from '../../contracts/capabilities.js'
import type { BrowserController } from '../../ports/browser-controller.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { buildBrowserUseToolProviders } from './browser-use-tool-provider.js'
import { CapabilityRegistry } from './capability-registry.js'
import { LocalToolHost } from './local-tool-host.js'

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
    clientSurface: 'gui',
    agentSurface: 'code',
    approvalPolicy: 'auto',
    sandboxMode: 'workspace-write',
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

function localToolHost(browserController: BrowserController): LocalToolHost {
  const providers = buildBrowserUseToolProviders(config, {
    controller: browserController
  }).providers
  return new LocalToolHost({
    registry: new CapabilityRegistry(providers)
  })
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

  it('advertises one stable primary Code tool but not IM or other surfaces', async () => {
    const result = buildBrowserUseToolProviders(config, { controller: controller() })
    expect(result.providers[0]?.tools.map((tool) => tool.name)).toEqual(['browser_use'])
    const tool = result.providers[0]!.tools[0]!
    expect(tool).toMatchObject({
      policy: 'auto',
      toolKind: 'tool_call',
      providerManagedApproval: true
    })

    const host = localToolHost(controller())
    expect((await host.listTools(context())).map((entry) => entry.name)).toEqual(['browser_use'])
    expect(await host.listTools(context({ imContext: true }))).toHaveLength(0)
    expect(await host.listTools(context({ agentSurface: 'write' }))).toHaveLength(0)
    expect(await host.listTools(context({ agentSurface: 'design' }))).toHaveLength(0)
    expect(await host.listTools(context({ clientSurface: 'api' }))).toHaveLength(0)
    expect(await host.listTools(context({ clientSurface: 'tui' }))).toHaveLength(0)
  })

  it.each([
    ['API', { clientSurface: 'api' }],
    ['TUI', { clientSurface: 'tui' }],
    ['IM', { imContext: true }],
    ['Write', { agentSurface: 'write' }],
    ['Design', { agentSurface: 'design' }]
  ] satisfies Array<[string, Partial<ToolHostContext>]>)(
    'rejects direct execution from the %s surface before reaching Main',
    async (surface, overrides) => {
      const browserController = controller()
      const host = localToolHost(browserController)
      const blockedContext = context({
        turnId: `turn-blocked-${surface.toLowerCase()}`,
        ...overrides
      })

      expect(await host.listTools(blockedContext)).toHaveLength(0)
      await expect(host.execute({
        callId: `call-blocked-${surface.toLowerCase()}`,
        toolName: 'browser_use',
        arguments: { action: 'snapshot' }
      }, blockedContext)).rejects.toThrow(/not advertised/)
      expect(browserController.execute).not.toHaveBeenCalled()
    }
  )

  it('strictly rejects selectors/scripts before calling Main', async () => {
    const browserController = controller()
    const host = localToolHost(browserController)
    const result = await host.execute({
      callId: 'call-invalid',
      toolName: 'browser_use',
      arguments: {
        action: 'click',
        ref: 'opaque-reference-1234',
        selector: '#buy'
      }
    }, context())
    expect(result.item).toMatchObject({
      kind: 'tool_result',
      isError: true,
      output: { code: 'invalid_action' }
    })
    expect(browserController.execute).not.toHaveBeenCalled()
  })

  it.each(['auto', 'always', 'never'] as const)(
    'executes through LocalToolHost under general %s approval without a duplicate prompt',
    async (approvalPolicy) => {
      const browserController = controller()
      const awaitApproval = vi.fn(async () => 'deny' as const)
      const host = localToolHost(browserController)
      const activeContext = context({
        turnId: `turn-${approvalPolicy}`,
        approvalPolicy,
        awaitApproval
      })

      expect((await host.listTools(activeContext)).map((entry) => entry.name))
        .toEqual(['browser_use'])
      const result = await host.execute({
        callId: `call-${approvalPolicy}`,
        toolName: 'browser_use',
        arguments: { action: 'snapshot' }
      }, activeContext)

      expect(result.item).toMatchObject({
        kind: 'tool_result',
        isError: false,
        output: {
          kind: 'browser_action',
          ok: true,
          code: 'snapshot'
        }
      })
      expect(browserController.execute).toHaveBeenCalledOnce()
      expect(awaitApproval).not.toHaveBeenCalled()
    }
  )

  it('keeps Browser Host approval authoritative and enforces budgets', async () => {
    const browserController = controller({
      ok: false,
      code: 'consent_denied',
      message: 'user denied'
    })
    const awaitApproval = vi.fn(async () => 'allow' as const)
    const host = localToolHost(browserController)
    const activeContext = context({
      approvalPolicy: 'always',
      awaitApproval
    })
    const first = await host.execute({
      callId: 'call-click-1',
      toolName: 'browser_use',
      arguments: {
        action: 'click',
        ref: 'opaque-reference-1234'
      }
    }, activeContext)
    expect(first.item).toMatchObject({
      kind: 'tool_result',
      isError: true,
      output: { code: 'consent_denied' }
    })
    expect(awaitApproval).not.toHaveBeenCalled()
    expect(browserController.execute).toHaveBeenCalledOnce()

    const second = await host.execute({
      callId: 'call-click-2',
      toolName: 'browser_use',
      arguments: {
        action: 'click',
        ref: 'another-reference-1234'
      }
    }, activeContext)
    expect(second.item).toMatchObject({
      kind: 'tool_result',
      isError: true,
      output: { code: 'action_budget_exhausted' }
    })
    expect(browserController.execute).toHaveBeenCalledOnce()
  })

  it('projects screenshots into the bounded model image pipeline', async () => {
    const browserController = controller({
      ok: true,
      code: 'screenshot',
      message: 'captured',
      image: { mediaType: 'image/png', data: 'PNGDATA' }
    })
    const host = localToolHost(browserController)
    const result = await host.execute({
      callId: 'call-screenshot',
      toolName: 'browser_use',
      arguments: { action: 'screenshot' }
    }, context())
    expect(result.item).toMatchObject({
      kind: 'tool_result',
      output: {
        kind: 'browser_screenshot',
        images: [{ data_base64: 'PNGDATA' }]
      }
    })
  })
})
