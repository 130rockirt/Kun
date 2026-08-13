import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, type Dirent } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import extractZip from 'extract-zip'
import type { PptMasterEnsureResult } from '../../shared/ppt-master'
import { fetchWithOptionalProxy } from '../proxy-fetch'

/**
 * Keep this release and digest synchronized with the managed-marker constants
 * in kun/src/adapters/tool/ppt-master-tool.ts: the installer must fail closed.
 */
export const PPT_MASTER_VERSION = '3.1.0'
export const PPT_MASTER_ARCHIVE_URL =
  `https://github.com/hugohe3/ppt-master/releases/download/v${PPT_MASTER_VERSION}/ppt-master-skill-v${PPT_MASTER_VERSION}.zip`
export const PPT_MASTER_ARCHIVE_SHA256 = 'b5ecfc7bf2a2682087c05786eb146ffa3a11edcadda77c810770730b6e82ddf2'

const MAX_ARCHIVE_BYTES = 160 * 1024 * 1024
const COMMAND_TIMEOUT_MS = 15 * 60 * 1000
const MAX_COMMAND_OUTPUT = 24_000
const INSTALL_METADATA_FILE = '.kun-ppt-master.json'
const UPSTREAM_ENTRY_FILE = 'PPT_MASTER_UPSTREAM.md'
const MANAGED_BY = 'kun-gui'
// The Write integration exposes only Markdown -> SVG -> PPTX. Installing the
// upstream catch-all requirements would also pull PDF, EPUB, notebook, web,
// narration, image-generation, and preview-server stacks (including a ~24 MB
// PDF runtime) on the first click even though none can be invoked here.
const WRITE_PIP_REQUIREMENTS = [
  'python-pptx>=0.6.21',
  'Pillow>=9.0.0',
  'svglib>=1.5.0',
  'reportlab>=4.0.0'
] as const
const WRITE_DEPENDENCY_PROBE = [
  'import pptx',
  'from PIL import Image',
  'from svglib.svglib import svg2rlg',
  'from reportlab.graphics import renderPM'
].join('; ')

let installPromise: Promise<PptMasterEnsureResult> | null = null

type PythonCommand = {
  command: string
  prefix: string[]
}

type CommandResult = {
  code: number
  output: string
}

export function pptMasterSkillDir(kunHomeDir: string): string {
  return join(kunHomeDir, 'skills', 'ppt-master')
}

export function pptMasterPythonPath(skillDir: string, platform = process.platform): string {
  return platform === 'win32'
    ? join(skillDir, '.venv', 'Scripts', 'python.exe')
    : join(skillDir, '.venv', 'bin', 'python')
}

/**
 * Download the upstream skill once, then install its Python requirements into
 * a venv below the skill package. Keeping the runtime local avoids leaking
 * dependencies into the user's global Python installation.
 */
export function ensurePptMaster(options: {
  kunHomeDir: string
  proxyUrl?: string
}): Promise<PptMasterEnsureResult> {
  if (installPromise) return installPromise
  const task = ensurePptMasterOnce(options).finally(() => {
    if (installPromise === task) installPromise = null
  })
  installPromise = task
  return task
}

async function ensurePptMasterOnce(options: {
  kunHomeDir: string
  proxyUrl?: string
}): Promise<PptMasterEnsureResult> {
  const skillDir = pptMasterSkillDir(options.kunHomeDir)
  // `installed` also means the runtime must be rebuilt: it may have started
  // before the package or its venv existed, so its local-tool registry was
  // intentionally empty at that point.
  let installed = false
  try {
    if (await needsSkillInstall(skillDir)) {
      await installSkillPackage(skillDir, options.proxyUrl ?? '')
      installed = true
    }
    await ensureKunSkillEntry(skillDir)

    const python = await resolvePython()
    if (!python) {
      return {
        ok: false,
        message: 'PPT Master needs Python 3.10 or later. Install Python, then try again.'
      }
    }

    const venvPython = pptMasterPythonPath(skillDir)
    if (!await isRegularFile(venvPython)) {
      const create = await runCommand(python.command, [...python.prefix, '-m', 'venv', join(skillDir, '.venv')], skillDir)
      if (create.code !== 0) {
        return { ok: false, message: `Could not create PPT Master Python environment: ${formatCommandOutput(create.output)}` }
      }
      installed = true
    }

    const ready = await runCommand(venvPython, ['-c', WRITE_DEPENDENCY_PROBE], skillDir, 30_000)
    if (ready.code !== 0) {
      const pip = await runCommand(
        venvPython,
        ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', ...WRITE_PIP_REQUIREMENTS],
        skillDir
      )
      if (pip.code !== 0) {
        return { ok: false, message: `Could not install PPT Master dependencies: ${formatCommandOutput(pip.output)}` }
      }
      const verified = await runCommand(venvPython, ['-c', WRITE_DEPENDENCY_PROBE], skillDir, 30_000)
      if (verified.code !== 0) {
        return { ok: false, message: `PPT Master dependencies installed but could not be loaded: ${formatCommandOutput(verified.output)}` }
      }
      installed = true
    }
    return { ok: true, skillPath: skillDir, pythonPath: venvPython, installed }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

async function installSkillPackage(skillDir: string, proxyUrl: string): Promise<void> {
  const skillsDir = resolve(skillDir, '..')
  await mkdir(skillsDir, { recursive: true })
  const stageDir = await makeStageDir(skillsDir)
  const archivePath = join(stageDir, 'ppt-master.zip')
  const extractDir = join(stageDir, 'extract')
  try {
    await downloadArchive(archivePath, proxyUrl)
    await mkdir(extractDir, { recursive: true })
    await extractZip(archivePath, { dir: extractDir })
    const extractedSkillDir = await findSkillPackage(extractDir)
    if (!extractedSkillDir) {
      throw new Error('The downloaded PPT Master archive does not contain a valid skill package.')
    }
    await rm(skillDir, { recursive: true, force: true })
    // stageDir and skillDir share a parent, so this hand-off is atomic.
    await rename(extractedSkillDir, skillDir)
  } finally {
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function downloadArchive(destination: string, proxyUrl: string): Promise<void> {
  const response = await fetchWithOptionalProxy(PPT_MASTER_ARCHIVE_URL, undefined, proxyUrl)
  if (!response.ok || !response.body) {
    throw new Error(`Could not download PPT Master (${response.status || 'network error'}).`)
  }
  const advertisedBytes = Number(response.headers.get('content-length'))
  if (Number.isFinite(advertisedBytes) && advertisedBytes > MAX_ARCHIVE_BYTES) {
    throw new Error('The PPT Master archive is larger than the allowed install size.')
  }
  const hash = createHash('sha256')
  let bytes = 0
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      if (bytes > MAX_ARCHIVE_BYTES) {
        callback(new Error('The PPT Master archive is larger than the allowed install size.'))
        return
      }
      hash.update(chunk)
      callback(null, chunk)
    }
  })
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    meter,
    createWriteStream(destination, { flags: 'wx' })
  )
  const digest = hash.digest('hex')
  if (digest !== PPT_MASTER_ARCHIVE_SHA256) {
    throw new Error('PPT Master download verification failed. Please try again.')
  }
}

async function ensureKunSkillEntry(skillDir: string): Promise<void> {
  const upstreamPath = join(skillDir, UPSTREAM_ENTRY_FILE)
  const legacyPath = join(skillDir, 'SKILL.md')
  if (!await isRegularFile(upstreamPath)) {
    await copyFile(legacyPath, upstreamPath)
  }
  await writeFile(join(skillDir, 'SKILL.md'), KUN_PPT_MASTER_SKILL, 'utf8')
  await writeFile(join(skillDir, 'skill.json'), `${JSON.stringify({
    id: 'ppt-master',
    name: 'PPT Master',
    version: PPT_MASTER_VERSION,
    description: 'Create native, editable PPTX presentations from Markdown in Work.',
    entry: 'SKILL.md',
    triggers: {},
    priority: 20
  }, null, 2)}\n`, 'utf8')
  await writeFile(join(skillDir, INSTALL_METADATA_FILE), `${JSON.stringify({
    managedBy: MANAGED_BY,
    version: PPT_MASTER_VERSION,
    archiveSha256: PPT_MASTER_ARCHIVE_SHA256,
    installedAt: new Date().toISOString()
  }, null, 2)}\n`, 'utf8')
}

async function isCompleteSkillPackage(skillDir: string): Promise<boolean> {
  return await isRegularFile(join(skillDir, 'SKILL.md')) &&
    await isRegularFile(join(skillDir, 'requirements.txt')) &&
    await isRegularFile(join(skillDir, 'scripts', 'project_manager.py'))
}

async function needsSkillInstall(skillDir: string): Promise<boolean> {
  if (!await isCompleteSkillPackage(skillDir)) return true
  try {
    const metadata = JSON.parse(await readFile(join(skillDir, INSTALL_METADATA_FILE), 'utf8')) as {
      managedBy?: unknown
      version?: unknown
      archiveSha256?: unknown
    }
    return metadata.managedBy !== MANAGED_BY ||
      metadata.version !== PPT_MASTER_VERSION ||
      metadata.archiveSha256 !== PPT_MASTER_ARCHIVE_SHA256
  } catch {
    // An untracked package can be incomplete, old, or altered. Replace it with
    // the pinned release before handing it to the agent runtime.
    return true
  }
}

async function findSkillPackage(root: string, depth = 0): Promise<string | null> {
  if (depth > 5) return null
  if (await isCompleteSkillPackage(root)) return root
  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await findSkillPackage(join(root, entry.name), depth + 1)
    if (found) return found
  }
  return null
}

async function makeStageDir(parent: string): Promise<string> {
  for (let index = 0; index < 20; index += 1) {
    const candidate = join(parent, `.ppt-master-install-${process.pid}-${Date.now()}-${index}`)
    try {
      await mkdir(candidate)
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('Could not create a temporary PPT Master install directory.')
}

async function resolvePython(): Promise<PythonCommand | null> {
  const candidates: PythonCommand[] = process.platform === 'win32'
    ? [{ command: 'py', prefix: ['-3'] }, { command: 'python', prefix: [] }]
    : [{ command: 'python3', prefix: [] }, { command: 'python', prefix: [] }]
  for (const candidate of candidates) {
    const version = await runCommand(candidate.command, [...candidate.prefix, '--version'], process.cwd(), 15_000)
    if (version.code !== 0) continue
    const match = version.output.match(/Python\s+(\d+)\.(\d+)/i)
    if (!match) continue
    const major = Number(match[1])
    const minor = Number(match[2])
    if (major > 3 || (major === 3 && minor >= 10)) return candidate
  }
  return null
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = COMMAND_TIMEOUT_MS
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    let output = ''
    let settled = false
    const append = (chunk: Buffer): void => {
      if (output.length >= MAX_COMMAND_OUTPUT) return
      output += chunk.toString('utf8').slice(0, MAX_COMMAND_OUTPUT - output.length)
    }
    let child
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolveResult({ code: -1, output: error instanceof Error ? error.message : String(error) })
      return
    }
    const settle = (code: number): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolveResult({ code, output })
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', (error) => settle(-1))
    child.once('close', (code) => settle(code ?? -1))
    timer = setTimeout(() => {
      child.kill()
      settle(-1)
    }, timeoutMs)
  })
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function formatCommandOutput(output: string): string {
  const normalized = output.trim().replace(/\s+/g, ' ')
  return normalized ? normalized.slice(-1_200) : 'No additional detail was returned.'
}

// The upstream entry is ~77KB while Kun injects at most 24KB per active skill.
// This compact adapter leaves the full upstream procedure beside it and tells the
// model exactly when to read the detailed sections through its normal tools.
const KUN_PPT_MASTER_SKILL = `---
name: ppt-master
description: Create native, editable PPTX presentations from Markdown in Work.
---

# PPT Master for Kun Work

This package is the PPT Master workflow. The full upstream guide is at
\`PPT_MASTER_UPSTREAM.md\` in this same directory. Use \`ppt_master_read_guide\`
to read only the relevant sections when you need detailed template, image, SVG,
or export rules. Do not try to load that entire file into one response.

## Work contract

- The user's prompt identifies the Markdown source and workspace. Read that file
  before planning. Treat it as read-only: never edit, rename, or move it.
- Create the project below \`<workspace>/.kun-presentations/\`, and import the
  source with \`project_manager.py import-sources ... --copy\`. This overrides
  upstream's \`--move\` default for the Kun Work integration.
- Put the final canonical PPTX in \`<workspace>/presentations/\`. Keep SVG,
  project files, images, and backups under \`.kun-presentations/\`.
- Use the \`ppt_master_run\` tool for every PPT Master script step. It is the
  only supported execution route in the normal workspace-write sandbox; do not
  substitute generic bash commands.
- Before planning, use \`ppt_master_read_guide\` for
  \`workflows/routing.md\`, \`references/artifact-ownership.md\`, and the
  relevant strategist/spec references. Use it again for the selected visual
  style or failure recovery; it returns bounded slices of the verified package.

## Required workflow

1. Read the source Markdown and make a concise slide outline. Give the user a
   recommended page count, audience, and visual direction. Before writing any
   project files, call \`ppt_master_confirm_design\` exactly once. It opens the
   native confirmation card with \`Generate PPT\` and \`Cancel\`. If the user
   cancels, stop and report that generation was cancelled.
2. Only after it returns \`approval_token\`, pass that token to every
   \`ppt_master_run\` call. Initialize the project and import the source. Use
   the returned project path, write the design
   specification. In this Work integration, do not start live-preview servers
   and do not acquire web or AI images; use only source-provided assets or
   intentional SVG/typographic placeholders.
3. Write \`design_spec.md\`, \`spec_lock.md\`, and \`notes/total.md\` in the
   project. Generate SVG slides sequentially in \`svg_output/\`, rereading
   \`spec_lock.md\` before each page. Do not batch-generate page SVG with a
   program.
4. Call \`ppt_master_run\` to validate, check SVG, split speaker notes, finalize, and
   export. Verify the PPTX exists, then report its workspace-relative path in
   the final response.

For an existing PPTX, template fill, animations, narration, or non-Markdown
sources, read the route table in \`workflows/routing.md\` first. In normal Work
use, favor the Markdown-to-new-deck route above.
`
