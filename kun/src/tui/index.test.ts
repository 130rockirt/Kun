import { describe, expect, it, vi } from 'vitest'
import { runTuiCommand } from './index.js'

describe('runTuiCommand', () => {
  it('prints TUI help without requiring a terminal or a runtime', async () => {
    let stdout = ''
    const fetch = vi.fn()
    const code = await runTuiCommand(['--help'], {
      stdin: { isTTY: false } as unknown as NodeJS.ReadableStream,
      stdout: { write: (chunk) => { stdout += chunk } },
      stderr: { write: vi.fn() },
      fetch: fetch as unknown as typeof globalThis.fetch
    })
    expect(code).toBe(0)
    expect(stdout).toContain('kun [tui options]')
    expect(stdout).toContain('GUI and TUI can be open at the same time')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects non-TTY use before discovery or terminal output', async () => {
    let stderr = ''
    let stdout = ''
    const fetch = vi.fn()
    const code = await runTuiCommand([], {
      stdin: { isTTY: false } as unknown as NodeJS.ReadableStream,
      stdout: { isTTY: false, write: (chunk: string) => { stdout += chunk } },
      stderr: { write: (chunk) => { stderr += chunk } },
      fetch: fetch as unknown as typeof globalThis.fetch
    })
    expect(code).toBe(64)
    expect(stderr).toContain('a TTY is required')
    expect(stdout).not.toContain('\x1b[?1049h')
    expect(fetch).not.toHaveBeenCalled()
  })
})
