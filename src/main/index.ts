import { app } from 'electron'
import {
  mainState,
  runningClawScheduleMcpServer
} from './main-app-context'
import {
  runClawScheduleMcpServerFromArgv
} from './claw-schedule-mcp-server'
import {
  releaseRuntimeDataRecoveryMigrationLock
} from './main-migrations'
import {
  runtimeShutdown,
  stopCheckpointCleanupTimer,
  stopManagedRuntimes,
  stopManagedRuntimesForQuit
} from './main-lifecycle'
import { stopRuntimeWatchdog } from './main-runtime-health'
import { startMainApp } from './main-ready'
import {
  packagedUpdateHandoffSmokeFailure,
  packagedUpdateHandoffSmokeRequested,
  runPackagedUpdateHandoffSmoke
} from './packaged-update-handoff-smoke'

if (runningClawScheduleMcpServer) {
  void runClawScheduleMcpServerFromArgv(process.argv).catch((error) => {
    console.error('[claw-schedule-mcp] server failed:', error)
    process.exit(1)
  })
} else if (packagedUpdateHandoffSmokeRequested()) {
  void runPackagedUpdateHandoffSmoke().then(
    () => app.exit(0),
    (error) => {
      process.stderr.write(`${packagedUpdateHandoffSmokeFailure(error)}\n`)
      app.exit(70)
    }
  )
} else {
  startMainApp()
}

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return
  void stopManagedRuntimes().catch((error) => {
    console.warn('[kun-gui] failed to stop Kun runtime:', error)
  })
  app.quit()
})

app.on('before-quit', (event) => {
  try {
    releaseRuntimeDataRecoveryMigrationLock()
  } catch (error) {
    console.error('[kun-gui] failed to release Runtime data recovery lock during quit:', error)
  }
  runtimeShutdown.requestQuit()
  mainState.protectedCredentialSurface?.dispose()
  stopRuntimeWatchdog()
  stopCheckpointCleanupTimer()
  if (runtimeShutdown.isStoppedForQuit) return
  event.preventDefault()
  void stopManagedRuntimesForQuit()
    .catch((error) => {
      console.warn('[kun-gui] failed to stop Kun runtime:', error)
    })
    .finally(() => {
      app.quit()
    })
})
