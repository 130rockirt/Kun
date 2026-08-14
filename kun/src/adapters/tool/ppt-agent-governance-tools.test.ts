import { describe, expect, it } from 'vitest'
import type { ToolHostContext } from '../../ports/tool-host.js'
import {
  buildPptAgentGovernanceTools,
  PPT_SUBMIT_DESIGN_PLAN_TOOL_NAME
} from './ppt-agent-governance-tools.js'

describe('PPT design governance tool schema', () => {
  it('requires structured background treatment and visual effects on new plans', () => {
    const tool = buildPptAgentGovernanceTools({}, () => true)
      .find((candidate) => candidate.name === PPT_SUBMIT_DESIGN_PLAN_TOOL_NAME)!
    const plan = (tool.inputSchema.properties as Record<string, {
      properties: Record<string, unknown>
      required: string[]
    }>).plan
    expect(plan.required).toEqual(expect.arrayContaining(['backgroundTreatment', 'effects']))
    expect(plan.properties.backgroundTreatment).toMatchObject({ oneOf: expect.any(Array) })
    expect(plan.properties.effects).toMatchObject({
      uniqueItems: true,
      items: { enum: ['glow', 'glass', 'particles', 'ornamental-grid'] }
    })
  })

  it('blocks guide and plan mutations during approval', async () => {
    const tools = buildPptAgentGovernanceTools({}, () => true)
    const context: ToolHostContext = {
      threadId: 'child_ppt',
      turnId: 'turn_approve',
      workspace: process.cwd(),
      approvalPolicy: 'auto',
      awaitApproval: async () => 'allow',
      abortSignal: new AbortController().signal,
      pptWorkflowScope: {
        action: 'approve_and_build',
        workflowId: 'ppt_workflow',
        projectDir: '.kun/ppt/ppt_workflow',
        parentThreadId: 'thr_parent',
        previewMode: 'image-first'
      }
    }
    const guide = tools.find((tool) => tool.name === 'ppt_read_guide')!
    const plan = tools.find((tool) => tool.name === PPT_SUBMIT_DESIGN_PLAN_TOOL_NAME)!
    expect(guide.shouldAdvertise?.(context)).toBe(false)
    expect(plan.shouldAdvertise?.(context)).toBe(false)

    for (const result of await Promise.all([
      guide.execute({ path: 'pptd.md' }, context),
      plan.execute({
        workflowId: 'ppt_workflow', projectDir: '.kun/ppt/ppt_workflow', plan: {}
      }, context)
    ])) {
      expect(result).toMatchObject({ isError: true })
      expect(JSON.stringify(result.output)).toContain('unavailable during approve_and_build')
    }
  })
})
