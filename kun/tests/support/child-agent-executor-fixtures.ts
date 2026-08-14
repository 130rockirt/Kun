import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CapabilityRegistry } from '../../src/adapters/tool/capability-registry.js'
import { createDesignCanvasTool } from '../../src/adapters/tool/design-canvas-tool.js'
import { LocalToolHost, buildDefaultLocalTools } from '../../src/adapters/tool/local-tool-host.js'
import { buildSkillToolProviders } from '../../src/adapters/tool/skill-tool-provider.js'
import { InMemoryEventBus } from '../../src/adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../../src/adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../../src/adapters/in-memory-thread-store.js'
import { createImmutablePrefix } from '../../src/cache/immutable-prefix.js'
import { KunCapabilitiesConfig } from '../../src/contracts/capabilities.js'
import { createChildAgentExecutor } from '../../src/delegation/child-agent-executor.js'
import { InstructionRuntime } from '../../src/instructions/instruction-runtime.js'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../../src/ports/model-client.js'
import { RuntimeEventRecorder } from '../../src/services/runtime-event-recorder.js'
import { SkillRuntime } from '../../src/skills/skill-runtime.js'

export function model(chunks: ModelStreamChunk[], seen: ModelRequest[] = []): ModelClient {
  return {
    provider: 'child-test',
    model: 'child-test',
    async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
      seen.push(request)
      for (const chunk of chunks) yield chunk
    }
  }
}
