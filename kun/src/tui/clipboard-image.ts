import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { release, tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_COMMAND_OUTPUT_BYTES = Math.ceil(MAX_CLIPBOARD_IMAGE_BYTES * 4 / 3) + 64 * 1024
const COMMAND_TIMEOUT_MS = 3_000

const MACOS_PNG_SCRIPT = `
on run argv
  set targetPath to item 1 of argv
  try
    set imageData to the clipboard as "PNGf"
    set fileRef to open for access POSIX file targetPath with write permission
    set eof fileRef to 0
    write imageData to fileRef
    close access fileRef
    return "ok"
  on error
    try
      close access fileRef
    end try
    return "empty"
  end try
end run
`

const POWERSHELL_PNG_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms;',
  'Add-Type -AssemblyName System.Drawing;',
  '$image = [System.Windows.Forms.Clipboard]::GetImage();',
  'if ($null -ne $image) {',
  '$stream = New-Object System.IO.MemoryStream;',
  '$image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png);',
  '[Console]::Out.Write([System.Convert]::ToBase64String($stream.ToArray()));',
  '$stream.Dispose();',
  '$image.Dispose();',
  '}'
].join(' ')

export type ClipboardImage = {
  bytes: Buffer
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  source: 'macos' | 'windows' | 'wsl' | 'wayland' | 'x11'
}

export type ClipboardCommandResult = {
  ok: boolean
  stdout: Buffer
  stderr: Buffer
  overflowed?: boolean
  unavailable?: boolean
}

export type ClipboardCommandRunner = (
  command: string,
  args: readonly string[],
  options?: { timeoutMs?: number; maxOutputBytes?: number }
) => Promise<ClipboardCommandResult>

export type ReadClipboardImageOptions = {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  osRelease?: string
  runCommand?: ClipboardCommandRunner
}

export class ClipboardImageError extends Error {
  constructor(
    message: string,
    readonly code: 'too-large' | 'unavailable' | 'invalid'
  ) {
    super(message)
    this.name = 'ClipboardImageError'
  }
}

/**
 * Read an image directly from the operating-system clipboard.
 *
 * Terminal bracketed paste transports text only, so screenshot paste needs an
 * explicit OS clipboard path just like Kimi Code and OpenCode. Commands are
 * invoked without a shell, use bounded output, and have short timeouts.
 */
export async function readClipboardImage(
  options: ReadClipboardImageOptions = {}
): Promise<ClipboardImage | null> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const run = options.runCommand ?? runClipboardCommand

  if (env['TERMUX_VERSION']) return null
  if (platform === 'darwin') return readMacOsClipboardImage(run)
  if (platform === 'win32') return readPowerShellClipboardImage(run, 'windows')

  if (platform === 'linux') {
    const wayland = Boolean(env['WAYLAND_DISPLAY']) ||
      env['XDG_SESSION_TYPE']?.toLowerCase() === 'wayland'
    const wsl = Boolean(env['WSL_DISTRO_NAME']) ||
      (options.osRelease ?? release()).toLowerCase().includes('microsoft')

    if (wayland) {
      const image = await readClipboardImageFromCommand(
        run,
        'wl-paste',
        ['--list-types'],
        (mimeType) => ['--type', mimeType],
        'wayland'
      )
      if (image) return image
    }

    const x11 = await readClipboardImageFromCommand(
      run,
      'xclip',
      ['-selection', 'clipboard', '-t', 'TARGETS', '-o'],
      (mimeType) => ['-selection', 'clipboard', '-t', mimeType, '-o'],
      'x11'
    )
    if (x11) return x11

    if (wsl) return readPowerShellClipboardImage(run, 'wsl')

    // Some compositors expose wl-paste without the usual environment marker.
    if (!wayland) {
      return readClipboardImageFromCommand(
        run,
        'wl-paste',
        ['--list-types'],
        (mimeType) => ['--type', mimeType],
        'wayland'
      )
    }
  }

  return null
}

export function clipboardImageEmptyHint(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (env['SSH_CONNECTION'] || env['SSH_TTY']) {
    return 'No image was found in the remote clipboard. Copy an image on the runtime host, or use /attach <path>.'
  }
  if (platform === 'win32') {
    return 'No image was found in the clipboard. Copy a screenshot, then press Alt+V or Ctrl+X V (or run /paste).'
  }
  if (platform === 'linux') {
    return 'No image was found in the clipboard. Copy a screenshot, then press Ctrl+V or Ctrl+X V; Wayland needs wl-clipboard and X11 needs xclip.'
  }
  return 'No image was found in the clipboard. Copy a screenshot, then press ⌘V when the terminal forwards it, or use Ctrl+X V (or /paste).'
}

export async function runClipboardCommand(
  command: string,
  args: readonly string[],
  options: { timeoutMs?: number; maxOutputBytes?: number } = {}
): Promise<ClipboardCommandResult> {
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? MAX_COMMAND_OUTPUT_BYTES

  return new Promise((resolve) => {
    let settled = false
    let overflowed = false
    let stdoutSize = 0
    let stderrSize = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const finish = (result: ClipboardCommandResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    let child
    try {
      child = spawn(command, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      finish({ ok: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), unavailable: true })
      return
    }

    timer = setTimeout(() => {
      child.kill()
      finish({
        ok: false,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr)
      })
    }, timeoutMs)
    timer.unref?.()

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutSize += chunk.length
      if (stdoutSize > maxOutputBytes) {
        overflowed = true
        child.kill()
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrSize += chunk.length
      if (stderrSize <= 64 * 1024) stderr.push(chunk)
    })
    child.once('error', () => {
      finish({
        ok: false,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        unavailable: true
      })
    })
    child.once('close', (code) => {
      finish({
        ok: code === 0 && !overflowed,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        ...(overflowed ? { overflowed: true } : {})
      })
    })
  })
}

async function readMacOsClipboardImage(run: ClipboardCommandRunner): Promise<ClipboardImage | null> {
  const directory = await mkdtemp(join(tmpdir(), 'kun-clipboard-'))
  const path = join(directory, 'clipboard.png')
  try {
    const result = await run('osascript', ['-e', MACOS_PNG_SCRIPT, path], {
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024
    })
    if (!result.ok || result.stdout.toString('utf8').trim() !== 'ok') return null
    const metadata = await stat(path).catch(() => undefined)
    if (!metadata?.isFile() || metadata.size === 0) return null
    if (metadata.size > MAX_CLIPBOARD_IMAGE_BYTES) throw imageTooLarge()
    return validateImage(await readFile(path), 'image/png', 'macos')
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function readPowerShellClipboardImage(
  run: ClipboardCommandRunner,
  source: 'windows' | 'wsl'
): Promise<ClipboardImage | null> {
  const result = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-STA',
    '-Command',
    POWERSHELL_PNG_SCRIPT
  ], {
    timeoutMs: 5_000,
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES
  })
  if (result.overflowed) throw imageTooLarge()
  if (!result.ok) return null
  const base64 = result.stdout.toString('utf8').replace(/\s+/gu, '')
  if (!base64) return null
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length === 0) return null
  if (bytes.length > MAX_CLIPBOARD_IMAGE_BYTES) throw imageTooLarge()
  return validateImage(bytes, 'image/png', source)
}

async function readClipboardImageFromCommand(
  run: ClipboardCommandRunner,
  command: string,
  listArgs: readonly string[],
  dataArgs: (mimeType: string) => readonly string[],
  source: 'wayland' | 'x11'
): Promise<ClipboardImage | null> {
  const targets = await run(command, listArgs, {
    timeoutMs: 1_000,
    maxOutputBytes: 64 * 1024
  })
  if (!targets.ok) return null
  const advertised = targets.stdout.toString('utf8')
    .split(/\s+/u)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  const mimeType = preferredImageMimeType(advertised)
  if (!mimeType) return null
  const image = await run(command, dataArgs(mimeType), {
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: MAX_CLIPBOARD_IMAGE_BYTES + 1
  })
  if (image.overflowed) throw imageTooLarge()
  if (!image.ok || image.stdout.length === 0) return null
  if (image.stdout.length > MAX_CLIPBOARD_IMAGE_BYTES) throw imageTooLarge()
  return validateImage(image.stdout, normalizeImageMimeType(mimeType), source)
}

function preferredImageMimeType(values: readonly string[]): string | undefined {
  const priorities = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp']
  return priorities.find((mimeType) => values.includes(mimeType))
}

function normalizeImageMimeType(value: string): ClipboardImage['mimeType'] {
  if (value === 'image/jpg') return 'image/jpeg'
  if (value === 'image/jpeg' || value === 'image/webp') return value
  return 'image/png'
}

function validateImage(
  bytes: Buffer,
  _advertisedMimeType: ClipboardImage['mimeType'],
  source: ClipboardImage['source']
): ClipboardImage {
  const detectedMimeType = sniffImageMimeType(bytes)
  if (!detectedMimeType) {
    throw new ClipboardImageError('The clipboard data was not a supported PNG, JPEG, or WebP image.', 'invalid')
  }
  return {
    bytes,
    mimeType: detectedMimeType,
    source
  }
}

function sniffImageMimeType(bytes: Buffer): ClipboardImage['mimeType'] | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes.subarray(1, 4).toString('ascii') === 'PNG' &&
    bytes.subarray(4, 8).equals(Buffer.from([0x0d, 0x0a, 0x1a, 0x0a]))
  ) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp'
  return undefined
}

function imageTooLarge(): ClipboardImageError {
  return new ClipboardImageError('The clipboard image exceeds Kun’s 10 MiB upload limit.', 'too-large')
}
