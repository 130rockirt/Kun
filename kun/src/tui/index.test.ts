import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('refuses an unpublished GUI-private writer instead of attaching to it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-tui-private-gui-'))
    const dataDir = join(root, 'data')
    const settingsPath = join(root, 'gui', 'kun-settings.json')
    await mkdir(join(root, 'gui'), { recursive: true })
    await writeFile(settingsPath, JSON.stringify({
      provider: { providers: [] },
      agents: {
        kun: {
          dataDir,
          model: '',
          providerId: '',
          port: 18899,
          runtimeToken: 'legacy-token'
        }
      }
    }))
    let stderr = ''
    const fetch = vi.fn(async () => Response.json({ dataDir }))
    try {
      const code = await runTuiCommand([], {
        stdin: { isTTY: true } as unknown as NodeJS.ReadableStream,
        stdout: { isTTY: true, write: () => undefined },
        stderr: { write: (chunk) => { stderr += chunk } },
        env: { KUN_GUI_SETTINGS_PATH: settingsPath },
        fetch: fetch as unknown as typeof globalThis.fetch
      })

      expect(code).toBe(70)
      expect(stderr).toContain('older GUI-private runtime')
      expect(stderr).toContain('UI-independent background runtime')
      expect(fetch).toHaveBeenCalledOnce()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
