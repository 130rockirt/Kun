import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const kunTests = [
  'src/contracts/graph.test.ts',
  'src/graph/graph-platform-path.test.ts',
  'src/graph/graph-write-coordinator.test.ts',
  'src/graph/graph-run-store.test.ts',
  'src/graph/project-agent-registry.test.ts',
  'src/graph/graph-assignment.test.ts',
  'src/graph/graph-scheduler.test.ts',
  'src/graph/graph-admission-remediation.test.ts',
  'src/graph/graph-tool-boundary.test.ts',
  'src/server/graph-runtime-bootstrap.test.ts',
  'src/server/graph-runtime-factory.test.ts',
  'src/tui/graph-mode.test.ts',
  'src/tui/commands.test.ts',
  'src/tui/client.test.ts',
  'src/tui/controller.test.ts',
  'src/tui/state.test.ts',
  'src/tui/pi-app.test.ts'
]

const rendererTests = [
  'src/renderer/src/components/chat/FloatingComposerGraphProgress.test.ts',
  'src/renderer/src/components/graph/GraphModePanel.test.ts',
  'src/renderer/src/components/graph/GraphNodeInspector.test.ts',
  'src/renderer/src/components/graph/GraphRunCanvas.test.ts',
  'src/renderer/src/components/workbench-layout.test.ts',
  'src/renderer/src/graph/graph-store.test.ts'
]

run(npmExecutable, [
  '--prefix',
  'kun',
  'test',
  '--',
  ...kunTests,
  '--reporter=dot'
])

run(process.execPath, [
  join(root, 'node_modules', 'vitest', 'vitest.mjs'),
  'run',
  ...rendererTests,
  '--reporter=dot'
])

process.stdout.write(
  `Graph platform suite passed on ${process.platform}/${process.arch}.\n`
)

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  if (result.signal) {
    throw new Error(`Graph platform suite terminated by ${result.signal}`)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}
