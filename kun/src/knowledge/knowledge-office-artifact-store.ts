import { lstat, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { atomicWriteFile } from '../adapters/file/atomic-write.js'
import { sha256File } from '../adapters/tool/office-cli-tool-support.js'
import { KnowledgeOfficeExtractorRegistry } from './knowledge-office-extractor.js'
import { officeKnowledgeFormat } from './knowledge-office-source.js'
import {
  KNOWLEDGE_OFFICE_ARTIFACT_VERSION,
  KNOWLEDGE_OFFICE_EXTRACTOR_VERSION,
  type KnowledgeOfficeArtifact,
  type KnowledgeOfficeEvidenceChunk,
  type KnowledgeSourceFile
} from './knowledge-types.js'

const ARTIFACT_FILE_PATTERN = /^[a-f0-9]{64}\.(?:doc|docx|xls|xlsx|ppt|pptx)\.office-v\d+\.json$/
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024
const MAX_MOUNT_ARTIFACT_BYTES = 64 * 1024 * 1024
const MAX_TRANSITION_ARTIFACT_BYTES = MAX_MOUNT_ARTIFACT_BYTES * 2

export type LoadedKnowledgeOfficeArtifact = {
  artifactKey: string
  artifact: KnowledgeOfficeArtifact
  reused: boolean
}

export type KnowledgeOfficeArtifactLoader = Pick<KnowledgeOfficeArtifactStore, 'loadOrExtract'>

export class KnowledgeOfficeArtifactStore {
  private readonly directory: string

  constructor(
    dataDir: string,
    mountKey: string,
    private readonly sourceRoot: string,
    private readonly extractor: KnowledgeOfficeExtractorRegistry
  ) {
    this.directory = join(dataDir, 'knowledge-artifacts', mountKey)
  }

  async loadOrExtract(file: KnowledgeSourceFile, signal?: AbortSignal): Promise<LoadedKnowledgeOfficeArtifact> {
    const validatedFile = await this.safeSource(file)
    const format = officeKnowledgeFormat(validatedFile.relativePath)
    if (!format) throw new Error(`Unsupported Office knowledge source: ${file.relativePath}`)
    const sourceSha256 = await sha256File(validatedFile.absolutePath, signal)
    const artifactKey = `${sourceSha256}.${format}.${KNOWLEDGE_OFFICE_EXTRACTOR_VERSION}.json`
    const stored = await this.read(artifactKey)
    if (stored && stored.sourceSha256 === sourceSha256 && stored.format === format) {
      return { artifactKey, artifact: stored, reused: true }
    }
    const artifact = await this.extractor.extract(validatedFile, sourceSha256, signal)
    const currentFile = await this.safeSource(file)
    const currentSha256 = await sha256File(currentFile.absolutePath, signal)
    if (currentFile.absolutePath !== validatedFile.absolutePath || currentSha256 !== sourceSha256) {
      throw new Error('Office source changed during knowledge extraction')
    }
    if (!isOfficeArtifact(artifact) || artifact.sourceSha256 !== sourceSha256 || artifact.format !== format) {
      throw new Error('Office knowledge extractor returned an invalid artifact')
    }
    const serialized = `${JSON.stringify(artifact)}\n`
    const serializedBytes = Buffer.byteLength(serialized)
    if (serializedBytes > MAX_ARTIFACT_BYTES) {
      throw new Error('Office knowledge artifact exceeds its 2 MiB limit')
    }
    await this.assertMountBudget(artifactKey, serializedBytes)
    await atomicWriteFile(this.pathFor(artifactKey), serialized)
    return { artifactKey, artifact, reused: false }
  }

  async read(artifactKey: string): Promise<KnowledgeOfficeArtifact | null> {
    if (!ARTIFACT_FILE_PATTERN.test(artifactKey)) return null
    try {
      const path = this.pathFor(artifactKey)
      if ((await stat(path)).size > MAX_ARTIFACT_BYTES) return null
      const value = JSON.parse(await readFile(path, 'utf8')) as unknown
      return isOfficeArtifact(value) ? value : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      return null
    }
  }

  async prune(retainedKeys: ReadonlySet<string>): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    await Promise.all(names
      .filter((name) => ARTIFACT_FILE_PATTERN.test(name) && !retainedKeys.has(name))
      .map((name) => rm(this.pathFor(name), { force: true })))
  }

  async assertRetainedBudget(retainedKeys: ReadonlySet<string>): Promise<void> {
    const total = await this.artifactBytes((name) => retainedKeys.has(name))
    if (total > MAX_MOUNT_ARTIFACT_BYTES) {
      throw new Error('Office knowledge artifacts exceed the 64 MiB mount limit')
    }
  }

  private pathFor(artifactKey: string): string {
    return join(this.directory, artifactKey)
  }

  private async safeSource(file: KnowledgeSourceFile): Promise<KnowledgeSourceFile> {
    if (isAbsolute(file.relativePath)) throw new Error('Absolute Office knowledge paths are not allowed')
    const root = await realpath(resolve(this.sourceRoot))
    const candidate = resolve(root, file.relativePath)
    if (!isInside(root, candidate)) throw new Error('Office knowledge source escaped its mount')
    const lexicalInfo = await lstat(candidate)
    if (lexicalInfo.isSymbolicLink() || !lexicalInfo.isFile()) {
      throw new Error('Office knowledge source is not a regular non-symbolic file')
    }
    const physical = await realpath(candidate)
    if (!isInside(root, physical)) throw new Error('Office knowledge source escaped its mount')
    const info = await stat(physical)
    return {
      absolutePath: physical,
      relativePath: file.relativePath,
      size: info.size,
      mtimeMs: Math.floor(info.mtimeMs)
    }
  }

  private async assertMountBudget(nextKey: string, nextBytes: number): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const currentBytes = await this.artifactBytes((name) => name !== nextKey, names)
    if (currentBytes + nextBytes > MAX_TRANSITION_ARTIFACT_BYTES) {
      throw new Error('Office knowledge artifacts exceed the safe rebuild limit')
    }
  }

  private async artifactBytes(
    include: (name: string) => boolean,
    namesInput?: string[]
  ): Promise<number> {
    let names = namesInput
    if (!names) {
      try {
        names = await readdir(this.directory)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
        throw error
      }
    }
    const sizes = await Promise.all(names
      .filter((name) => ARTIFACT_FILE_PATTERN.test(name) && include(name))
      .map(async (name) => (await stat(this.pathFor(name))).size))
    return sizes.reduce((total, size) => total + size, 0)
  }
}

function isInside(root: string, path: string): boolean {
  const value = relative(root, path)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}

export { sha256File as sha256KnowledgeSource }

function isOfficeArtifact(value: unknown): value is KnowledgeOfficeArtifact {
  if (!value || typeof value !== 'object') return false
  const artifact = value as Partial<KnowledgeOfficeArtifact>
  const chunks = artifact.chunks
  return artifact.version === KNOWLEDGE_OFFICE_ARTIFACT_VERSION &&
    artifact.extractorVersion === KNOWLEDGE_OFFICE_EXTRACTOR_VERSION &&
    typeof artifact.sourceSha256 === 'string' && /^[a-f0-9]{64}$/.test(artifact.sourceSha256) &&
    ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(String(artifact.format)) &&
    typeof artifact.truncated === 'boolean' && Array.isArray(chunks) && chunks.length <= 100_000 &&
    chunks.every(isEvidenceChunk) && new Set(chunks.map((chunk) => chunk.key)).size === chunks.length &&
    Array.isArray(artifact.diagnostics) && artifact.diagnostics.length <= 50 &&
    artifact.diagnostics.every((entry) => typeof entry === 'string' && entry.length <= 500)
}

function isEvidenceChunk(value: unknown): value is KnowledgeOfficeEvidenceChunk {
  if (!value || typeof value !== 'object') return false
  const chunk = value as Partial<KnowledgeOfficeEvidenceChunk>
  return typeof chunk.key === 'string' && chunk.key.length > 0 &&
    ['section', 'range', 'slide', 'worksheet', 'cell-range'].includes(String(chunk.kind)) &&
    typeof chunk.title === 'string' && typeof chunk.summary === 'string' &&
    typeof chunk.text === 'string' && isEvidenceLocation(chunk)
}

function isEvidenceLocation(chunk: Partial<KnowledgeOfficeEvidenceChunk>): boolean {
  const location = chunk.location
  if (!location || typeof location !== 'object') return false
  if (chunk.kind === 'section' || chunk.kind === 'range') {
    return location.kind === 'word' && positiveRange(location.paragraphStart, location.paragraphEnd)
  }
  if (chunk.kind === 'slide') {
    return location.kind === 'presentation' && positiveRange(location.slideStart, location.slideEnd)
  }
  return (chunk.kind === 'worksheet' || chunk.kind === 'cell-range') &&
    location.kind === 'spreadsheet' && location.sheetName.length <= 200 &&
    /^[A-Z]{1,4}\d+:[A-Z]{1,4}\d+$/i.test(location.range)
}

function positiveRange(start: unknown, end: unknown): boolean {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
    Number(start) > 0 && Number(end) >= Number(start)
}
