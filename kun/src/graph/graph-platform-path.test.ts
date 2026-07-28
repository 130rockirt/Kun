import { describe, expect, it } from 'vitest'
import {
  graphRelativePathCovers,
  graphRelativePathsOverlap,
  normalizeGraphRelativePath
} from '../contracts/graph-path.js'
import {
  graphPhysicalPathIdentity,
  graphPhysicalPathsEqual,
  isGraphPhysicalPathContained
} from './graph-platform-path.js'
import { normalizeRemoteIdentity } from './project-agent-registry-policy.js'

describe('Graph three-platform path policy', () => {
  it('persists repository paths in one portable representation', () => {
    expect(normalizeGraphRelativePath('.\\src\\feature\\index.ts'))
      .toBe('src/feature/index.ts')
    expect(normalizeGraphRelativePath('src//feature/./index.ts'))
      .toBe('src/feature/index.ts')
    expect(() => normalizeGraphRelativePath('C:\\repo\\index.ts')).toThrow()
    expect(() => normalizeGraphRelativePath('\\\\server\\share\\index.ts')).toThrow()
    expect(() => normalizeGraphRelativePath('../index.ts')).toThrow()
  })

  it('uses case-insensitive logical conflicts only for Windows hosts', () => {
    expect(graphRelativePathCovers('SRC', 'src/feature', true)).toBe(true)
    expect(graphRelativePathCovers('SRC', 'src/feature', false)).toBe(false)
    expect(graphRelativePathsOverlap(['src'], ['SRC/generated'], true)).toBe(true)
    expect(graphRelativePathsOverlap(['src'], ['SRC/generated'], false)).toBe(false)
  })

  it('compares and contains native Windows paths without prefix confusion', () => {
    expect(graphPhysicalPathsEqual(
      'C:\\Users\\Kun\\Project',
      'c:/users/kun/project',
      'win32'
    )).toBe(true)
    expect(isGraphPhysicalPathContained(
      'C:\\Users\\Kun\\Graph',
      'c:/users/kun/graph/worktrees/run_1',
      'win32'
    )).toBe(true)
    expect(isGraphPhysicalPathContained(
      'C:\\Users\\Kun\\Graph',
      'C:\\Users\\Kun\\Graph-escape\\run_1',
      'win32'
    )).toBe(false)
    expect(isGraphPhysicalPathContained(
      'C:\\Users\\Kun\\Graph',
      'C:\\Users\\Kun\\Graph',
      'win32'
    )).toBe(false)
  })

  it('keeps POSIX paths case-sensitive and stable', () => {
    expect(graphPhysicalPathsEqual('/workspace/Graph', '/workspace/graph', 'linux'))
      .toBe(false)
    expect(graphPhysicalPathIdentity('/workspace/graph/../graph', 'darwin'))
      .toBe('/workspace/graph')
    expect(isGraphPhysicalPathContained(
      '/workspace/graph',
      '/workspace/graph/worktrees/run_1',
      'linux'
    )).toBe(true)
  })

  it('normalizes a Windows local Git remote as a physical path, not SCP syntax', () => {
    expect(normalizeRemoteIdentity('C:\\Repos\\Kun.git')).toBe('c:/repos/kun')
  })
})
