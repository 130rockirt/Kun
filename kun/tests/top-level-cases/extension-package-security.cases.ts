import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as yazl from 'yazl'
import { describe, expect, it, vi } from 'vitest'
import {
  EXTENSION_INTEGRITY_FILE,
  ExtensionIndexClient,
  ExtensionPackageManager,
  ExtensionPaths,
  ExtensionRegistry,
  ExtensionStateMigrationCoordinator,
  ExtensionStateStore,
  extractKunxArchive,
  inspectKunxArchive,
  packKunx,
  type ExtensionCompatibility,
  type ExtensionManager,
  type JsonValue,
  type ResolvedExtension
} from '../../src/extensions/index.js'
import { compatibility, integrityFor, makeWritable, manifestFor, replaceAllAscii, requiredFiles, writeExtensionSource, writeZip } from '../support/extension-package-fixtures.js'

describe('extension package management', () => {
  it('packs a manifest allowlist and applies explicit safe include and ignore paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-extension-pack-selection-'))
    try {
      const source = join(root, 'source')
      await writeExtensionSource(source, '1.0.0')
      await mkdir(join(source, 'node_modules/dependency'), { recursive: true })
      await mkdir(join(source, '.git/objects'), { recursive: true })
      await mkdir(join(source, 'src'), { recursive: true })
      await mkdir(join(source, 'dist/chunks'), { recursive: true })
      await writeFile(join(source, 'node_modules/dependency/index.js'), 'module.exports = 1\n')
      await writeFile(join(source, '.git/config'), '[core]\n')
      await writeFile(join(source, '.env'), 'API_KEY=must-not-ship\n')
      await writeFile(join(source, 'secrets.json'), '{"token":"must-not-ship"}\n')
      await writeFile(join(source, 'private-key.pem'), 'must-not-ship\n')
      await writeFile(join(source, 'src/index.ts'), 'export const sourceOnly = true\n')
      await writeFile(join(source, 'dist/chunks/runtime.js'), 'export const runtime = true\n')
      await writeFile(join(source, 'dist/chunks/debug.map'), '{"sources":[]}\n')

      const defaultPack = await packKunx(source, join(root, 'default.kunx'), { compatibility })
      expect(Object.keys(defaultPack.integrity.files).sort()).toEqual([
        'LICENSE',
        'README.md',
        'dist/main.mjs',
        'kun-extension.json'
      ])

      const selectedPack = await packKunx(source, join(root, 'selected.kunx'), {
        compatibility,
        include: ['dist/chunks'],
        ignore: ['dist/chunks/debug.map']
      })
      expect(Object.keys(selectedPack.integrity.files)).toContain('dist/chunks/runtime.js')
      expect(Object.keys(selectedPack.integrity.files)).not.toContain('dist/chunks/debug.map')
      expect(Object.keys(selectedPack.integrity.files)).not.toContain('.env')

      await expect(
        packKunx(source, join(root, 'escape.kunx'), { compatibility, include: ['../outside'] })
      ).rejects.toMatchObject({ code: 'EXTENSION_PACKAGE_RULE_INVALID' })
      await expect(
        packKunx(source, join(root, 'secret.kunx'), { compatibility, include: ['.env'] })
      ).rejects.toMatchObject({ code: 'EXTENSION_PACKAGE_FORBIDDEN_PATH' })

      if (process.platform !== 'win32') {
        await symlink(root, join(source, 'dist/chunks/escape'))
        await expect(
          packKunx(source, join(root, 'link.kunx'), {
            compatibility,
            include: ['dist/chunks'],
            ignore: ['dist/chunks/debug.map']
          })
        ).rejects.toMatchObject({ code: 'EXTENSION_PACKAGE_LINK_FORBIDDEN' })

        const linkedSource = join(root, 'linked-source')
        await mkdir(join(linkedSource, 'dist'), { recursive: true })
        await writeFile(join(linkedSource, 'README.md'), '# Linked manifest\n')
        await writeFile(join(linkedSource, 'LICENSE'), 'MIT\n')
        await writeFile(join(linkedSource, 'dist/main.mjs'), 'export async function activate() {}\n')
        await symlink(join(source, 'kun-extension.json'), join(linkedSource, 'kun-extension.json'))
        await expect(
          packKunx(linkedSource, join(root, 'manifest-link.kunx'), { compatibility })
        ).rejects.toMatchObject({ code: 'EXTENSION_PACKAGE_LINK_FORBIDDEN' })

        const linkedRoot = join(root, 'linked-root')
        await symlink(source, linkedRoot)
        await expect(
          packKunx(linkedRoot, join(root, 'source-link.kunx'), { compatibility })
        ).rejects.toMatchObject({ code: 'EXTENSION_PACKAGE_SOURCE_INVALID' })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects traversal, case collisions, symlinks, integrity mismatches, and package limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-extension-attacks-'))
    try {
      const collision = join(root, 'collision.kunx')
      await writeZip(collision, [
        ['A.txt', Buffer.from('a'), 0o100644],
        ['a.txt', Buffer.from('b'), 0o100644]
      ])
      await expect(
        extractKunxArchive(collision, join(root, 'collision-out'))
      ).rejects.toMatchObject({ code: 'EXTENSION_ARCHIVE_PATH_COLLISION' })

      const symlink = join(root, 'symlink.kunx')
      await writeZip(symlink, [['link', Buffer.from('../outside'), 0o120777]])
      await expect(
        extractKunxArchive(symlink, join(root, 'symlink-out'))
      ).rejects.toMatchObject({ code: 'EXTENSION_ARCHIVE_LINK_FORBIDDEN' })

      const traversalBase = join(root, 'traversal-base.kunx')
      await writeZip(traversalBase, [['abcd', Buffer.from('x'), 0o100644]])
      const traversalBytes = Buffer.from(await readFile(traversalBase))
      replaceAllAscii(traversalBytes, 'abcd', '../x')
      const traversal = join(root, 'traversal.kunx')
      await writeFile(traversal, traversalBytes)
      await expect(
        extractKunxArchive(traversal, join(root, 'traversal-out'))
      ).rejects.toMatchObject({ code: 'EXTENSION_ARCHIVE_INVALID' })
      await expect(readFile(join(root, 'x'))).rejects.toMatchObject({ code: 'ENOENT' })

      const invalidIntegrity = join(root, 'invalid-integrity.kunx')
      const manifest = manifestFor('1.0.0')
      const files = requiredFiles(manifest)
      const integrity = integrityFor(files)
      integrity.files['dist/main.mjs'] = '0'.repeat(64)
      await writeZip(invalidIntegrity, [
        ...Object.entries(files).map(([path, contents]) => [path, contents, 0o100644] as const),
        [EXTENSION_INTEGRITY_FILE, Buffer.from(JSON.stringify(integrity)), 0o100644]
      ])
      await expect(
        inspectKunxArchive(invalidIntegrity, { compatibility })
      ).rejects.toMatchObject({ code: 'EXTENSION_PACKAGE_INTEGRITY_MISMATCH' })

      const source = join(root, 'large-source')
      await writeExtensionSource(source, '1.0.0')
      await writeFile(join(source, 'large.bin'), Buffer.alloc(1_024))
      await expect(
        packKunx(source, join(root, 'large.kunx'), {
          include: ['large.bin'],
          limits: { maxFileBytes: 512 }
        })
      ).rejects.toMatchObject({ code: 'EXTENSION_ARCHIVE_LIMIT_EXCEEDED' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('registers mutable development sources but reloads only explicitly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-extension-dev-'))
    try {
      const source = join(root, 'dev-extension')
      await writeExtensionSource(source, '1.0.0')
      await mkdir(join(source, 'dist/assets'), { recursive: true })
      await writeFile(join(source, 'dist/view.html'), '<main>Demo</main>\n')
      await writeFile(join(source, 'dist/assets/theme.css'), 'main { color: black; }\n')
      await writeFile(
        join(source, 'kun-extension.json'),
        `${JSON.stringify({
          ...manifestFor('1.0.0'),
          contributes: {
            'views.rightSidebar': [{
              id: 'demo-view',
              title: 'Demo',
              entry: 'dist/view.html',
              order: 0,
              multiple: false,
              localResourceRoots: ['dist/assets']
            }]
          },
          permissions: ['ui.views', 'webview']
        }, null, 2)}\n`
      )
      const paths = new ExtensionPaths({
        packageRoot: join(root, 'extensions'),
        dataRoot: join(root, 'data')
      })
      const registry = new ExtensionRegistry(paths)
      const manager = new ExtensionPackageManager(paths, registry, { compatibility })
      const registered = await manager.registerDevelopment(source, {
        grantedPermissions: ['ui.views', 'webview']
      })
      expect(registered.path).toBe(source)
      expect((await registry.resolve('acme.demo')).development).toBe(true)

      await writeFile(join(source, 'dist/main.mjs'), 'export const changed = true\n')
      await expect(manager.resolveForActivation('acme.demo')).rejects.toMatchObject({
        code: 'EXTENSION_DEVELOPMENT_RELOAD_REQUIRED'
      })
      const reloaded = await manager.reloadDevelopment('acme.demo')
      expect(reloaded.generation).toBe(2)
      await expect(manager.resolveForActivation('acme.demo')).resolves.toMatchObject({
        development: true,
        generation: 2
      })

      await writeFile(join(source, 'dist/assets/theme.css'), 'main { color: blue; }\n')
      await expect(manager.resolveForActivation('acme.demo')).rejects.toMatchObject({
        code: 'EXTENSION_DEVELOPMENT_RELOAD_REQUIRED'
      })
      await expect(manager.reloadDevelopment('acme.demo')).resolves.toMatchObject({
        generation: 3
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loads an HTTPS Index only on explicit request and installs the exact digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-extension-index-'))
    try {
      const source = join(root, 'source')
      const archive = join(root, 'package.kunx')
      await writeExtensionSource(source, '1.2.3')
      const packed = await packKunx(source, archive, { compatibility })
      const packageBytes = await readFile(archive)
      const index = {
        schemaVersion: 1,
        extensions: [{
          id: 'acme.demo',
          name: 'Demo',
          publisher: 'acme',
          versions: [{
            version: '1.2.3',
            url: 'https://plugins.example/acme.demo-1.2.3.kunx',
            sha256: packed.archiveSha256,
            engines: { kun: '*' },
            apiVersion: '1.0.0',
            permissions: []
          }]
        }]
      }
      const requests: string[] = []
      const client = new ExtensionIndexClient({
        fetch: (async (input: string | URL | Request) => {
          const url = String(input)
          requests.push(url)
          if (url.endsWith('index.json')) {
            return new Response(JSON.stringify(index), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            })
          }
          return new Response(packageBytes, { status: 200 })
        }) as typeof fetch
      })
      expect(requests).toEqual([])

      const paths = new ExtensionPaths({
        packageRoot: join(root, 'extensions'),
        dataRoot: join(root, 'data')
      })
      const registry = new ExtensionRegistry(paths)
      const manager = new ExtensionPackageManager(paths, registry, { compatibility })
      await client.installExact(
        'https://plugins.example/index.json',
        'acme.demo',
        '1.2.3',
        manager,
        { grantedPermissions: [] }
      )
      expect(requests).toEqual([
        'https://plugins.example/index.json',
        'https://plugins.example/acme.demo-1.2.3.kunx'
      ])
      expect((await registry.get('acme.demo'))?.versions['1.2.3']?.source).toMatchObject({
        type: 'index',
        indexUrl: 'https://plugins.example/index.json'
      })
    } finally {
      await makeWritable(root)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects every HTTPS redirect hop that downgrades an index or package request', async () => {
    const indexClient = new ExtensionIndexClient({
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        expect(init?.redirect).toBe('manual')
        return new Response(null, {
          status: 302,
          headers: { location: 'http://attacker.example/index.json' }
        })
      }) as typeof fetch
    })
    await expect(indexClient.load('https://plugins.example/index.json')).rejects.toMatchObject({
      code: 'EXTENSION_INDEX_HTTPS_REQUIRED'
    })

    const root = await mkdtemp(join(tmpdir(), 'kun-extension-index-redirect-'))
    try {
      const index = {
        schemaVersion: 1,
        extensions: [{
          id: 'acme.demo',
          name: 'Demo',
          publisher: 'acme',
          versions: [{
            version: '1.2.3',
            url: 'https://plugins.example/acme.demo-1.2.3.kunx',
            sha256: 'a'.repeat(64),
            engines: { kun: '*' },
            apiVersion: '1.0.0',
            permissions: []
          }]
        }]
      }
      const packageClient = new ExtensionIndexClient({
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          expect(init?.redirect).toBe('manual')
          return String(input).endsWith('index.json')
            ? new Response(JSON.stringify(index), { status: 200 })
            : new Response(null, {
                status: 307,
                headers: { location: 'http://attacker.example/package.kunx' }
              })
        }) as typeof fetch
      })
      const paths = new ExtensionPaths({
        packageRoot: join(root, 'extensions'),
        dataRoot: join(root, 'data')
      })
      const manager = new ExtensionPackageManager(
        paths,
        new ExtensionRegistry(paths),
        { compatibility }
      )
      await expect(packageClient.installExact(
        'https://plugins.example/index.json',
        'acme.demo',
        '1.2.3',
        manager,
        { grantedPermissions: [] }
      )).rejects.toMatchObject({ code: 'EXTENSION_INDEX_HTTPS_REQUIRED' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses the Manifest Ed25519 signature shape for Index v1 metadata', async () => {
    const version = {
      version: '1.2.3',
      url: 'https://plugins.example/acme.demo-1.2.3.kunx',
      sha256: 'a'.repeat(64),
      engines: { kun: '*' },
      apiVersion: '1.0.0',
      permissions: []
    }
    const indexWith = (signature: Record<string, unknown>) => ({
      schemaVersion: 1,
      extensions: [{
        id: 'acme.demo',
        name: 'Demo',
        publisher: 'acme',
        versions: [{ ...version, signature }]
      }]
    })
    const clientFor = (body: unknown) => new ExtensionIndexClient({
      fetch: (async () => new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })) as typeof fetch
    })

    await expect(clientFor(indexWith({
      algorithm: 'ed25519',
      keyId: 'acme-release-2026',
      value: 'base64-signature'
    })).load('https://plugins.example/index.json')).resolves.toMatchObject({
      extensions: [{ versions: [{ signature: { algorithm: 'ed25519' } }] }]
    })
    await expect(clientFor(indexWith({
      kind: 'ed25519',
      value: 'legacy-documentation-shape'
    })).load('https://plugins.example/index.json')).rejects.toMatchObject({
      code: 'EXTENSION_INDEX_INVALID'
    })
  })
})
