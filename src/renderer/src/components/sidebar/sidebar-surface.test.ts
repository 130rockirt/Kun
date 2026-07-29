import { describe, expect, it } from 'vitest'

describe('shared sidebar surfaces', () => {
  it('keeps workbench side panels on the same semantic background', async () => {
    const nodeFs = 'node:fs/promises'
    const { readFile } = await import(/* @vite-ignore */ nodeFs)
    const sourceUrls = [
      new URL('../plan/PlanPanel.tsx', import.meta.url),
      new URL('../write/WriteAssistantPanel.tsx', import.meta.url),
      new URL('../sdd/SddAssistantPanel.tsx', import.meta.url),
      new URL('../design/DesignAIRail.tsx', import.meta.url),
      new URL('../design/DesignImplementPanel.tsx', import.meta.url),
      new URL('../workbench/WorkbenchRightPanel.tsx', import.meta.url),
      new URL('../chat/SideConversationPanel.tsx', import.meta.url),
      new URL('../DevBrowserPanel.tsx', import.meta.url),
      new URL('../AgentBrowserPanel.tsx', import.meta.url)
    ]
    const sources = await Promise.all(sourceUrls.map((url) => readFile(url, 'utf8')))
    const surfaces = await readFile(
      new URL('../../styles/surfaces-write.css', import.meta.url),
      'utf8'
    )

    expect(surfaces).toContain('.ds-sidebar-surface')
    expect(surfaces).toContain('background: var(--ds-sidebar-surface-bg)')
    for (const source of sources) {
      expect(source).toContain('ds-sidebar-surface')
    }
  })
})
