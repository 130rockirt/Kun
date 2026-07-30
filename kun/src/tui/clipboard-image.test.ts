import { access, writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  ClipboardImageError,
  clipboardImageEmptyHint,
  readClipboardImage,
  type ClipboardCommandRunner
} from './clipboard-image.js'

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0, 0, 0, 0, 0x49, 0x48, 0x44, 0x52
])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])

const unavailable = {
  ok: false,
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  unavailable: true
}

describe('system clipboard image reader', () => {
  it('reads a macOS screenshot through a private temporary PNG and removes it', async () => {
    let clipboardPath = ''
    const run: ClipboardCommandRunner = vi.fn(async (command, args) => {
      expect(command).toBe('osascript')
      clipboardPath = args.at(-1) ?? ''
      await writeFile(clipboardPath, PNG)
      return { ok: true, stdout: Buffer.from('ok\n'), stderr: Buffer.alloc(0) }
    })

    const image = await readClipboardImage({ platform: 'darwin', runCommand: run })

    expect(image).toMatchObject({ mimeType: 'image/png', source: 'macos' })
    expect(image?.bytes).toEqual(PNG)
    await expect(access(clipboardPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reads a Windows screenshot as bounded base64 output', async () => {
    const run: ClipboardCommandRunner = vi.fn(async (command, args) => {
      expect(command).toBe('powershell.exe')
      expect(args).toContain('-STA')
      return {
        ok: true,
        stdout: Buffer.from(PNG.toString('base64')),
        stderr: Buffer.alloc(0)
      }
    })

    await expect(readClipboardImage({ platform: 'win32', runCommand: run })).resolves.toMatchObject({
      bytes: PNG,
      mimeType: 'image/png',
      source: 'windows'
    })
  })

  it('prefers an advertised Wayland image type and preserves its real MIME type', async () => {
    const run: ClipboardCommandRunner = vi.fn(async (command, args) => {
      expect(command).toBe('wl-paste')
      if (args.includes('--list-types')) {
        return {
          ok: true,
          stdout: Buffer.from('text/plain\nimage/jpeg\n'),
          stderr: Buffer.alloc(0)
        }
      }
      expect(args).toEqual(['--type', 'image/jpeg'])
      return { ok: true, stdout: JPEG, stderr: Buffer.alloc(0) }
    })

    await expect(readClipboardImage({
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      runCommand: run
    })).resolves.toMatchObject({
      bytes: JPEG,
      mimeType: 'image/jpeg',
      source: 'wayland'
    })
  })

  it('falls back from X11 to the Windows clipboard under WSL', async () => {
    const run: ClipboardCommandRunner = vi.fn(async (command) => {
      if (command === 'xclip') return unavailable
      expect(command).toBe('powershell.exe')
      return {
        ok: true,
        stdout: Buffer.from(PNG.toString('base64')),
        stderr: Buffer.alloc(0)
      }
    })

    await expect(readClipboardImage({
      platform: 'linux',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      osRelease: 'microsoft-standard-WSL2',
      runCommand: run
    })).resolves.toMatchObject({
      mimeType: 'image/png',
      source: 'wsl'
    })
  })

  it('returns null for an empty clipboard and rejects invalid or oversized image output', async () => {
    const empty: ClipboardCommandRunner = vi.fn(async () => ({
      ok: true,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0)
    }))
    await expect(readClipboardImage({ platform: 'win32', runCommand: empty })).resolves.toBeNull()

    const invalid: ClipboardCommandRunner = vi.fn(async () => ({
      ok: true,
      stdout: Buffer.from(Buffer.from('not an image').toString('base64')),
      stderr: Buffer.alloc(0)
    }))
    await expect(readClipboardImage({ platform: 'win32', runCommand: invalid }))
      .rejects.toMatchObject({ code: 'invalid' } satisfies Partial<ClipboardImageError>)

    const oversized: ClipboardCommandRunner = vi.fn(async () => ({
      ok: false,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      overflowed: true
    }))
    await expect(readClipboardImage({ platform: 'win32', runCommand: oversized }))
      .rejects.toMatchObject({ code: 'too-large' } satisfies Partial<ClipboardImageError>)
  })

  it('explains local, Windows, Linux, and remote clipboard recovery', () => {
    expect(clipboardImageEmptyHint('darwin', {})).toContain('⌘V')
    expect(clipboardImageEmptyHint('darwin', {})).toContain('Ctrl+X V')
    expect(clipboardImageEmptyHint('win32', {})).toContain('Alt+V')
    expect(clipboardImageEmptyHint('linux', {})).toContain('wl-clipboard')
    expect(clipboardImageEmptyHint('linux', { SSH_TTY: '/dev/pts/1' })).toContain('/attach <path>')
  })
})
