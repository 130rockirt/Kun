const { createHash, randomUUID } = require('node:crypto')
const { chmod, mkdir, readFile, rename, rm, stat, writeFile } = require('node:fs/promises')
const { join } = require('node:path')

const PROJECT_ROOT = join(__dirname, '..')
const OFFICECLI_ROOT = join(PROJECT_ROOT, 'resources', 'officecli')
const CURRENT_ROOT = join(OFFICECLI_ROOT, 'current')
const MANIFEST_PATH = join(OFFICECLI_ROOT, 'manifest.json')
const MAX_DOWNLOAD_BYTES = 48 * 1024 * 1024

function parseArgs(argv) {
  const output = {
    platform: process.platform,
    arch: process.arch
  }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--platform') output.platform = argv[index + 1]
    if (argv[index] === '--arch') output.arch = argv[index + 1]
  }
  if (output.platform === 'mac') output.platform = 'darwin'
  if (output.platform === 'win') output.platform = 'win32'
  return output
}

function executableName(platform) {
  return platform === 'win32' ? 'officecli.exe' : 'officecli'
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function fileMatches(path, asset) {
  try {
    const details = await stat(path)
    return details.isFile() &&
      details.size === asset.size &&
      await sha256(path) === asset.sha256
  } catch {
    return false
  }
}

async function downloadAsset(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'Kun-OfficeCLI-Packager/1' }
  })
  if (!response.ok) throw new Error(`OfficeCLI download failed with HTTP ${response.status}`)
  const declaredSize = Number(response.headers.get('content-length') || 0)
  if (declaredSize > MAX_DOWNLOAD_BYTES) {
    throw new Error(`OfficeCLI download declares ${declaredSize} bytes, above the limit`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length <= 0 || bytes.length > MAX_DOWNLOAD_BYTES) {
    throw new Error(`OfficeCLI download returned an invalid ${bytes.length} byte payload`)
  }
  return bytes
}

async function prepareOfficeCli({ platform, arch }) {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  const key = `${platform}-${arch}`
  const asset = manifest.assets?.[key]
  if (!asset) throw new Error(`OfficeCLI ${manifest.version} does not support build target ${key}`)

  await mkdir(CURRENT_ROOT, { recursive: true, mode: 0o755 })
  const outputName = executableName(platform)
  const outputPath = join(CURRENT_ROOT, outputName)
  const oppositePath = join(CURRENT_ROOT, platform === 'win32' ? 'officecli' : 'officecli.exe')
  await rm(oppositePath, { force: true })

  if (!await fileMatches(outputPath, asset)) {
    const bytes = await downloadAsset(asset.url)
    if (bytes.length !== asset.size) {
      throw new Error(`OfficeCLI size mismatch for ${key}: expected ${asset.size}, got ${bytes.length}`)
    }
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== asset.sha256) {
      throw new Error(`OfficeCLI SHA-256 mismatch for ${key}: expected ${asset.sha256}, got ${digest}`)
    }
    const temporaryPath = join(CURRENT_ROOT, `.${outputName}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporaryPath, bytes, { mode: 0o755 })
      await chmod(temporaryPath, 0o755)
      await rename(temporaryPath, outputPath)
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }
  if (platform !== 'win32') await chmod(outputPath, 0o755)

  const selected = {
    schemaVersion: 1,
    version: manifest.version,
    releaseTag: manifest.releaseTag,
    schemaCrc: manifest.schemaCrc,
    platform,
    arch,
    asset: asset.name,
    size: asset.size,
    sha256: asset.sha256
  }
  await writeFile(join(CURRENT_ROOT, 'selected.json'), `${JSON.stringify(selected, null, 2)}\n`, 'utf8')
  console.log(`[officecli] prepared ${manifest.version} for ${key} (${asset.size} bytes)`)
  return selected
}

if (require.main === module) {
  prepareOfficeCli(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(`[officecli] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

exports._internals = {
  parseArgs,
  executableName,
  prepareOfficeCli,
  fileMatches
}
