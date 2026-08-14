'use strict'

const { mkdir, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const RUNTIME_TOKEN = 'packaged-runtime-data-migration-smoke-token'
const MIGRATED_EXTENSION_ID = 'kun-smoke.migrated'
const MIGRATED_EXTENSION_VERSION = '1.0.0'
const FIXTURE_TIMESTAMP = '2026-07-26T00:00:00.000Z'

function packagedUpgradeSettings(runtimePort, workspaceRoot, legacyDataDir) {
  return {
    version: 1,
    workspaceRoot,
    agents: {
      kun: {
        dataDir: legacyDataDir,
        port: runtimePort,
        runtimeToken: RUNTIME_TOKEN,
        autoStart: true,
        providerId: 'deepseek',
        model: 'deepseek-chat',
        baseUrl: 'https://invalid.example'
      }
    }
  }
}

async function seedThread(dataDir, id, title, workspace) {
  const threadDirectory = join(dataDir, 'threads', id)
  const timestamp = FIXTURE_TIMESTAMP
  const thread = {
    id,
    title,
    workspace,
    model: 'deepseek-chat',
    mode: 'agent',
    status: 'idle',
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    relation: 'primary',
    createdAt: timestamp,
    updatedAt: timestamp,
    turns: []
  }
  await mkdir(threadDirectory, { recursive: true })
  await writeFile(
    join(threadDirectory, 'metadata.jsonl'),
    `${JSON.stringify({
      kind: 'thread_metadata',
      version: 1,
      timestamp,
      thread
    })}\n`
  )
  await writeFile(join(threadDirectory, 'messages.jsonl'), '')
}

function seedLegacyThreadIndex(dataDir, threads) {
  const database = new DatabaseSync(join(dataDir, 'index.sqlite3'))
  try {
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace TEXT NOT NULL,
        model TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        approval_policy TEXT NOT NULL,
        sandbox_mode TEXT NOT NULL,
        cost_budget_usd REAL,
        cost_budget_warning_sent INTEGER,
        relation TEXT NOT NULL,
        parent_thread_id TEXT,
        forked_from_thread_id TEXT,
        forked_from_title TEXT,
        forked_at TEXT,
        forked_from_message_count INTEGER,
        forked_from_turn_count INTEGER,
        goal_json TEXT,
        todos_json TEXT,
        extension_metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        preview TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        event_seq_high_water INTEGER NOT NULL DEFAULT 0,
        metadata_path TEXT NOT NULL,
        messages_path TEXT NOT NULL,
        events_path TEXT NOT NULL,
        search_text TEXT NOT NULL,
        usage_backfilled INTEGER NOT NULL DEFAULT 0
      );
    `)
    const insert = database.prepare(`
      INSERT INTO threads (
        id, title, workspace, model, mode, status, approval_policy, sandbox_mode,
        relation, created_at, updated_at, created_at_ms, updated_at_ms, preview,
        message_count, event_seq_high_water, metadata_path, messages_path,
        events_path, search_text, usage_backfilled
      ) VALUES (
        @id, @title, @workspace, 'deepseek-chat', 'agent', 'idle',
        'on-request', 'workspace-write', 'primary', @createdAt, @updatedAt,
        @createdAtMs, @updatedAtMs, '', 0, 0, @metadataPath, @messagesPath,
        @eventsPath, @searchText, 1
      )
    `)
    for (const thread of threads) {
      const threadDirectory = join(dataDir, 'threads', thread.id)
      insert.run({
        ...thread,
        createdAt: FIXTURE_TIMESTAMP,
        updatedAt: FIXTURE_TIMESTAMP,
        createdAtMs: Date.parse(FIXTURE_TIMESTAMP),
        updatedAtMs: Date.parse(FIXTURE_TIMESTAMP),
        metadataPath: join(threadDirectory, 'metadata.jsonl'),
        messagesPath: join(threadDirectory, 'messages.jsonl'),
        eventsPath: join(threadDirectory, 'events.jsonl'),
        searchText: `${thread.title} ${thread.workspace}`.toLowerCase()
      })
    }
  } finally {
    database.close()
  }
}

async function seedLegacyExtensionRegistry(dataDir) {
  const packagePath = join(
    dataDir,
    'extensions',
    MIGRATED_EXTENSION_ID,
    MIGRATED_EXTENSION_VERSION
  )
  const manifest = {
    publisher: 'kun-smoke',
    name: 'migrated',
    displayName: 'Migrated Extension Fixture',
    version: MIGRATED_EXTENSION_VERSION,
    manifestVersion: 1,
    apiVersion: '1.0.0',
    engines: { kun: '*' },
    main: 'dist/extension.js',
    activationEvents: ['onStartup'],
    contributes: {},
    permissions: [],
    stateSchemaVersion: 0
  }
  const registry = {
    schemaVersion: 1,
    revision: 1,
    updatedAt: FIXTURE_TIMESTAMP,
    extensions: {
      [MIGRATED_EXTENSION_ID]: {
        id: MIGRATED_EXTENSION_ID,
        selectedVersion: MIGRATED_EXTENSION_VERSION,
        globallyEnabled: false,
        workspaceEnablement: {},
        workspacePermissionGrants: {},
        versions: {
          [MIGRATED_EXTENSION_VERSION]: {
            version: MIGRATED_EXTENSION_VERSION,
            packagePath,
            archiveSha256: 'a'.repeat(64),
            integrity: { algorithm: 'sha256', files: {} },
            source: { type: 'local', locator: 'packaged-migration-smoke.kunx' },
            signatureStatus: 'unsigned',
            requestedPermissions: [],
            grantedPermissions: [],
            installedAt: FIXTURE_TIMESTAMP,
            manifest,
            mutable: false
          }
        },
        useDevelopment: false
      }
    }
  }
  await mkdir(join(packagePath, 'dist'), { recursive: true })
  await writeFile(join(packagePath, 'kun-extension.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(packagePath, 'dist', 'extension.js'), 'export async function activate() {}\n')
  const raw = `${JSON.stringify(registry, null, 2)}\n`
  await writeFile(join(dataDir, 'extensions', 'registry.json'), raw)
  return raw
}


module.exports = {
  MIGRATED_EXTENSION_ID,
  MIGRATED_EXTENSION_VERSION,
  RUNTIME_TOKEN,
  packagedUpgradeSettings,
  seedLegacyExtensionRegistry,
  seedLegacyThreadIndex,
  seedThread
}
