import { app } from 'electron'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, win32 as win32Path } from 'node:path'
import { mainState } from './main-app-context'
import { probeRuntimeApi } from './main-runtime-health'
import { startMainApp } from './main-ready'

const HEALTH_PATH_ARG = '--kun-update-health-check='
const HEALTH_TOKEN_ARG = '--kun-update-health-token='
const HEALTH_TARGET_ARG = '--kun-update-target='

type UpdateHealthRequest = {
  resultPath: string
  token: string
  target: string
}

function argumentValue(prefix: string, argv = process.argv): string {
  const argument = argv.find((value) => value.startsWith(prefix))
  return argument ? argument.slice(prefix.length).trim() : ''
}

export function readUpdateHealthRequest(argv = process.argv): UpdateHealthRequest | null {
  const resultPath = argumentValue(HEALTH_PATH_ARG, argv)
  if (!resultPath) return null
  const token = argumentValue(HEALTH_TOKEN_ARG, argv)
  const target = argumentValue(HEALTH_TARGET_ARG, argv)
  if (!token || !target) throw new Error('The update health request is incomplete.')
  return { resultPath, token, target }
}

async function writeHealthResult(
  request: UpdateHealthRequest,
  ok: boolean,
  message: string
): Promise<void> {
  await mkdir(dirname(request.resultPath), { recursive: true })
  const temporary = `${request.resultPath}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify({
    schemaVersion: 1,
    ok,
    token: request.token,
    installDir: win32Path.dirname(process.execPath),
    version: app.getVersion(),
    message,
    at: new Date().toISOString()
  })}\n`, 'utf8')
  await rename(temporary, request.resultPath)
}

export async function runUpdateHealthCheck(request: UpdateHealthRequest): Promise<void> {
  try {
    if (process.platform !== 'win32') throw new Error('Update health checks require Windows.')
    const installDir = win32Path.dirname(process.execPath)
    if (win32Path.resolve(installDir).toLowerCase() !== win32Path.resolve(request.target).toLowerCase()) {
      throw new Error('The candidate executable is outside the committed install target.')
    }
    await startMainApp()
    const window = mainState.mainWindow
    if (!window || window.isDestroyed()) throw new Error('The candidate workbench window did not initialize.')
    const settings = await mainState.store.load()
    const health = await probeRuntimeApi(settings)
    if (!health.ok) throw new Error(health.message)
    await writeHealthResult(request, true, 'Candidate application and runtime are healthy.')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await writeHealthResult(request, false, message)
    throw error
  }
}
