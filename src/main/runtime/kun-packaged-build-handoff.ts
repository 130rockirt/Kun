import { app } from 'electron'
import { defaultKunControlDir } from '../../../kun/src/manager/manager-discovery.js'
import { resolveCliRuntimeFlavor } from '../../../kun/src/cli/runtime-flavor.js'
import {
  resolveKunExecutable,
  resolveKunRuntimeBuildId
} from '../resolve-kun-binary'
import {
  drainKunOwnersForHandoff,
  installedBuildProbeError,
  probeInstalledBuildHandoff
} from './kun-installed-build-handoff'
import {
  createHandoffEventReporter,
  type HandoffEventListener
} from './kun-handoff-events'

function appRoot(): string {
  return app.isPackaged
    ? app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
    : app.getAppPath()
}

export async function preparePackagedKunBuildHandoff(input: {
  dataDir: string
  settingsPath: string
  onHandoffEvent?: HandoffEventListener
}): Promise<boolean> {
  const flavor = resolveCliRuntimeFlavor({ env: process.env })
  if (!app.isPackaged || flavor !== 'production') return false
  const buildId = await resolveKunRuntimeBuildId(resolveKunExecutable(appRoot(), ''))
  const handoffInput = {
    reason: 'installed-build-change' as const,
    dataDirs: [input.dataDir],
    settingsPath: input.settingsPath,
    controlDir: defaultKunControlDir(),
    onEvent: createHandoffEventReporter(input.onHandoffEvent),
    ...(buildId ? { targetBuildId: buildId } : {})
  }
  const probe = await probeInstalledBuildHandoff(handoffInput)
  const probeError = installedBuildProbeError(handoffInput, probe)
  if (probeError) throw probeError
  if (probe === 'matched') return false
  await drainKunOwnersForHandoff(handoffInput)
  return true
}
