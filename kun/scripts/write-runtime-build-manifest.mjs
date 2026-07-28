import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const RUNTIME_BUILD_MANIFEST_VERSION = 1
export const RUNTIME_BUILD_MANIFEST_FILENAME = 'runtime-build.json'

export async function computeRuntimeBuildId(distDirectory) {
  const root = resolve(distDirectory)
  const files = (await javascriptFiles(root))
    .map((path) => ({ path, relativePath: portablePath(relative(root, path)) }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  if (files.length === 0) {
    throw new Error(`no emitted JavaScript files found under ${root}`)
  }
  const hash = createHash('sha256')
  hash.update('kun-runtime-build-v1\0')
  for (const file of files) {
    const content = await readFile(file.path)
    hash.update(String(Buffer.byteLength(file.relativePath)))
    hash.update(':')
    hash.update(file.relativePath)
    hash.update('\0')
    hash.update(String(content.byteLength))
    hash.update(':')
    hash.update(content)
    hash.update('\0')
  }
  return hash.digest('hex')
}

export async function writeRuntimeBuildManifest(distDirectory) {
  const root = resolve(distDirectory)
  const buildId = await computeRuntimeBuildId(root)
  const target = join(root, RUNTIME_BUILD_MANIFEST_FILENAME)
  const temporary = `${target}.${process.pid}.tmp`
  await mkdir(dirname(target), { recursive: true })
  await writeFile(temporary, `${JSON.stringify({
    version: RUNTIME_BUILD_MANIFEST_VERSION,
    buildId
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 })
  await rename(temporary, target)
  return { version: RUNTIME_BUILD_MANIFEST_VERSION, buildId }
}

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await javascriptFiles(path))
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(path)
    }
  }
  return files
}

function portablePath(path) {
  return path.split('\\').join('/')
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invokedPath === import.meta.url) {
  const distDirectory = fileURLToPath(new URL('../dist/', import.meta.url))
  const manifest = await writeRuntimeBuildManifest(distDirectory)
  process.stdout.write(`Kun runtime build ${manifest.buildId}\n`)
}
