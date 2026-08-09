'use strict'

const EXTENSION_ID = 'kun-examples.kun-video-editor'
const EXTENSION_VERSION = '0.4.4'
const CONTRIBUTION_ID = `extension:${EXTENSION_ID}/editor`
const VIDEO_EDITOR_PERMISSIONS = Object.freeze([
  'agent.run',
  'commands.register',
  'jobs.manage',
  'media.export',
  'media.process',
  'media.read',
  'storage.workspace',
  'tools.register',
  'ui.actions',
  'ui.views',
  'webview',
  'workspace.read',
  'workspace.write'
])
const SUCCESS_MARKER = 'Packaged Kun Video Editor desktop E2E OK ('
const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_JOB_TIMEOUT_MS = 120_000
const MAX_CLEANUP_TIMEOUT_MS = 15_000
const MODEL_NAME = 'kun-video-editor-desktop-e2e'


module.exports = {
  CONTRIBUTION_ID,
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  EXTENSION_ID,
  EXTENSION_VERSION,
  MAX_CLEANUP_TIMEOUT_MS,
  MODEL_NAME,
  SUCCESS_MARKER,
  VIDEO_EDITOR_PERMISSIONS
}
