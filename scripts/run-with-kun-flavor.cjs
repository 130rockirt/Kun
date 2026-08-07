#!/usr/bin/env node
const { spawnSync } = require('node:child_process')

const [flavor, command, ...args] = process.argv.slice(2)
if ((flavor !== 'production' && flavor !== 'development') || !command) {
  process.stderr.write('usage: run-with-kun-flavor.cjs <production|development> <command> [...args]\n')
  process.exit(64)
}

const executable = process.platform === 'win32' && !/\.(?:cmd|exe)$/iu.test(command)
  ? `${command}.cmd`
  : command
// On Windows, .cmd batch scripts cannot be launched directly via CreateProcess;
// they must go through cmd.exe, otherwise spawnSync fails with EINVAL.
const needsCmdShell = process.platform === 'win32' && /\.cmd$/iu.test(executable)
let electronCliArgs = []
try {
  const configured = JSON.parse(process.env.ELECTRON_CLI_ARGS || '[]')
  if (Array.isArray(configured)) electronCliArgs = configured.filter((value) =>
    typeof value === 'string' &&
    !value.startsWith('--kun-app-flavor') &&
    !value.startsWith('--kun-app-name')
  )
} catch {
  electronCliArgs = []
}
electronCliArgs.push(`--kun-app-flavor=${flavor}`)
if (flavor === 'development') electronCliArgs.push('--kun-app-name=kun-dv')
const result = spawnSync(executable, args, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    KUN_APP_FLAVOR: flavor,
    KUN_RUNTIME_FLAVOR: flavor,
    ...(flavor === 'development'
      ? { KUN_ALLOW_DEVELOPMENT_MANAGER_BOOTSTRAP: '1' }
      : {}),
    ELECTRON_CLI_ARGS: JSON.stringify(electronCliArgs)
  },
  stdio: 'inherit',
  ...(needsCmdShell ? { shell: true } : {})
})

if (result.error) {
  process.stderr.write(`${result.error.message}\n`)
  process.exit(70)
}
process.exit(result.status ?? 70)
