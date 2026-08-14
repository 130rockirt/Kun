import { describe, expect, it } from 'vitest'
import { buildDesignTaskProfileInstruction } from './design-task-profile.js'

describe('buildDesignTaskProfileInstruction', () => {
  it('pins image output, app sizing, root style source, and visual context', () => {
    const instruction = buildDesignTaskProfileInstruction({
      version: 1,
      documentTarget: { documentId: 'doc_clone', boardArtifactId: 'board_main' },
      outputMedium: 'image',
      target: 'app',
      preset: 'none',
      presetSource: 'root-design-md',
      styleSnapshot: {
        version: 1,
        source: 'root-design-md',
        sourceHash: 'hash-at-admission',
        sourceName: 'Project',
        content: '{"colors":{"primary":{"hex":"#123456"}}}'
      },
      context: { brandColor: '#123456', tone: ['editorial'] },
      lockedAtTurnId: 'turn_lock'
    })
    expect(instruction).toContain('generated raster image')
    expect(instruction).toContain('390x844')
    expect(instruction).toContain('immutable root DESIGN.md snapshot')
    expect(instruction).toContain('hash-at-admission')
    expect(instruction).toContain('Do not re-read the current workspace file')
    expect(instruction).toContain('doc_clone')
    expect(instruction).toContain('#123456')
    expect(instruction).toContain('Do not inherit mutable settings')
  })
})
