import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  countPhysicalLines,
  formatAuditResult,
  inspectTrackedFiles,
  isBinaryContent,
  isPackageManagerLockfile
} from './check-file-lines.mjs'

test('counts the inclusive boundary and a final unterminated line', () => {
  assert.equal(countPhysicalLines('line\n'.repeat(700)), 700)
  assert.equal(countPhysicalLines(`${'line\n'.repeat(699)}line`), 700)
  assert.equal(countPhysicalLines('line\n'.repeat(701)), 701)
  assert.equal(countPhysicalLines('first\r\nsecond\rthird'), 3)
  assert.equal(countPhysicalLines(''), 0)
})

test('classifies binary bytes without excluding ordinary UTF-8 text', () => {
  assert.equal(isBinaryContent(Buffer.from([0x47, 0x49, 0x46, 0x00, 0xff])), true)
  assert.equal(isBinaryContent(Buffer.from([0xff, 0xfe, 0xfd])), true)
  assert.equal(isBinaryContent(Buffer.from('plain text\n中文内容\n')), false)
})

test('recognizes package-manager lockfiles at any repository depth', () => {
  assert.equal(isPackageManagerLockfile('package-lock.json'), true)
  assert.equal(isPackageManagerLockfile('kun/package-lock.json'), true)
  assert.equal(isPackageManagerLockfile('workspace/pnpm-lock.yaml'), true)
  assert.equal(isPackageManagerLockfile('src/lockfile-reader.ts'), false)
})

test('reports every oversized tracked text file in stable path order', async (context) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'kun-file-lines-'))
  context.after(async () => rm(repositoryRoot, { recursive: true, force: true }))

  spawnSync('git', ['init', '--quiet'], { cwd: repositoryRoot })
  await mkdir(join(repositoryRoot, 'nested'), { recursive: true })
  await writeFile(join(repositoryRoot, 'zeta.txt'), 'z\n'.repeat(701))
  await writeFile(join(repositoryRoot, 'nested', 'alpha.custom'), 'a\n'.repeat(702))
  await writeFile(join(repositoryRoot, 'short.txt'), 'short without trailing newline')
  await writeFile(join(repositoryRoot, 'package-lock.json'), '{}\n'.repeat(900))
  await writeFile(join(repositoryRoot, 'asset.bin'), Buffer.from([0x00, 0xff, 0x00, 0xff]))
  const add = spawnSync('git', ['add', '.'], { cwd: repositoryRoot, encoding: 'utf8' })
  assert.equal(add.status, 0, add.stderr)

  const result = await inspectTrackedFiles({ root: repositoryRoot })
  assert.deepEqual(result.violations, [
    { lineCount: 702, path: 'nested/alpha.custom' },
    { lineCount: 701, path: 'zeta.txt' }
  ])
  assert.equal(result.checkedTextFiles, 3)
  assert.equal(result.excludedBinaryFiles, 1)
  assert.equal(result.excludedLockfiles, 1)
  assert.equal(result.missingTrackedFiles, 0)
  assert.equal(
    formatAuditResult(result),
    [
      'File line limit failed: 2 tracked text file(s) exceed 700 lines.',
      'nested/alpha.custom: 702 lines (maximum 700)',
      'zeta.txt: 701 lines (maximum 700)'
    ].join('\n')
  )
})

test('passes when all applicable tracked text files are within the limit', async (context) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'kun-file-lines-pass-'))
  context.after(async () => rm(repositoryRoot, { recursive: true, force: true }))

  spawnSync('git', ['init', '--quiet'], { cwd: repositoryRoot })
  await writeFile(join(repositoryRoot, 'boundary.txt'), 'line\n'.repeat(700))
  spawnSync('git', ['add', '.'], { cwd: repositoryRoot })

  const result = await inspectTrackedFiles({ root: repositoryRoot })
  assert.equal(result.violations.length, 0)
  assert.equal(
    formatAuditResult(result),
    'File line limit passed: 1 tracked text files are at or below 700 lines.'
  )
})
