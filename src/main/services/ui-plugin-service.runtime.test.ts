import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UI_PLUGIN_LIMITS } from '../../shared/ui-plugin'
import {
  installUiPluginFromDirectory,
  listUiPlugins,
  loadUiPluginFigures,
  removeUiPlugin,
  seedUiPlugin,
  uiPluginsRootDir
} from './ui-plugin-service'

/** 1x1 transparent PNG */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

/** 1x1, two-frame animated GIF */
const ANIMATED_GIF_BYTES = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAEALAAAAAABAAEAAAICRAEAIfkEAQAAAQAsAAAAAAEAAQAAAgJEADs=',
  'base64'
)

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return value >>> 0
})

function crc32(bytes: Buffer): number {
  let value = 0xffffffff
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function pngWithDimensions(width: number, height: number): Buffer {
  const bytes = Buffer.from(PNG_BYTES)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29)
  return bytes
}

async function pngWithDecodedDimensions(width: number, height: number): Promise<Buffer> {
  return sharp(Buffer.alloc(width * height), {
    raw: { width, height, channels: 1 }
  })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

function pngWithAncillaryBytes(payloadBytes: number): Buffer {
  const iendOffset = PNG_BYTES.length - 12
  const chunk = Buffer.alloc(payloadBytes + 12)
  chunk.writeUInt32BE(payloadBytes, 0)
  chunk.write('tEXt', 4, 'ascii')
  chunk.fill(0x61, 8, 8 + payloadBytes)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + payloadBytes)), 8 + payloadBytes)
  return Buffer.concat([
    PNG_BYTES.subarray(0, iendOffset),
    chunk,
    PNG_BYTES.subarray(iendOffset)
  ])
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length, 0)
  chunk.write(type, 4, 'ascii')
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length)
  return chunk
}

function apngBytes(): Buffer {
  const animationControl = Buffer.alloc(8)
  animationControl.writeUInt32BE(1, 0)
  return Buffer.concat([
    PNG_BYTES.subarray(0, 33),
    pngChunk('acTL', animationControl),
    PNG_BYTES.subarray(33)
  ])
}

function animatedWebpBytes(): Buffer {
  const webpChunk = (type: string, data: Buffer): Buffer => {
    const chunk = Buffer.alloc(8 + data.length + (data.length % 2))
    chunk.write(type, 0, 'ascii')
    chunk.writeUInt32LE(data.length, 4)
    data.copy(chunk, 8)
    return chunk
  }
  const extendedHeader = Buffer.alloc(10)
  extendedHeader[0] = 0x02
  const payload = Buffer.concat([
    webpChunk('VP8X', extendedHeader),
    webpChunk('ANIM', Buffer.alloc(6)),
    webpChunk('ANMF', Buffer.alloc(16))
  ])
  const header = Buffer.alloc(12)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(payload.length + 4, 4)
  header.write('WEBP', 8, 'ascii')
  return Buffer.concat([header, payload])
}

function corruptStaticWebpBytes(valid: Buffer): Buffer {
  // 保留 RIFF/WEBP/VP8 头、帧 magic 和宽高，只截断实际 VP8 像素流。
  const payloadLength = 100
  const totalLength = 20 + payloadLength
  const bytes = Buffer.alloc(totalLength)
  valid.copy(bytes, 0, 0, totalLength)
  bytes.writeUInt32LE(totalLength - 8, 4)
  bytes.writeUInt32LE(payloadLength, 16)
  return bytes
}

function pngWithCorruptPixelStream(): Buffer {
  const bytes = Buffer.from(PNG_BYTES)
  bytes.fill(0, 41, 54)
  bytes.writeUInt32BE(crc32(bytes.subarray(37, 54)), 54)
  return bytes
}

let userDataDir = ''
let sourceDir = ''

async function writeSourcePlugin(manifest: unknown, figures: string[] = ['img/swim.png']): Promise<void> {
  await mkdir(join(sourceDir, 'img'), { recursive: true })
  await writeFile(join(sourceDir, 'manifest.json'), JSON.stringify(manifest), 'utf8')
  for (const figure of figures) {
    await mkdir(join(sourceDir, figure, '..'), { recursive: true })
    await writeFile(join(sourceDir, ...figure.split('/')), PNG_BYTES)
  }
}

async function writeSourceAssets(
  manifestRaw: unknown,
  assets: Record<string, Buffer>
): Promise<void> {
  await writeFile(join(sourceDir, 'manifest.json'), JSON.stringify(manifestRaw), 'utf8')
  for (const [relativePath, bytes] of Object.entries(assets)) {
    const targetPath = join(sourceDir, ...relativePath.split('/'))
    await mkdir(join(targetPath, '..'), { recursive: true })
    await writeFile(targetPath, bytes)
  }
}

const manifest = {
  id: 'starlight',
  name: '星夜',
  version: '1.0.0',
  figures: { swim: 'img/swim.png' }
}

function portraitManifest(path = 'img/portrait.png') {
  return {
    id: 'portrait-theme',
    name: 'Portrait theme',
    version: '1.0.0',
    figures: { portrait: path },
    presentation: {
      character: {
        anchor: 'right',
        size: 'hero',
        offsetX: 0,
        offsetY: 0,
        opacity: 1,
        frame: 'soft-card',
        motion: 'none',
        contentReserve: 'wide'
      },
      readability: { scrim: 'opposite-character', strength: 'medium' },
      surfaces: {
        sidebar: 'glass',
        topbar: 'glass',
        composer: 'strong-glass',
        cards: 'translucent'
      }
    }
  }
}

function sceneManifest() {
  return {
    ...portraitManifest(),
    id: 'scene-theme',
    name: 'Scene theme',
    scene: {
      apiVersion: '1.6',
      layout: 'rail-left',
      character: {
        scale: 'hero',
        fit: 'contain',
        focalPoint: 'bottom',
        mask: 'arch',
        offsetX: 1,
        offsetY: -2,
        opacity: 0.96,
        flipX: false,
        motion: { preset: 'sway', speed: 'slow', phase: 'b' }
      },
      artwork: {
        backdrop: {
          path: 'scene/shared.png',
          darkPath: 'scene/dark.png',
          anchor: 'center',
          size: 'full',
          fit: 'cover',
          offsetX: 0,
          offsetY: 0,
          opacity: 0.7,
          blend: 'screen',
          motion: { preset: 'drift-x', speed: 'slow', phase: 'a' }
        },
        frame: {
          path: 'scene/shared.png',
          anchor: 'center',
          size: 'large',
          fit: 'contain',
          offsetX: 1,
          offsetY: 0,
          opacity: 1,
          blend: 'normal',
          motion: { preset: 'none', speed: 'normal', phase: 'a' }
        }
      },
      chrome: {
        sidebar: 'paper',
        topbar: 'editorial',
        composer: 'hologram',
        cards: 'ticket'
      }
    }
  }
}

const backgroundOnlyManifest = {
  id: 'dream-background',
  name: '梦境背景',
  version: '1.0.0',
  figures: {},
  backgrounds: {
    light: {
      stage: {
        path: 'img/stage.png',
        fit: 'cover',
        position: 'center',
        opacity: 0.4
      }
    }
  }
}

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'kun-ui-plugin-data-'))
  sourceDir = await mkdtemp(join(tmpdir(), 'kun-ui-plugin-src-'))
})

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true })
  await rm(sourceDir, { recursive: true, force: true })
})

describe('loadUiPluginFigures', () => {
  it('returns data URLs for installed figures', async () => {
    await writeSourcePlugin(manifest)
    await installUiPluginFromDirectory(userDataDir, sourceDir)

    const result = await loadUiPluginFigures(userDataDir, 'starlight')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.figures.swim?.startsWith('data:image/png;base64,')).toBe(true)
    expect(result.backgrounds).toEqual({})
    expect(result.sceneAssets).toEqual({})
  })

  it('validates and returns the presentation portrait through the figure pipeline', async () => {
    const portraitBytes = await pngWithDecodedDimensions(1600, 2400)
    await writeSourceAssets(portraitManifest(), { 'img/portrait.png': portraitBytes })
    const installed = await installUiPluginFromDirectory(userDataDir, sourceDir)
    expect(installed.ok).toBe(true)
    if (!installed.ok) return
    expect(installed.plugin.previewDataUrl?.startsWith('data:image/webp;base64,')).toBe(true)
    const previewBytes = Buffer.from(installed.plugin.previewDataUrl!.split(',')[1], 'base64')
    expect(previewBytes.byteLength).toBeLessThanOrEqual(UI_PLUGIN_LIMITS.portraitPreviewBytes)
    const previewMetadata = await sharp(previewBytes, { animated: true }).metadata()
    expect(previewMetadata.width).toBeLessThanOrEqual(
      UI_PLUGIN_LIMITS.portraitPreviewMaxDimension
    )
    expect(previewMetadata.height).toBeLessThanOrEqual(
      UI_PLUGIN_LIMITS.portraitPreviewMaxDimension
    )
    expect(previewMetadata.pages ?? 1).toBe(1)

    const listed = await listUiPlugins(userDataDir)
    expect(listed[0]?.previewDataUrl).toBe(installed.plugin.previewDataUrl)

    const result = await loadUiPluginFigures(userDataDir, 'portrait-theme')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.figures.portrait?.startsWith('data:image/png;base64,')).toBe(true)
    expect(result.manifest.presentation?.character.frame).toBe('soft-card')
  })

  it('prefers a compact activity preview over generating a portrait thumbnail', async () => {
    await writeSourceAssets(
      {
        ...portraitManifest(),
        figures: {
          portrait: 'img/portrait.png',
          toggleIcon: 'img/toggle.png'
        }
      },
      {
        'img/portrait.png': await pngWithDecodedDimensions(1200, 1800),
        'img/toggle.png': PNG_BYTES
      }
    )
    const installed = await installUiPluginFromDirectory(userDataDir, sourceDir)
    expect(installed.ok, JSON.stringify(installed)).toBe(true)
    if (!installed.ok) return
    expect(installed.plugin.previewDataUrl).toBe(
      `data:image/png;base64,${PNG_BYTES.toString('base64')}`
    )
  })

  it('refuses ids that escape the plugins root', async () => {
    const result = await loadUiPluginFigures(userDataDir, '../outside')
    expect(result.ok).toBe(false)
  })

  it('revalidates installed background contents and rejects a replacement symlink', async () => {
    await writeSourceAssets(backgroundOnlyManifest, { 'img/stage.png': PNG_BYTES })
    const installed = await installUiPluginFromDirectory(userDataDir, sourceDir)
    expect(installed.ok).toBe(true)

    const installedBackground = join(
      uiPluginsRootDir(userDataDir),
      'dream-background',
      'img',
      'stage.png'
    )

    await writeFile(installedBackground, pngWithDimensions(8193, 1))
    const oversized = await loadUiPluginFigures(userDataDir, 'dream-background')
    expect(oversized.ok).toBe(false)
    if (!oversized.ok) expect(oversized.error).toContain('宽高')

    await rm(installedBackground)
    const outsidePath = join(userDataDir, 'replacement.png')
    await writeFile(outsidePath, PNG_BYTES)
    await symlink(outsidePath, installedBackground)

    const loaded = await loadUiPluginFigures(userDataDir, 'dream-background')
    expect(loaded.ok).toBe(false)
    if (!loaded.ok) expect(loaded.error).toContain('符号链接')
  })
})

describe('removeUiPlugin', () => {
  it('removes an installed plugin and refuses traversal ids', async () => {
    await writeSourcePlugin(manifest)
    await installUiPluginFromDirectory(userDataDir, sourceDir)

    expect(await removeUiPlugin(userDataDir, '../escape')).toBe(false)
    expect(await removeUiPlugin(userDataDir, 'starlight')).toBe(true)
    expect(await listUiPlugins(userDataDir)).toHaveLength(0)
  })
})

describe('seedUiPlugin (bundled plugins like ikun)', () => {
  it('seeds a plugin from in-memory bytes and it lists/loads like any other', async () => {
    const result = await seedUiPlugin(
      userDataDir,
      {
        id: 'ikun',
        name: 'iKun 模式',
        version: '1.0.0',
        figures: { swim: 'img/dribble.png', greet: 'img/wave.png' },
        features: { cameos: true }
      },
      { swim: PNG_BYTES, greet: PNG_BYTES }
    )
    expect(result.ok, JSON.stringify(result)).toBe(true)

    const plugins = await listUiPlugins(userDataDir)
    expect(plugins.map((p) => p.manifest.id)).toContain('ikun')

    const loaded = await loadUiPluginFigures(userDataDir, 'ikun')
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.figures.swim?.startsWith('data:image/png;base64,')).toBe(true)
    expect(loaded.manifest.features?.cameos).toBe(true)
    expect(loaded.backgrounds).toEqual({})
  })

  it('rejects seeding when figure bytes are missing', async () => {
    const result = await seedUiPlugin(
      userDataDir,
      { id: 'ikun', name: 'x', version: '1.0.0', figures: { swim: 'img/a.png' } },
      {}
    )
    expect(result.ok).toBe(false)
  })

  it('rejects an animated portrait supplied by a bundled seed', async () => {
    const result = await seedUiPlugin(
      userDataDir,
      portraitManifest('img/portrait.gif'),
      { portrait: ANIMATED_GIF_BYTES }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(';')).toContain('portrait 仅支持静态')
  })

  it('seeds a background-only plugin with the optional fourth argument', async () => {
    const result = await seedUiPlugin(
      userDataDir,
      backgroundOnlyManifest,
      {},
      { light: { stage: PNG_BYTES } }
    )
    expect(result.ok, JSON.stringify(result)).toBe(true)

    const loaded = await loadUiPluginFigures(userDataDir, 'dream-background')
    expect(loaded.ok, JSON.stringify(loaded)).toBe(true)
    if (!loaded.ok) return
    expect(loaded.backgrounds.assets?.['img/stage.png']?.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('seeds and loads scene v1.6 assets through the optional fifth argument', async () => {
    const result = await seedUiPlugin(
      userDataDir,
      sceneManifest(),
      { portrait: PNG_BYTES },
      {},
      {
        'scene/shared.png': PNG_BYTES,
        'scene/dark.png': PNG_BYTES
      }
    )
    expect(result.ok, JSON.stringify(result)).toBe(true)

    const loaded = await loadUiPluginFigures(userDataDir, 'scene-theme')
    expect(loaded.ok, JSON.stringify(loaded)).toBe(true)
    if (!loaded.ok) return
    expect(loaded.manifest.scene?.layout).toBe('rail-left')
    expect(Object.keys(loaded.sceneAssets.assets ?? {}).sort()).toEqual([
      'scene/dark.png',
      'scene/shared.png'
    ])
  })

  it('rejects seeding when declared scene bytes are missing', async () => {
    const result = await seedUiPlugin(
      userDataDir,
      sceneManifest(),
      { portrait: PNG_BYTES }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(';')).toContain('scene backdrop.default 缺少预装图片数据')
  })

  it('rejects seeding when declared background bytes are missing', async () => {
    const result = await seedUiPlugin(userDataDir, backgroundOnlyManifest, {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(';')).toContain('缺少预装图片数据')
  })
})

describe('bundled starlight example', () => {
  it('installs and loads end to end', async () => {
    const exampleDir = join(process.cwd(), 'examples', 'ui-plugins', 'starlight')
    const installed = await installUiPluginFromDirectory(userDataDir, exampleDir)
    expect(installed.ok, JSON.stringify(installed)).toBe(true)

    const loaded = await loadUiPluginFigures(userDataDir, 'starlight')
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.manifest.name).toBe('星夜 Kun')
    expect(loaded.figures.swim?.startsWith('data:image/png;base64,')).toBe(true)
    expect(
      loaded.backgrounds.assets?.['img/starlight-stage.webp']?.startsWith('data:image/webp;base64,')
    ).toBe(true)
    expect(Object.keys(loaded.backgrounds.assets ?? {})).toEqual(['img/starlight-stage.webp'])
    expect(loaded.manifest.features?.cameos).toBe(true)
    expect(loaded.manifest.tokens?.light?.['--ds-accent']).toBe('#7a5fd0')
  })
})

describe('listUiPlugins', () => {
  it('skips directories whose name does not match manifest id', async () => {
    await writeSourcePlugin(manifest)
    await installUiPluginFromDirectory(userDataDir, sourceDir)
    // 手工伪造一个目录名与 id 不一致的插件
    const fakeDir = join(uiPluginsRootDir(userDataDir), 'impostor')
    await mkdir(join(fakeDir, 'img'), { recursive: true })
    await writeFile(join(fakeDir, 'manifest.json'), JSON.stringify(manifest), 'utf8')
    await writeFile(join(fakeDir, 'img', 'swim.png'), PNG_BYTES)

    const plugins = await listUiPlugins(userDataDir)
    expect(plugins.map((p) => p.manifest.id)).toEqual(['starlight'])
  })
})
