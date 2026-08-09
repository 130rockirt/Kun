import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemorySessionStore } from '../../src/adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../../src/adapters/in-memory-thread-store.js'
import { createThreadRecord } from '../../src/domain/thread.js'
import { UsageService } from '../../src/services/usage-service.js'
import { createKunServeRuntime, seedUsageCarryover } from '../../src/server/runtime-factory.js'
import type { UsageSnapshot } from '../../src/contracts/usage.js'
import type { SessionStore } from '../../src/ports/session-store.js'
import { KunCapabilitiesConfig } from '../../src/contracts/capabilities.js'
import { startLlmDebugRoundIfEnabled } from '../../src/services/llm-debug-recorder.js'

export function usage(overrides: Partial<UsageSnapshot>): UsageSnapshot {
  const promptTokens = overrides.promptTokens ?? 10
  const completionTokens = overrides.completionTokens ?? 5
  const cacheHitTokens = overrides.cacheHitTokens ?? 0
  const cacheMissTokens = overrides.cacheMissTokens ?? Math.max(promptTokens - cacheHitTokens, 0)
  const cacheTotal = cacheHitTokens + cacheMissTokens
  return {
    promptTokens,
    completionTokens,
    totalTokens: overrides.totalTokens ?? promptTokens + completionTokens,
    cachedTokens: overrides.cachedTokens ?? cacheHitTokens,
    cacheHitTokens,
    cacheMissTokens,
    cacheHitRate: cacheTotal === 0 ? null : cacheHitTokens / cacheTotal,
    turns: overrides.turns ?? 1,
    ...(overrides.costUsd !== undefined ? { costUsd: overrides.costUsd } : {})
  }
}

export async function writeLazyToolExtension(root: string): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'kun-extension.json'), `${JSON.stringify({
    manifestVersion: 1,
    apiVersion: '1.0.0',
    publisher: 'acme',
    name: 'lazy',
    version: '1.0.0',
    engines: { kun: '*' },
    main: 'main.mjs',
    activationEvents: ['onTool:echo'],
    contributes: {
      tools: [{
        id: 'echo',
        description: 'Echo a bounded string.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false
        }
      }]
    },
    permissions: ['tools.register'],
    stateSchemaVersion: 0
  }, null, 2)}\n`)
  await writeFile(join(root, 'README.md'), '# Lazy extension\n')
  await writeFile(join(root, 'LICENSE'), 'MIT\n')
  await writeFile(join(root, 'main.mjs'), `
export async function activate(context) {
  const declaration = {
    id: 'echo',
    description: 'Echo a bounded string.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false
    }
  };
  context.subscriptions.add(await context.tools.registerTool(
    declaration,
    async (input) => ({ content: { echo: input.text } })
  ));
}
export function crash() { process.exit(17); }
`)
}

export async function writeConfigurationExtension(root: string): Promise<void> {
  await writeFile(join(root, 'kun-extension.json'), `${JSON.stringify({
    manifestVersion: 1,
    apiVersion: '1.0.0',
    publisher: 'acme',
    name: 'configuration-scope',
    version: '1.0.0',
    engines: { kun: '*' },
    main: 'main.mjs',
    activationEvents: ['onView:panel'],
    contributes: {
      'views.rightSidebar': [{ id: 'panel', title: 'Panel', entry: 'view.html' }],
      settings: [{
        id: 'workspace',
        title: 'Workspace',
        scope: 'workspace',
        properties: {
          mode: { type: 'string', default: 'default' }
        }
      }, {
        id: 'global',
        title: 'Global',
        scope: 'global',
        properties: {
          enabled: { type: 'boolean', default: false }
        }
      }]
    },
    permissions: ['ui.actions', 'ui.views', 'webview'],
    stateSchemaVersion: 0
  }, null, 2)}\n`)
  await writeFile(join(root, 'README.md'), '# Configuration scope fixture\n')
  await writeFile(join(root, 'LICENSE'), 'MIT\n')
  await writeFile(join(root, 'main.mjs'), 'export async function activate() {}\n')
  await writeFile(join(root, 'view.html'), '<!doctype html><title>Panel</title>\n')
}

export async function writeConfigurationFixtureRunner(root: string): Promise<string> {
  const path = join(root, 'configuration-fixture-runner.mjs')
  await writeFile(path, `
const notifications = [];
function send(message) { if (process.connected) process.send(message); }
function result(id, value) {
  send({ rpcVersion: 1, kind: 'response', id, result: value });
}
process.on('message', (message) => {
  if (message.kind === 'notification') {
    notifications.push({ method: message.method, params: message.params });
    return;
  }
  if (message.kind !== 'request') return;
  if (message.method === 'host.initialize') {
    result(message.id, {
      initialized: true,
      rpcVersion: 1,
      apiVersion: message.params.identity.apiVersion
    });
    return;
  }
  if (message.method === 'host.load') {
    result(message.id, { loaded: true });
    return;
  }
  if (message.method === 'extension.activate') {
    result(message.id, { activated: true });
    return;
  }
  if (message.method === 'extension.invoke') {
    result(message.id, message.params.method === 'notifications' ? notifications : null);
    return;
  }
  if (message.method === 'extension.deactivate') {
    result(message.id, { deactivated: true });
  }
});
process.on('disconnect', () => process.exit(0));
send({ rpcVersion: 1, kind: 'notification', method: 'host.ready', params: { pid: process.pid } });
`)
  return path
}

export async function writeLazyFixtureRunner(root: string): Promise<string> {
  const path = join(root, 'fixture-runner.mjs')
  await writeFile(path, `
const pending = new Map();
let initialization;
function send(message) { if (process.connected) process.send(message); }
function result(id, value) { send({ rpcVersion: 1, kind: 'response', id, result: value }); }
process.on('message', (message) => {
  if (message.kind === 'response') {
    const activationId = pending.get(message.id);
    if (!activationId) return;
    pending.delete(message.id);
    if (message.error) send({ rpcVersion: 1, kind: 'response', id: activationId, error: message.error });
    else result(activationId, { activated: true });
    return;
  }
  if (message.kind !== 'request') return;
  if (message.method === 'host.initialize') {
    initialization = message.params;
    result(message.id, {
      initialized: true,
      rpcVersion: 1,
      apiVersion: initialization.identity.apiVersion
    });
    return;
  }
  if (message.method === 'host.load') { result(message.id, { loaded: true }); return; }
  if (message.method === 'extension.activate') {
    if (initialization.workspaceRoots.length > 0) {
      const workspace = initialization.workspaceContext;
      if (
        !workspace ||
        workspace.root !== initialization.workspaceRoots[0] ||
        workspace.trusted !== true ||
        workspace.active !== true
      ) {
        send({
          rpcVersion: 1,
          kind: 'response',
          id: message.id,
          error: {
            code: 'EXTENSION_WORKSPACE_CONTEXT_MISSING',
            message: 'trusted active workspace context is required'
          }
        });
        return;
      }
    }
    const brokerId = 'broker_' + Math.random().toString(16).slice(2);
    pending.set(brokerId, message.id);
    send({
      rpcVersion: 1,
      kind: 'request',
      id: brokerId,
      method: 'tools.register',
      params: {
        id: 'echo',
        description: 'Echo a bounded string.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false
        }
      }
    });
    return;
  }
  if (message.method === 'extension.deactivate') {
    result(message.id, { deactivated: true });
    return;
  }
  if (message.method === 'extension.invoke') {
    if (message.params.method === 'crash') { process.exit(17); return; }
    if (message.params.method.startsWith('tools.invoke:')) {
      result(message.id, { content: { echo: message.params.params.input.text } });
      return;
    }
    result(message.id, null);
  }
});
process.on('disconnect', () => process.exit(0));
send({ rpcVersion: 1, kind: 'notification', method: 'host.ready', params: { pid: process.pid } });
`)
  return path
}
