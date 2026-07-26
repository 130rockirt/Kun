import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeDiscoveryRecord } from '../server/runtime-discovery.js'
import { buildRuntimeCapabilityManifest } from '../contracts/capabilities.js'
import { modelCapabilitiesForModel } from '../loop/model-context-profile.js'
import {
  ensureSharedRuntime,
  probeRuntimeDiscovery,
  resolveSharedRuntime,
  runRuntimeCommand,
  stopSharedRuntime
} from './shared-runtime.js'

function record(overrides: Partial<RuntimeDiscoveryRecord> = {}): RuntimeDiscoveryRecord {
  return {
    version: 2,
    instanceId: 'runtime-a',
    pid: process.pid,
    startedAt: '2026-07-22T00:00:00.000Z',
    host: '127.0.0.1',
    port: 18899,
    baseUrl: 'http://127.0.0.1:18899',
    runtimeToken: 'secret',
    insecure: false,
    serviceVersion: '0.1.0',
    launchMode: 'shared',
    ...overrides
  }
}

describe('shared runtime discovery validation', () => {
  it('uses the GUI-configured data dir by default while preserving explicit precedence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-runtime-gui-data-dir-'))
    const settingsPath = join(root, 'gui', 'kun-settings.json')
    const guiDataDir = join(root, 'legacy-gui-data')
    const explicitDataDir = join(root, 'explicit-data')
    await mkdir(join(root, 'gui'), { recursive: true })
    await writeFile(settingsPath, JSON.stringify({
      provider: { providers: [] },
      agents: { kun: { dataDir: guiDataDir, model: '', providerId: '' } }
    }), 'utf8')
    try {
      let stdout = ''
      expect(await runRuntimeCommand(['status'], {
        stdout: { write: (chunk) => { stdout += chunk } },
        stderr: { write: () => undefined },
        env: { KUN_GUI_SETTINGS_PATH: settingsPath },
        fetch: (async () => new Response('', { status: 404 })) as typeof fetch
      })).toBe(0)
      expect(stdout).toContain(`Data directory: ${guiDataDir}`)

      stdout = ''
      expect(await runRuntimeCommand(['status', '--data-dir', explicitDataDir], {
        stdout: { write: (chunk) => { stdout += chunk } },
        stderr: { write: () => undefined },
        env: { KUN_GUI_SETTINGS_PATH: settingsPath },
        fetch: (async () => new Response('', { status: 404 })) as typeof fetch
      })).toBe(0)
      expect(stdout).toContain(`Data directory: ${explicitDataDir}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects non-loopback and URL/port mismatches before sending a token', async () => {
    const fetchImpl = vi.fn()
    await expect(probeRuntimeDiscovery(record({
      host: 'example.com',
      baseUrl: 'http://example.com:18899'
    }), fetchImpl as unknown as typeof fetch)).resolves.toBeNull()
    await expect(probeRuntimeDiscovery(record({
      baseUrl: 'http://127.0.0.1:18900'
    }), fetchImpl as unknown as typeof fetch)).resolves.toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('elects one GUI/TUI-independent custom launch and shuts it down explicitly', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-custom-shared-runtime-'))
    const capabilities = JSON.stringify(buildRuntimeCapabilityManifest({
      model: modelCapabilitiesForModel('fixture')
    }))
    const fixture = String.raw`
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const dataDir = process.argv[1];
const startedAt = new Date().toISOString();
const instanceId = crypto.randomUUID();
const capabilities = ${capabilities};
const server = http.createServer((req, res) => {
  if (req.url === '/v1/runtime/info') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ instanceId, serviceVersion: '0.1.0', launchMode: 'shared', host: '127.0.0.1', port: server.address().port, dataDir, model: 'fixture', approvalPolicy: 'on-request', sandboxMode: 'workspace-write', insecure: false, startedAt, pid: process.pid, capabilities }));
    return;
  }
  if (req.url === '/v1/runtime/shutdown' && req.method === 'POST') {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true }));
    setTimeout(() => server.close(() => { try { fs.unlinkSync(path.join(dataDir, 'runtime.json')); } catch {} process.exit(0); }), 10);
    return;
  }
  if (req.url === '/crash' && req.method === 'POST') {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true }));
    setTimeout(() => process.exit(23), 10);
    return;
  }
  res.statusCode = 404; res.end();
});
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const record = { version: 2, instanceId, pid: process.pid, startedAt, host: '127.0.0.1', port, baseUrl: 'http://127.0.0.1:' + port, runtimeToken: process.env.KUN_RUNTIME_TOKEN, insecure: false, serviceVersion: '0.1.0', launchMode: process.env.KUN_RUNTIME_LAUNCH_MODE, logPath: process.env.KUN_RUNTIME_LOG_PATH };
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, 'runtime.json'), JSON.stringify(record), { mode: 0o600 });
});
`
    try {
      const launch = {
        dataDir,
        launch: { command: process.execPath, args: ['-e', fixture, dataDir], runAsNode: false }
      }
      const [connection, concurrentClient] = await Promise.all([
        ensureSharedRuntime(launch),
        ensureSharedRuntime(launch)
      ])
      expect(connection.discovery.launchMode).toBe('shared')
      expect(concurrentClient.discovery.instanceId).toBe(connection.discovery.instanceId)
      expect(concurrentClient.discovery.pid).toBe(connection.discovery.pid)
      expect(connection.discovery.logPath).toContain('runtime.log')
      const config = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')) as {
        capabilities: Record<string, { enabled: boolean }>
      }
      expect(config.capabilities).toMatchObject({
        skills: { enabled: true },
        attachments: { enabled: true },
        memory: { enabled: true },
        subagents: { enabled: true }
      })
      await fetch(`${connection.discovery.baseUrl}/crash`, { method: 'POST' })
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (!await resolveSharedRuntime(dataDir)) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      const recovered = await ensureSharedRuntime(launch)
      expect(recovered.discovery.instanceId).not.toBe(connection.discovery.instanceId)
      expect(recovered.discovery.pid).not.toBe(connection.discovery.pid)
      expect(await stopSharedRuntime(dataDir)).toBe(true)
    } finally {
      await stopSharedRuntime(dataDir).catch(() => undefined)
      await rm(dataDir, { recursive: true, force: true })
    }
  }, 15_000)
})
