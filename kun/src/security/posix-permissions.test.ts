import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  applyPosixMode,
  applyPosixModeSync,
  shouldApplyPosixMode
} from './posix-permissions.js'

describe('POSIX permission compatibility', () => {
  it('classifies Windows as non-POSIX without weakening Unix platforms', () => {
    expect(shouldApplyPosixMode('win32')).toBe(false)
    expect(shouldApplyPosixMode('darwin')).toBe(true)
    expect(shouldApplyPosixMode('linux')).toBe(true)
  })

  it('skips chmod on Windows and preserves errors on POSIX', async () => {
    const missing = join(tmpdir(), `kun-missing-permissions-${process.pid}`)
    if (process.platform === 'win32') {
      await expect(applyPosixMode(missing, 0o700)).resolves.toBeUndefined()
      expect(() => applyPosixModeSync(missing, 0o700)).not.toThrow()
      return
    }
    await expect(applyPosixMode(missing, 0o700)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(() => applyPosixModeSync(missing, 0o700)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
  })
})
