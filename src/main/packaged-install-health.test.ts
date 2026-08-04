import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  inspectPackagedInstallHealth,
  resolveInstallHealthFileStat
} from './packaged-install-health'

describe('inspectPackagedInstallHealth', () => {
  let directory = ''

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = ''
  })

  async function createHealthyPayload(): Promise<{ executablePath: string; resourcesPath: string }> {
    directory = await mkdtemp(join(tmpdir(), 'kun-packaged-install-health-'))
    const resourcesPath = join(directory, 'resources')
    const executablePath = join(directory, 'Kun.exe')
    await mkdir(join(resourcesPath, 'app.asar.unpacked', 'kun', 'dist', 'cli'), { recursive: true })
    await mkdir(join(resourcesPath, 'app.asar.unpacked', 'kun', 'dist', 'manager'), { recursive: true })
    await Promise.all([
      writeFile(executablePath, 'exe'),
      writeFile(join(resourcesPath, 'app.asar'), 'asar'),
      writeFile(join(resourcesPath, 'app.asar.unpacked', 'kun', 'dist', 'cli', 'serve-entry.js'), 'serve'),
      writeFile(join(resourcesPath, 'app.asar.unpacked', 'kun', 'dist', 'manager', 'manager-entry.js'), 'manager')
    ])
    return { executablePath, resourcesPath }
  }

  it('accepts a complete packaged payload', async () => {
    const input = await createHealthyPayload()

    expect(inspectPackagedInstallHealth({ isPackaged: true, ...input })).toEqual({ ok: true })
  })

  it('reports every missing or empty runtime component', async () => {
    const input = await createHealthyPayload()
    await writeFile(join(input.resourcesPath, 'app.asar'), '')
    await rm(join(input.resourcesPath, 'app.asar.unpacked', 'kun', 'dist', 'manager', 'manager-entry.js'))

    expect(inspectPackagedInstallHealth({ isPackaged: true, ...input })).toEqual({
      ok: false,
      missing: ['resources/app.asar', 'Kun service manager entry']
    })
  })

  it('does not block source and development runs', () => {
    expect(inspectPackagedInstallHealth({
      isPackaged: false,
      executablePath: 'missing.exe',
      resourcesPath: 'missing-resources'
    })).toEqual({ ok: true })
  })

  it('uses Electron original-fs so app.asar is checked as a physical file', () => {
    const rawStat = resolveInstallHealthFileStat((id) => {
      expect(id).toBe('original-fs')
      return {
        statSync: () => ({
          isFile: () => true,
          size: 42
        })
      }
    })

    expect(rawStat('resources/app.asar').isFile()).toBe(true)
    expect(rawStat('resources/app.asar').size).toBe(42)
  })
})
