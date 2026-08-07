// @ts-nocheck
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const DESIGN_ROOTS = [
  'src/renderer/src/components/design',
  'src/renderer/src/design'
]

function collectSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir)
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(fullPath))
      continue
    }
    if (/\.(test\.)?[tj]sx?$/.test(fullPath)) files.push(fullPath)
  }
  return files
}

describe('design module boundaries', () => {
  it('keeps design source files at or below 700 lines', () => {
    const exemptLongFiles = new Set([
      'src/renderer/src/design/design-board.test.ts',
      'src/renderer/src/design/design-board.ts'
    ])
    const oversized = DESIGN_ROOTS
      .flatMap((root) => collectSourceFiles(root))
      .map((file) => ({
        file,
        lines: readFileSync(file, 'utf8').split(/\r?\n/).length
      }))
      .filter(({ file, lines }) => lines > 700 && !exemptLongFiles.has(file.replace(/\\/g, '/')))

    expect(oversized).toEqual([])
  })

  it('uses functional module names instead of mechanical split suffixes', () => {
    const mechanicalNames = DESIGN_ROOTS
      .flatMap((root) => collectSourceFiles(root))
      .map((file) => file.replace(/\\/g, '/'))
      .filter((file) =>
        /(?:^|\/)(?:chunk-\d+|helpers-\d+|static-audit-rules-\d+|runtime-script-segment-.+)\.(?:test\.)?[tj]sx?$/.test(file) ||
        /(?:auditdesignhtmlquality|builddesignhtmlqualityrepairprompt|prototype-player|design-turn-prompt)-\d+\.test\.tsx?$/.test(file)
      )

    expect(mechanicalNames).toEqual([])
  })

  it('keeps the unified preview host as the only webview creator', () => {
    const webviewFiles = DESIGN_ROOTS
      .flatMap((root) => collectSourceFiles(root))
      .filter((file) => /<webview[\s/]/.test(readFileSync(file, 'utf8')))
      .map((file) => file.replace(/\\/g, '/'))

    expect(webviewFiles).toEqual([
      'src/renderer/src/components/design/DesignHtmlPreviewHost.tsx'
    ])
  })

  it('does not keep the legacy project canvas preview around', () => {
    expect(existsSync('src/renderer/src/components/design/DesignProjectCanvas.tsx')).toBe(false)
  })
})
