import { ExtensionContributionsSchema } from '@kun/extension-api'
import { describe, expect, it } from 'vitest'
import {
  ContributionRegistry,
  ExtensionWorkbenchSnapshotSchema
} from './contribution-registry'
import {
  UNSUPPORTED_DOM_WARNING,
  buildHostContentScriptPlan,
  protectedSurfaceForChatBlocks,
  protectedSurfaceForWorkbench,
  workbenchSurfaceForRoute
} from './content-script-planner'

function contentScripts(surface: 'code' | 'design' = 'code') {
  const registry = new ContributionRegistry()
  registry.replaceExtensions(ExtensionWorkbenchSnapshotSchema.parse({
    schemaVersion: 1,
    revision: 1,
    extensions: [{
      id: 'acme.dom',
      version: '1.0.0',
      workspaceTrusted: true,
      grantedPermissions: ['hostDom'],
      contributes: ExtensionContributionsSchema.parse({
        hostContentScripts: [{
          id: `decorate-${surface}`,
          matches: [`workbench:${surface}`],
          scripts: ['dist/content.js'],
          styles: ['dist/content.css']
        }]
      })
    }]
  }))
  return registry.list('hostContentScripts', { [`workbench.${surface}`]: true })
}

describe('host content-script planning', () => {
  it('creates isolated-world descriptors with a narrow API and unsupported warning', () => {
    const plan = buildHostContentScriptPlan({ contributions: contentScripts(), route: 'chat' })
    expect(plan.surface).toBe('workbench:code')
    expect(plan.descriptors).toHaveLength(1)
    expect(plan.descriptors[0]).toMatchObject({
      extensionId: 'acme.dom',
      isolatedWorld: true,
      api: {
        version: 1,
        globalName: 'kunHost'
      },
      compatibility: { stable: false, warning: UNSUPPORTED_DOM_WARNING }
    })
    expect(plan.descriptors[0]?.worldId).toBeGreaterThanOrEqual(10_000)
    expect(plan.descriptors[0]?.scripts).toEqual(['kun-extension://acme.dom/dist/content.js'])
    expect(plan.descriptors[0]?.api.excludes).toContain('window.kunGui')
  })

  it('never injects into protected surfaces or unsupported management routes', () => {
    const protectedPlan = buildHostContentScriptPlan({
      contributions: contentScripts(),
      route: 'chat',
      protectedSurface: 'extension-permissions'
    })
    expect(protectedPlan.descriptors).toEqual([])
    expect(protectedPlan.diagnostics[0]?.code).toBe('HOST_DOM_PROTECTED_SURFACE_EXCLUDED')

    expect(workbenchSurfaceForRoute('extensions')).toBeNull()
    const managementPlan = buildHostContentScriptPlan({ contributions: contentScripts(), route: 'extensions' })
    expect(managementPlan.descriptors).toEqual([])
  })

  it('keeps the stable Design surface inside the shared Code route', () => {
    expect(workbenchSurfaceForRoute('chat', 'design')).toBe('workbench:design')
    const plan = buildHostContentScriptPlan({
      contributions: contentScripts('design'),
      route: 'chat',
      taskSurface: 'design'
    })
    expect(plan.surface).toBe('workbench:design')
    expect(plan.descriptors).toHaveLength(1)
  })

  it('never exposes settings or onboarding credential DOM to content scripts', () => {
    expect(workbenchSurfaceForRoute('settings')).toBeNull()
    for (const input of [
      { route: 'settings' as const, initialSetupOpen: false },
      { route: 'chat' as const, initialSetupOpen: true }
    ]) {
      const protectedSurface = protectedSurfaceForWorkbench({ ...input, blocks: [] })
      expect(protectedSurface).toBe('account-credentials')
      const plan = buildHostContentScriptPlan({
        contributions: contentScripts(),
        route: input.route,
        protectedSurface
      })
      expect(plan.descriptors).toEqual([])
      expect(plan.diagnostics[0]?.code).toBe('HOST_DOM_PROTECTED_SURFACE_EXCLUDED')
    }
  })

  it('turns a pending/submitting Agent approval into a protected Direct DOM surface', () => {
    expect(protectedSurfaceForChatBlocks([{
      kind: 'approval',
      id: 'approval-block',
      approvalId: 'approval-1',
      summary: 'Run external command',
      status: 'pending'
    }])).toBe('tool-approval')
    expect(protectedSurfaceForChatBlocks([{
      kind: 'approval',
      id: 'approval-block',
      approvalId: 'approval-1',
      summary: 'Run external command',
      status: 'allowed'
    }])).toBeUndefined()
  })
})
