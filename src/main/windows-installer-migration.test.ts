import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const helperPath = join(process.cwd(), 'build/windows-installer-migration.ps1')
const windowsOnly = process.platform === 'win32' ? describe : describe.skip
const tempRoots: string[] = []

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kun-installer-migration-'))
  tempRoots.push(root)
  return root
}

function runHelper(input: {
  action: 'ResolvePath' | 'ResolveSource' | 'Recover' | 'Prepare' | 'FallbackCleanup' | 'Restore'
  source?: string
  secondary?: string
  candidate?: string
  target?: string
  journal?: string
  resultPath?: string
  uninstallCommand?: string
}) {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return spawnSync(
    powershell,
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      helperPath,
      '-Action',
      input.action,
      ...(input.resultPath ? ['-ResultPath', input.resultPath] : [])
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        KUN_INSTALLER_SOURCE: input.source ?? '',
        KUN_INSTALLER_SECONDARY_SOURCE: input.secondary ?? '',
        KUN_INSTALLER_CANDIDATE: input.candidate ?? '',
        KUN_INSTALLER_TARGET: input.target ?? '',
        KUN_INSTALLER_JOURNAL: input.journal ?? join(makeTempRoot(), 'journal.json'),
        KUN_INSTALLER_UNINSTALL_STRING: input.uninstallCommand ?? '',
        KUN_INSTALLER_SELF_PID: String(process.pid)
      }
    }
  )
}

function processError(result: ReturnType<typeof runHelper>): string {
  return String(result.stderr ?? '')
}

function readJournal(path: string): { Records: Array<{ Stash: string }> } {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as {
    Records: Array<{ Stash: string }>
  }
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

windowsOnly('Windows installer migration helper', () => {
  it.each([
    ['C:\\Users\\me\\AppData\\Local\\Programs\\DeepSeek GUI', '', 'C:\\Users\\me\\AppData\\Local\\Programs\\Kun'],
    ['D:\\Apps\\deepseek-gui', '', 'D:\\Apps\\Kun'],
    ['D:\\Apps\\DeepSeek GUI\\Kun', '', 'D:\\Apps\\Kun'],
    ['D:\\Legacy\\DeepSeek GUI', 'C:\\Users\\me\\AppData\\Local\\Programs\\Kun', 'D:\\Legacy\\Kun'],
    ['D:\\Apps\\Custom AI', 'D:\\Apps\\Custom AI', 'D:\\Apps\\Custom AI'],
    ['', 'D:\\Apps', 'D:\\Apps\\Kun'],
    ['', 'D:\\KunTools', 'D:\\KunTools\\Kun'],
    ['', 'D:\\Unicode 测试\\', 'D:\\Unicode 测试\\Kun']
  ])('resolves source %s and candidate %s to %s', (source, candidateOverride, expected) => {
    const candidate = candidateOverride || source
    const result = runHelper({ action: 'ResolvePath', source, candidate })

    expect(result.status, processError(result)).toBe(0)
    expect(result.stdout).toBe(expected)
  })

  it('writes a recovered install source to the explicit result path', () => {
    const root = makeTempRoot()
    const source = join(root, 'DeepSeek GUI')
    const resultPath = join(root, 'resolved-source.txt')
    mkdirSync(source, { recursive: true })
    const canonicalSource = realpathSync.native(source)
    const result = runHelper({
      action: 'ResolveSource',
      resultPath,
      uninstallCommand: `"${join(source, 'Uninstall Kun.exe')}" /currentuser`
    })

    expect(result.status, processError(result)).toBe(0)
    expect(result.stdout).toBe(canonicalSource)
    expect(readFileSync(resultPath, 'utf16le')).toBe(canonicalSource)
  })

  it('preserves unknown top-level content and restores it after fallback cleanup', () => {
    const root = makeTempRoot()
    const source = join(root, 'DeepSeek GUI')
    const target = join(root, 'Kun')
    const journal = join(root, 'recovery', 'journal.json')
    mkdirSync(join(source, 'resources'), { recursive: true })
    writeFileSync(join(source, 'Kun.exe'), 'app')
    writeFileSync(join(source, 'notes.txt'), 'keep me')

    const prepared = runHelper({ action: 'Prepare', source, target, journal })
    expect(prepared.status, processError(prepared)).toBe(0)
    expect(existsSync(join(source, 'notes.txt'))).toBe(false)
    expect(existsSync(join(source, 'Kun.exe'))).toBe(true)

    const journalData = readJournal(journal)
    expect(readFileSync(join(journalData.Records[0].Stash, 'content', 'notes.txt'), 'utf8')).toBe(
      'keep me'
    )

    const cleaned = runHelper({ action: 'FallbackCleanup', source, target, journal })
    expect(cleaned.status, processError(cleaned)).toBe(0)
    expect(existsSync(join(source, 'Kun.exe'))).toBe(false)

    const restored = runHelper({ action: 'Restore', source, target, journal })
    expect(restored.status, processError(restored)).toBe(0)
    expect(readFileSync(join(source, 'notes.txt'), 'utf8')).toBe('keep me')
    expect(existsSync(journal)).toBe(false)
  })

  it('recovers an interrupted preservation journal idempotently', () => {
    const root = makeTempRoot()
    const source = join(root, 'Custom Install')
    const journal = join(root, 'recovery', 'journal.json')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'Kun.exe'), 'app')
    writeFileSync(join(source, 'personal.txt'), 'personal')

    const prepared = runHelper({ action: 'Prepare', source, target: source, journal })
    expect(prepared.status, processError(prepared)).toBe(0)
    expect(existsSync(join(source, 'personal.txt'))).toBe(false)

    const firstRecovery = runHelper({ action: 'Recover', source, target: source, journal })
    expect(firstRecovery.status, processError(firstRecovery)).toBe(0)
    expect(readFileSync(join(source, 'personal.txt'), 'utf8')).toBe('personal')

    const secondRecovery = runHelper({ action: 'Recover', source, target: source, journal })
    expect(secondRecovery.status, processError(secondRecovery)).toBe(0)
    expect(readdirSync(source).sort()).toEqual(['Kun.exe', 'personal.txt'])
  })

  it('preserves registered per-user content alongside an all-users source', () => {
    const root = makeTempRoot()
    const source = join(root, 'Machine Kun')
    const secondary = join(root, 'User Kun')
    const journal = join(root, 'recovery', 'journal.json')
    for (const directory of [source, secondary]) {
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'Kun.exe'), 'app')
      writeFileSync(join(directory, 'personal.txt'), directory)
    }

    const result = runHelper({
      action: 'Prepare',
      source,
      target: source,
      journal,
      secondary
    })
    expect(result.status, processError(result)).toBe(0)
    expect(existsSync(join(source, 'personal.txt'))).toBe(false)
    expect(existsSync(join(secondary, 'personal.txt'))).toBe(false)

    const restored = runHelper({ action: 'Restore', source, target: source, journal, secondary })
    expect(restored.status, processError(restored)).toBe(0)
    expect(readFileSync(join(source, 'personal.txt'), 'utf8')).toBe(source)
    expect(readFileSync(join(secondary, 'personal.txt'), 'utf8')).toBe(secondary)
  })

  it('retains the recovery directory and journal when restoration would overwrite a file', () => {
    const root = makeTempRoot()
    const source = join(root, 'Custom Install')
    const journal = join(root, 'recovery', 'journal.json')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'Kun.exe'), 'app')
    writeFileSync(join(source, 'personal.txt'), 'original')

    const prepared = runHelper({ action: 'Prepare', source, target: source, journal })
    expect(prepared.status, processError(prepared)).toBe(0)
    writeFileSync(join(source, 'personal.txt'), 'conflict')

    const restored = runHelper({ action: 'Restore', source, target: source, journal })
    expect(restored.status).not.toBe(0)
    expect(restored.stderr).toContain('conflicts with existing paths')
    expect(readFileSync(join(source, 'personal.txt'), 'utf8')).toBe('conflict')
    expect(existsSync(journal)).toBe(true)
    const journalData = readJournal(journal)
    expect(readFileSync(join(journalData.Records[0].Stash, 'content', 'personal.txt'), 'utf8')).toBe(
      'original'
    )
  })

  it('rejects a non-empty conflicting canonical target without changing either install', () => {
    const root = makeTempRoot()
    const source = join(root, 'DeepSeek GUI')
    const target = join(root, 'Kun')
    const journal = join(root, 'recovery', 'journal.json')
    mkdirSync(source, { recursive: true })
    mkdirSync(target, { recursive: true })
    writeFileSync(join(source, 'Kun.exe'), 'legacy')
    writeFileSync(join(target, 'occupied.txt'), 'occupied')

    const result = runHelper({ action: 'Prepare', source, target, journal })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('cannot be merged safely')
    expect(readFileSync(join(source, 'Kun.exe'), 'utf8')).toBe('legacy')
    expect(readFileSync(join(target, 'occupied.txt'), 'utf8')).toBe('occupied')
    expect(existsSync(journal)).toBe(false)
  })

  it('rejects protected roots and reparse-point install roots', () => {
    const root = makeTempRoot()
    const journal = join(root, 'recovery', 'journal.json')
    const protectedResult = runHelper({
      action: 'Prepare',
      target: process.env.LOCALAPPDATA,
      journal
    })
    expect(protectedResult.status).not.toBe(0)
    expect(protectedResult.stderr).toContain('shared or protected root')

    const volumeRootResult = runHelper({
      action: 'Prepare',
      target: parse(root).root,
      journal
    })
    expect(volumeRootResult.status).not.toBe(0)

    const realSource = join(root, 'real-source')
    const linkedSource = join(root, 'linked-source')
    const target = join(root, 'Kun')
    mkdirSync(realSource, { recursive: true })
    writeFileSync(join(realSource, 'Kun.exe'), 'app')
    symlinkSync(realSource, linkedSource, 'junction')

    const linkedResult = runHelper({ action: 'Prepare', source: linkedSource, target, journal })
    expect(linkedResult.status).not.toBe(0)
    expect(linkedResult.stderr).toContain('reparse point')
    expect(readFileSync(join(realSource, 'Kun.exe'), 'utf8')).toBe('app')
  })
})
