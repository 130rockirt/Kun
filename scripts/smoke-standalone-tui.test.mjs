import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import test from 'node:test'
import {
  createArchiveExtractionInvocation,
  extractArchive,
  isRetryableWindowsRemoveError,
  removeTemporaryDirectory
} from './smoke-standalone-tui.mjs'

const ZIP_FIXTURE = Buffer.from(
  'UEsDBBQAAAgIADJT/1zKTlJ0CQAAAAcAAAAJAAAAcHJvYmUudHh0q8os0M3P5gIAUEsBAj8DFAAACAgAMlP/XMpOUnQJAAAABwAAAAkACQAAAAAAAAAAALSBAAAAAHByb2JlLnR4dFVUBQADoAdsalBLBQYAAAAAAQABAEAAAAAwAAAAAAA=',
  'base64'
)

test('extracts a Windows TUI ZIP without passing it to tar', () => {
  assert.deepEqual(
    createArchiveExtractionInvocation(
      'D:\\a\\Kun\\Kun\\dist\\Kun-TUI-0.2.32-win-x64.zip',
      'C:\\Users\\runner\\Temp\\kun-tui-smoke',
      win32
    ),
    {
      kind: 'zip',
      artifact: 'D:\\a\\Kun\\Kun\\dist\\Kun-TUI-0.2.32-win-x64.zip',
      options: { dir: 'C:\\Users\\runner\\Temp\\kun-tui-smoke' }
    }
  )
})

test('extracts a TUI tarball from its local directory', () => {
  assert.deepEqual(
    createArchiveExtractionInvocation(
      '/release/Kun-TUI-0.2.32-linux-x64.tar.gz',
      '/tmp/kun-tui-smoke',
      posix
    ),
    {
      kind: 'tar',
      command: 'tar',
      args: ['-xf', 'Kun-TUI-0.2.32-linux-x64.tar.gz', '-C', '/tmp/kun-tui-smoke'],
      options: { cwd: '/release', stdio: 'inherit' }
    }
  )
})

test('extracts ZIP contents through the Node ZIP implementation', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'kun-tui-zip-test-'))
  try {
    const archive = join(temporary, 'probe.zip')
    const destination = join(temporary, 'extracted')
    await writeFile(archive, ZIP_FIXTURE)
    await extractArchive(archive, destination)
    assert.equal(await readFile(join(destination, 'probe.txt'), 'utf8'), 'zip-ok\n')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('retries transient Windows file locks while removing the smoke directory', async () => {
  let attempts = 0
  const delays = []
  await removeTemporaryDirectory('C:\\Temp\\kun-tui-smoke', {
    platform: 'win32',
    remove: async () => {
      attempts += 1
      if (attempts < 3) {
        const error = new Error('resource busy')
        error.code = 'EBUSY'
        throw error
      }
    },
    wait: async (milliseconds) => { delays.push(milliseconds) }
  })
  assert.equal(attempts, 3)
  assert.deepEqual(delays, [250, 250])
})

test('only retries known Windows temporary-directory lock errors', () => {
  const busy = new Error('resource busy')
  busy.code = 'EBUSY'
  assert.equal(isRetryableWindowsRemoveError(busy, 'win32'), true)
  assert.equal(isRetryableWindowsRemoveError(busy, 'linux'), false)

  const missing = new Error('missing directory')
  missing.code = 'ENOENT'
  assert.equal(isRetryableWindowsRemoveError(missing, 'win32'), false)
})
