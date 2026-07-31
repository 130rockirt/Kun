import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const kunDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const vitest = join(kunDir, 'node_modules', 'vitest', 'vitest.mjs')
const result = spawnSync(process.execPath, [
  '--max-old-space-size=512',
  vitest,
  'run',
  'src/loop/tool-execution-memory-regression.test.ts'
], {
  cwd: kunDir,
  env: process.env,
  stdio: 'inherit'
})

if (result.error) throw result.error
if (result.signal) {
  process.stderr.write(`Memory growth regression terminated by ${result.signal}.\n`)
  process.exit(1)
}
process.exit(result.status ?? 1)
