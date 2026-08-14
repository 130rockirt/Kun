import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as yazl from 'yazl'
import { describe, expect, it, vi } from 'vitest'
import {
  EXTENSION_INTEGRITY_FILE,
  ExtensionIndexClient,
  ExtensionPackageManager,
  ExtensionPaths,
  ExtensionRegistry,
  ExtensionStateMigrationCoordinator,
  ExtensionStateStore,
  extractKunxArchive,
  inspectKunxArchive,
  packKunx,
  type ExtensionCompatibility,
  type ExtensionManager,
  type JsonValue,
  type ResolvedExtension
} from '../../src/extensions/index.js'

export const compatibility: ExtensionCompatibility = {
  kunVersion: '0.1.0',
  supportedManifestVersions: [1],
  supportedApiVersions: ['1.0.0']
}

export async function writeExtensionSource(
  root: string,
  version: string,
  stateSchemaVersion = 0,
  permissions: string[] = []
): Promise<void> {
  await mkdir(join(root, 'dist'), { recursive: true })
  await writeFile(
    join(root, 'kun-extension.json'),
    `${JSON.stringify(manifestFor(version, stateSchemaVersion, permissions), null, 2)}\n`
  )
  await writeFile(join(root, 'README.md'), '# Demo\n')
  await writeFile(join(root, 'LICENSE'), 'MIT\n')
  await writeFile(join(root, 'dist/main.mjs'), 'export async function activate() {}\n')
}

export function manifestFor(version: string, stateSchemaVersion = 0, permissions: string[] = []) {
  return {
    publisher: 'acme',
    name: 'demo',
    displayName: 'Demo',
    version,
    manifestVersion: 1,
    apiVersion: '1.0.0',
    engines: { kun: '*' },
    main: 'dist/main.mjs',
    activationEvents: ['onStartup'],
    contributes: {},
    permissions,
    stateSchemaVersion
  }
}

export function requiredFiles(manifest: ReturnType<typeof manifestFor>): Record<string, Buffer> {
  return {
    'kun-extension.json': Buffer.from(JSON.stringify(manifest)),
    'README.md': Buffer.from('# Demo\n'),
    LICENSE: Buffer.from('MIT\n'),
    'dist/main.mjs': Buffer.from('export async function activate() {}\n')
  }
}

export function integrityFor(files: Record<string, Buffer>) {
  return {
    algorithm: 'sha256' as const,
    files: Object.fromEntries(
      Object.entries(files).map(([path, contents]) => [
        path,
        createHash('sha256').update(contents).digest('hex')
      ])
    )
  }
}

export async function writeZip(
  path: string,
  entries: ReadonlyArray<readonly [string, Buffer, number]>
): Promise<void> {
  const zip = new yazl.ZipFile()
  for (const [entryPath, contents, mode] of entries) {
    zip.addBuffer(contents, entryPath, {
      mtime: new Date('1980-01-01T00:00:00.000Z'),
      mode,
      compress: true
    })
  }
  const chunks: Buffer[] = []
  zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk))
  const complete = new Promise<void>((resolvePromise, reject) => {
    zip.outputStream.once('end', resolvePromise)
    zip.outputStream.once('error', reject)
  })
  zip.end()
  await complete
  await writeFile(path, Buffer.concat(chunks))
}

export function replaceAllAscii(buffer: Buffer, from: string, to: string): void {
  expect(Buffer.byteLength(from)).toBe(Buffer.byteLength(to))
  const source = Buffer.from(from)
  const replacement = Buffer.from(to)
  let offset = 0
  let replacements = 0
  while ((offset = buffer.indexOf(source, offset)) >= 0) {
    replacement.copy(buffer, offset)
    offset += replacement.length
    replacements += 1
  }
  expect(replacements).toBeGreaterThanOrEqual(2)
}

export async function makeWritable(root: string): Promise<void> {
  if (process.platform === 'win32') return
  const { chmod, lstat, readdir } = await import('node:fs/promises')
  const visit = async (path: string): Promise<void> => {
    const details = await lstat(path).catch(() => undefined)
    if (details === undefined) return
    if (!details.isDirectory()) {
      await chmod(path, 0o600)
      return
    }
    await chmod(path, 0o700)
    for (const entry of await readdir(path)) await visit(join(path, entry))
  }
  await visit(root)
}
