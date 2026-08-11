import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { createEditLocalTool, createWriteLocalTool } from './builtin-file-tools.js'

const cleanup: string[] = []

function context(workspace: string, sandboxMode: 'workspace-write' | 'danger-full-access'): ToolHostContext {
  return {
    threadId: 'thr_delegated_files',
    turnId: 'turn_delegated_files',
    workspace,
    sandboxMode,
    approvalPolicy: 'never',
    allowedReadPaths: ['presentations'],
    allowedWritePaths: ['presentations'],
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow'
  }
}

async function fixture(): Promise<{ root: string; outside: string }> {
  const root = await mkdtemp(join(tmpdir(), 'kun-delegated-write-'))
  const outside = await mkdtemp(join(tmpdir(), 'kun-delegated-outside-'))
  cleanup.push(root, outside)
  await Promise.all([
    mkdir(join(root, 'presentations'), { recursive: true }),
    mkdir(join(root, 'src'), { recursive: true })
  ])
  return { root, outside }
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe.each(['workspace-write', 'danger-full-access'] as const)(
  'delegated file mutation physical scopes (%s)',
  (sandboxMode) => {
    it('rejects write and edit symlink escapes from an allowed lexical scope', async () => {
      const { root } = await fixture()
      await writeFile(join(root, 'src', 'secret.txt'), 'outside-scope')
      await symlink('../src', join(root, 'presentations', 'linked'), 'dir')
      await symlink('../src/secret.txt', join(root, 'presentations', 'secret.txt'))

      const write = await createWriteLocalTool().execute(
        { path: 'presentations/linked/new.txt', content: 'escaped' },
        context(root, sandboxMode)
      )
      const edit = await createEditLocalTool().execute(
        { path: 'presentations/secret.txt', oldText: 'outside', newText: 'changed' },
        context(root, sandboxMode)
      )

      expect(write.isError).toBe(true)
      expect(edit.isError).toBe(true)
      expect(JSON.stringify(write.output)).toContain('resolves outside')
      expect(JSON.stringify(edit.output)).toContain('resolves outside')
      await expect(readFile(join(root, 'src', 'new.txt'))).rejects.toThrow()
      expect(await readFile(join(root, 'src', 'secret.txt'), 'utf8')).toBe('outside-scope')
    })

    it('rejects hard-linked write and edit targets', async () => {
      const { root, outside } = await fixture()
      const outsideFile = join(outside, 'shared.txt')
      await writeFile(outsideFile, 'shared-content')
      await link(outsideFile, join(root, 'presentations', 'shared.txt'))

      const write = await createWriteLocalTool().execute(
        { path: 'presentations/shared.txt', content: 'overwritten' },
        context(root, sandboxMode)
      )
      const edit = await createEditLocalTool().execute(
        { path: 'presentations/shared.txt', oldText: 'shared', newText: 'changed' },
        context(root, sandboxMode)
      )

      expect(write.isError).toBe(true)
      expect(edit.isError).toBe(true)
      expect(JSON.stringify(write.output)).toContain('exactly one hard link')
      expect(JSON.stringify(edit.output)).toContain('exactly one hard link')
      expect(await readFile(outsideFile, 'utf8')).toBe('shared-content')
    })

    it('rechecks write scope after directory creation inside the mutation queue', async () => {
      const { root } = await fixture()
      const tool = createWriteLocalTool({
        operations: {
          mkdir: async (path) => symlink('../../src', path, 'dir').then(() => undefined),
          writeFile: async (path, content) => writeFile(path, content)
        }
      })

      const result = await tool.execute(
        { path: 'presentations/new/file.txt', content: 'escaped' },
        context(root, sandboxMode)
      )

      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.output)).toContain('resolves outside')
      await expect(readFile(join(root, 'src', 'file.txt'))).rejects.toThrow()
    })

    it('rechecks edit scope after reading and before writing', async () => {
      const { root } = await fixture()
      const target = join(root, 'presentations', 'deck.txt')
      const secret = join(root, 'src', 'secret.txt')
      await writeFile(target, 'deck-original')
      await writeFile(secret, 'secret-original')
      const tool = createEditLocalTool({
        operations: {
          readFile: async (path) => {
            const content = await readFile(path, 'utf8')
            await rm(path)
            await symlink('../src/secret.txt', path)
            return content
          },
          writeFile: async (path, content) => writeFile(path, content)
        }
      })

      const result = await tool.execute(
        { path: 'presentations/deck.txt', oldText: 'original', newText: 'changed' },
        context(root, sandboxMode)
      )

      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.output)).toContain('resolves outside')
      expect(await readFile(secret, 'utf8')).toBe('secret-original')
    })
  }
)
