import { describe, expect, it } from 'vitest'
import { parseDelegateDetail } from './subagent-call-card-support'

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
})
