import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileAttachmentStore } from '../../src/attachments/attachment-store.js'
import { CompatModelClient } from '../../src/adapters/model/compat-model-client.js'
import {
  KunCapabilitiesConfig,
  type AttachmentsCapabilityConfig,
  type ModelCapabilityMetadata
} from '../../src/contracts/capabilities.js'
import { modelCapabilitiesForModel } from '../../src/loop/model-context-profile.js'
import type { ModelClient, ModelRequest } from '../../src/ports/model-client.js'
import type { LocalTool } from '../../src/adapters/tool/local-tool-host.js'
import { dispatchRequest } from '../../src/server/http-server.js'
import {
  _internal as attachmentRouteInternal,
  MAX_ATTACHMENT_UPLOAD_BODY_BYTES
} from '../../src/server/routes/attachments.js'
import { bootstrapThread, makeHarness } from '../loop-test-harness.js'
import { buildHarness, readJson } from '../http-server-test-harness.js'

export function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24)
  buffer[0] = 0x89
  buffer[1] = 0x50
  buffer[2] = 0x4e
  buffer[3] = 0x47
  buffer[4] = 0x0d
  buffer[5] = 0x0a
  buffer[6] = 0x1a
  buffer[7] = 0x0a
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

export function visionCapabilities(): ModelCapabilityMetadata {
  return {
    id: 'vision-model',
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    supportsToolCalling: true,
    contextWindowTokens: 128_000,
    messageParts: ['text', 'image_url']
  }
}

export function generateImageTool(): LocalTool {
  return {
    name: 'generate_image',
    description: 'Generate or edit an image.',
    inputSchema: {
      type: 'object',
      properties: { reference_attachment_ids: {}, reference_image_paths: {} }
    },
    toolKind: 'tool_call',
    policy: 'auto',
    async execute() {
      return { output: { ok: true } }
    }
  }
}
