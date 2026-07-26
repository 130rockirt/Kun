import { describe, expect, it } from 'vitest'
import { graphPathScopedToolNames } from './graph-security-policy.js'

describe('Graph scoped tool policy', () => {
  it('removes process and whole-workspace tools from narrow assignments', () => {
    expect(graphPathScopedToolNames(
      ['read', 'write', 'bash', 'repo_map', 'graph_worker_progress'],
      ['src'],
      ['src/generated']
    )).toEqual(['read', 'write', 'graph_worker_progress'])
  })

  it('preserves the authorized tool snapshot for a full-workspace assignment', () => {
    expect(graphPathScopedToolNames(
      ['read', 'bash', 'repo_map'],
      ['.'],
      ['.']
    )).toEqual(['read', 'bash', 'repo_map'])
  })
})
