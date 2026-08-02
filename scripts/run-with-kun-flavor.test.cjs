const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
const test = require('node:test')

const launcher = join(__dirname, 'run-with-kun-flavor.cjs')

function environmentFor(flavor) {
  const output = execFileSync(process.execPath, [
    launcher,
    flavor,
    process.execPath,
    '-e',
    `process.stdout.write(JSON.stringify({
      app: process.env.KUN_APP_FLAVOR,
      runtime: process.env.KUN_RUNTIME_FLAVOR,
      bootstrap: process.env.KUN_ALLOW_DEVELOPMENT_MANAGER_BOOTSTRAP,
      electronArgs: JSON.parse(process.env.ELECTRON_CLI_ARGS || '[]')
    }))`
  ], { encoding: 'utf8' })
  return JSON.parse(output)
}

test('marks only the explicit development launcher for source Manager bootstrap', () => {
  assert.deepEqual(environmentFor('development'), {
    app: 'development',
    runtime: 'development',
    bootstrap: '1',
    electronArgs: [
      '--kun-app-flavor=development',
      '--kun-app-name=kun-dv'
    ]
  })
  assert.deepEqual(environmentFor('production'), {
    app: 'production',
    runtime: 'production',
    electronArgs: ['--kun-app-flavor=production']
  })
})
