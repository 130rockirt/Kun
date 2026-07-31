import assert from 'node:assert/strict'
import { win32 } from 'node:path'
import test from 'node:test'
import { createArchiveExtractionInvocation } from './smoke-standalone-tui.mjs'

test('extracts a Windows TUI archive without passing the drive-qualified path to tar', () => {
  assert.deepEqual(
    createArchiveExtractionInvocation(
      'D:\\a\\Kun\\Kun\\dist\\Kun-TUI-0.2.32-win-x64.zip',
      'C:\\Users\\runner\\Temp\\kun-tui-smoke',
      win32
    ),
    {
      command: 'tar',
      args: [
        '-xf',
        'Kun-TUI-0.2.32-win-x64.zip',
        '-C',
        'C:\\Users\\runner\\Temp\\kun-tui-smoke'
      ],
      options: {
        cwd: 'D:\\a\\Kun\\Kun\\dist',
        stdio: 'inherit'
      }
    }
  )
})
