import { describe, expect, it } from 'vitest'
import {
  antigravityCliAsset,
  antigravityCliBinaryName,
  parseAntigravityModels
} from './antigravity-cli'

describe('Antigravity CLI integration', () => {
  it('maps supported release assets with pinned checksums', () => {
    expect(antigravityCliAsset('darwin', 'arm64')).toMatchObject({
      name: 'agy_cli_mac_arm64.tar.gz',
      archiveKind: 'tar.gz',
      binaryName: 'antigravity'
    })
    expect(antigravityCliAsset('win32', 'x64')?.sha256).toHaveLength(64)
    expect(antigravityCliAsset('aix', 'ppc64')).toBeUndefined()
    expect(antigravityCliBinaryName('win32')).toBe('agy.exe')
  })

  it('groups effort variants while retaining every account-visible model family', () => {
    expect(parseAntigravityModels([
      'gemini-3.6-flash-high',
      'gemini-3.6-flash-medium',
      'gemini-3.6-flash-low',
      'gemini-3.5-flash-high',
      'gemini-3.5-flash-low',
      'gemini-3.1-pro-high',
      'gemini-3.1-pro-low',
      'claude-sonnet-4-6',
      'claude-opus-4-6-thinking',
      'gpt-oss-120b-medium',
      ''
    ].join('\n'))).toEqual({
      models: [
        {
          id: 'gemini-3.6-flash',
          supportedEfforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium'
        },
        {
          id: 'gemini-3.5-flash',
          supportedEfforts: ['low', 'high'],
          defaultEffort: 'high'
        },
        {
          id: 'gemini-3.1-pro',
          supportedEfforts: ['low', 'high'],
          defaultEffort: 'high'
        },
        {
          id: 'claude-sonnet-4-6',
          supportedEfforts: ['medium'],
          defaultEffort: 'medium'
        },
        {
          id: 'claude-opus-4-6-thinking',
          supportedEfforts: ['medium'],
          defaultEffort: 'medium'
        },
        {
          id: 'gpt-oss-120b',
          supportedEfforts: ['medium'],
          defaultEffort: 'medium'
        }
      ]
    })
  })

  it('ignores diagnostic text and malformed model ids', () => {
    expect(parseAntigravityModels([
      'Loading models...',
      'gemini-3.6-flash-medium',
      'not/a-model',
      `model-${'x'.repeat(130)}`
    ].join('\n'))).toEqual({
      models: [{
        id: 'gemini-3.6-flash',
        supportedEfforts: ['medium'],
        defaultEffort: 'medium'
      }]
    })
  })
})
