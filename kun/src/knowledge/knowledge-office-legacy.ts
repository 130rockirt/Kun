import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, extname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateModernOfficeArchive } from './knowledge-office-source.js'

const TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 256 * 1024

export type KnowledgeLibreOfficeResult = { stdout: string; stderr: string; exitCode: number }
export type KnowledgeLibreOfficeRunner = (
  binaryPath: string,
  args: readonly string[],
  signal?: AbortSignal
) => Promise<KnowledgeLibreOfficeResult>

export type KnowledgeLegacyOfficeDependencies = {
  resolveBinary?: () => Promise<string | undefined>
  run?: KnowledgeLibreOfficeRunner
  temporaryDirectory?: string
}

export async function withConvertedLegacyOffice<T>(
  sourcePath: string,
  format: 'doc' | 'ppt',
  dependencies: KnowledgeLegacyOfficeDependencies,
  signal: AbortSignal | undefined,
  operation: (convertedPath: string, convertedFormat: 'docx' | 'pptx') => Promise<T>
): Promise<T> {
  const binary = await (dependencies.resolveBinary ?? resolveLibreOfficeBinary)()
  if (!binary) throw new Error('LibreOffice is required to index legacy DOC/PPT files. Install LibreOffice or set KUN_LIBREOFFICE_BINARY.')
  if (signal?.aborted) throw abortError()
  const temporaryDirectory = dependencies.temporaryDirectory ?? tmpdir()
  await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(temporaryDirectory, 'kun-kb-office-'))
  await chmod(root, 0o700).catch(() => undefined)
  const inputDir = join(root, 'input')
  const outputDir = join(root, 'output')
  const profileDir = join(root, 'profile')
  const convertedFormat = format === 'doc' ? 'docx' : 'pptx'
  try {
    await Promise.all([
      mkdir(inputDir, { recursive: true, mode: 0o700 }),
      mkdir(outputDir, { recursive: true, mode: 0o700 }),
      mkdir(profileDir, { recursive: true, mode: 0o700 })
    ])
    const snapshotPath = join(inputDir, `source.${format}`)
    await copyFile(sourcePath, snapshotPath)
    await chmod(snapshotPath, 0o400).catch(() => undefined)
    const args = [
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      '--headless', '--nologo', '--nodefault', '--nolockcheck', '--nofirststartwizard',
      '--convert-to', convertedFormat, '--outdir', outputDir, snapshotPath
    ]
    const result = await (dependencies.run ?? runLibreOffice)(binary, args, signal)
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim()
      throw new Error(detail ? `LibreOffice conversion failed: ${detail}` : 'LibreOffice conversion failed')
    }
    const convertedPath = await findConverted(outputDir, convertedFormat)
    if (!convertedPath) throw new Error('LibreOffice did not produce a converted Office document')
    await validateModernOfficeArchive(convertedPath, convertedFormat)
    return await operation(convertedPath, convertedFormat)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function resolveLibreOfficeBinary(): Promise<string | undefined> {
  const explicit = process.env.KUN_LIBREOFFICE_BINARY?.trim()
  const candidates = explicit ? [explicit] : commonCandidates()
  for (const candidate of candidates) {
    const resolved = await findExecutable(candidate)
    if (resolved) return resolved
  }
  return undefined
}

function commonCandidates(): string[] {
  if (process.platform === 'darwin') return [
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    join(homedir(), 'Applications', 'LibreOffice.app', 'Contents', 'MacOS', 'soffice'),
    'soffice', 'libreoffice'
  ]
  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((value): value is string => Boolean(value))
    return [...roots.map((root) => join(root, 'LibreOffice', 'program', 'soffice.exe')), 'soffice.exe', 'libreoffice.exe']
  }
  return ['soffice', 'libreoffice']
}

async function findExecutable(candidate: string): Promise<string | undefined> {
  const paths = isAbsolute(candidate)
    ? [candidate]
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean).flatMap((directory) =>
      executableNames(candidate).map((name) => join(directory, name)))
  for (const path of paths) {
    try { await access(path, constants.X_OK); return path } catch { /* continue */ }
  }
  return undefined
}

function executableNames(candidate: string): string[] {
  if (process.platform !== 'win32' || extname(candidate)) return [candidate]
  return [candidate, ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((extension) => `${candidate}${extension.toLowerCase()}`)]
}

async function findConverted(directory: string, format: 'docx' | 'pptx'): Promise<string | undefined> {
  const entries = await readdir(directory, { withFileTypes: true })
  const entry = entries.find((candidate) => candidate.isFile() && extname(candidate.name).toLowerCase() === `.${format}`)
  return entry ? join(directory, basename(entry.name)) : undefined
}

function runLibreOffice(binary: string, args: readonly string[], signal?: AbortSignal): Promise<KnowledgeLibreOfficeResult> {
  return new Promise((resolveResult, rejectResult) => {
    if (signal?.aborted) { rejectResult(abortError()); return }
    let child: ChildProcess
    try {
      child = spawn(binary, [...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) { rejectResult(error); return }
    let stdout: Buffer = Buffer.alloc(0)
    let stderr: Buffer = Buffer.alloc(0)
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      callback()
    }
    const append = (current: Buffer, chunk: Buffer): Buffer => {
      if (current.length + chunk.length > MAX_OUTPUT_BYTES) {
        child.kill(); finish(() => rejectResult(new Error('LibreOffice output exceeded its limit')))
        return current
      }
      return Buffer.concat([current, chunk])
    }
    const onAbort = (): void => { child.kill(); finish(() => rejectResult(abortError())) }
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
    child.once('error', (error) => finish(() => rejectResult(error)))
    child.once('close', (code) => finish(() => resolveResult({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode: code ?? 1 })))
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => { child.kill(); finish(() => rejectResult(new Error(`LibreOffice timed out after ${TIMEOUT_MS}ms`))) }, TIMEOUT_MS)
  })
}

function abortError(): Error {
  const error = new Error('Office knowledge extraction was cancelled')
  error.name = 'AbortError'
  return error
}
