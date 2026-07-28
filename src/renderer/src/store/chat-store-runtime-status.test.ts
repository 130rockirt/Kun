import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RuntimeStatusEventPayload } from '../agent/types'
import i18n from '../i18n'
import { runtimeStatusText } from './chat-store-runtime'

function graphGate(
  phase: NonNullable<RuntimeStatusEventPayload['phase']>,
  attempt: number,
  failureSummary?: string
): RuntimeStatusEventPayload {
  return {
    kind: 'required_tool_gate',
    itemId: 'graph_gate',
    toolName: 'graph_create_run',
    phase,
    attempt,
    maxAttempts: 3,
    ...(failureSummary ? { failureSummary } : {})
  }
}

describe('Graph creation runtime status text', () => {
  const previousLanguage = i18n.language

  beforeAll(async () => {
    await i18n.changeLanguage('en')
  })

  afterAll(async () => {
    await i18n.changeLanguage(previousLanguage)
  })

  it('presents the first request as normal preparation without a retry fraction', () => {
    const text = runtimeStatusText(graphGate('preparing', 1))

    expect(text).toBe('Generating Graph execution plan')
    expect(text).not.toContain('1/3')
    expect(text).not.toContain('retry')
  })

  it.each([
    [2, 'retry 1/2'],
    [3, 'retry 2/2']
  ])('shows attempt %s as an actual bounded correction', (attempt, retryLabel) => {
    const text = runtimeStatusText(graphGate(
      'retrying',
      attempt,
      ' plan.nodes.0.readScopes: Expected a repository-relative path '
    ))

    expect(text).toContain(retryLabel)
    expect(text).toContain(
      'Reason: plan.nodes.0.readScopes: Expected a repository-relative path'
    )
  })

  it('shows success without an attempt fraction and terminal failure with its reason', () => {
    expect(runtimeStatusText(graphGate('succeeded', 2)))
      .toBe('Graph execution plan created')
    expect(runtimeStatusText(graphGate('failed', 3, 'plan.edges.0.from: Unknown node')))
      .toBe('Graph execution plan failed · Reason: plan.edges.0.from: Unknown node')
  })
})
