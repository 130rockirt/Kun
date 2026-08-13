import { describe, expect, it } from 'vitest'
import { parseDelegateDetail, parseFastContextEvidencePack } from './subagent-call-card-support'

describe('parseDelegateDetail', () => {
  it('reads the generated role name from the direct generated-agent result', () => {
    expect(parseDelegateDetail(JSON.stringify({
      profile: 'generated:ipc-investigator:12345678',
      profileName: 'IPC Investigator',
      model: 'gpt-5.6-sol',
      generatedAgent: { name: 'IPC Investigator' }
    }))).toMatchObject({
      generated: true,
      generatedAgentName: 'IPC Investigator',
      profileName: 'IPC Investigator',
      model: 'gpt-5.6-sol'
    })
  })

  it('falls back to the generated role snapshot embedded in routing metadata', () => {
    expect(parseDelegateDetail(JSON.stringify({
      profile: 'generated:browser-qa:12345678',
      routing: {
        selectedKind: 'generated',
        agent: { name: 'Browser QA Specialist' }
      }
    }))).toMatchObject({
      generated: true,
      generatedAgentName: 'Browser QA Specialist'
    })
  })

  it('reads explore_agent title and query from the tool payload', () => {
    expect(parseDelegateDetail(JSON.stringify({
      childId: 'child_explore',
      status: 'running',
      title: 'Voice transcription flow',
      query: 'Find how speech transcription is wired',
      profile: 'explore'
    }))).toMatchObject({
      childId: 'child_explore',
      status: 'running',
      title: 'Voice transcription flow',
      query: 'Find how speech transcription is wired',
      profile: 'explore'
    })
  })

  it('normalizes a single Fast Context child and bounded evidence pack', () => {
    const detail = JSON.stringify({
      status: 'completed',
      label: 'Fast Context retrieval',
      child: {
        childId: 'child_fast_context',
        status: 'completed',
        profile: 'explore',
        profileName: 'Repository Explorer',
        model: 'gpt-5.6-mini'
      },
      evidencePack: {
        version: 1,
        tasks: [{
          index: 0,
          title: 'Trace renderer',
          query: 'Find the explore card',
          evidence: [{
            path: 'src/renderer/src/components/chat/SubagentCallCard.tsx',
            ranges: [[42, 93]],
            excerpt: 'export function SubagentCallCard',
            reason: 'Renders the child session card'
          }],
          conclusion: 'The card is the integration point.',
          uncertainties: ['No dedicated evidence view yet.']
        }],
        uncertainties: ['Runtime shape may evolve.']
      }
    })

    expect(parseDelegateDetail(detail)).toMatchObject({
      childId: 'child_fast_context',
      status: 'completed',
      title: 'Fast Context retrieval',
      profile: 'explore',
      model: 'gpt-5.6-mini'
    })
    expect(parseFastContextEvidencePack(detail)).toMatchObject({
      version: 1,
      evidenceCount: 1,
      tasks: [{ title: 'Trace renderer', evidence: [{ path: 'src/renderer/src/components/chat/SubagentCallCard.tsx' }] }]
    })
  })

  it('ignores malformed Fast Context evidence instead of throwing', () => {
    expect(parseFastContextEvidencePack(JSON.stringify({
      evidencePack: { version: 1, tasks: [{ index: 0, title: 'Missing query', evidence: [] }] }
    }))).toBeUndefined()
  })
})
