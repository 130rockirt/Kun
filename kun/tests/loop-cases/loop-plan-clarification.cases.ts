import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryEventBus } from '../../src/adapters/in-memory-event-bus.js'
import { LocalToolHost, buildDefaultLocalTools } from '../../src/adapters/tool/local-tool-host.js'
import { CapabilityRegistry } from '../../src/adapters/tool/capability-registry.js'
import { buildBrowserUseToolProviders } from '../../src/adapters/tool/browser-use-tool-provider.js'
import { CREATE_PLAN_TOOL_NAME } from '../../src/adapters/tool/create-plan-tool.js'
import { GET_GOAL_TOOL_NAME, UPDATE_GOAL_TOOL_NAME } from '../../src/adapters/tool/goal-tools.js'
import { FileThreadStore, FileSessionStore } from '../../src/adapters/file/index.js'
import { RuntimeEventRecorder } from '../../src/services/runtime-event-recorder.js'
import { ContextCompactor } from '../../src/loop/context-compactor.js'
import { COMPACTION_SYSTEM_PROMPT } from '../../src/loop/compaction-summary.js'
import { effectiveHistoryAfterLatestCompaction } from '../../src/loop/compaction-history.js'
import { resolveModelContextProfile } from '../../src/loop/model-context-profile.js'
import { isPlanClarifyingQuestion } from '../../src/loop/agent-loop.js'
import { LoopTelemetry } from '../../src/loop/loop-telemetry.js'
import {
  makeApprovalItem,
  makeAssistantReasoningItem,
  makeAssistantTextItem,
  makeGoalContextItem,
  makeToolCallItem,
  makeToolResultItem,
  makeUserInputItem,
  makeUserItem
} from '../../src/domain/item.js'
import { createThreadRecord } from '../../src/domain/thread.js'
import { createImmutablePrefix, setSystemPrompt } from '../../src/cache/immutable-prefix.js'
import { InflightTracker } from '../../src/loop/inflight-tracker.js'
import { SteeringQueue } from '../../src/loop/steering-queue.js'
import { SequentialIdGenerator } from '../../src/ports/id-generator.js'
import type { SessionStore } from '../../src/ports/session-store.js'
import { TurnService } from '../../src/services/turn-service.js'
import type { TurnItem } from '../../src/contracts/items.js'
import type { ModelRequest, ModelStreamChunk } from '../../src/ports/model-client.js'
import type { BrowserController } from '../../src/ports/browser-controller.js'
import {
  bootstrapThread,
  makeFakeModel,
  makeHarness,
  makeSilentModel,
  resolveNextUserInput
} from '../loop-test-harness.js'

describe('isPlanClarifyingQuestion', () => {
  it('detects prose that asks the user to choose or supply scope', () => {
    expect(isPlanClarifyingQuestion('Do you want an interactive map or a static page?')).toBe(true)
    // Full-width question mark + Chinese choice cues (哪/还是/你想要).
    expect(isPlanClarifyingQuestion('请确认你想要的是哪一种？还是有其他想法？')).toBe(true)
    // Question on the last line of an option list.
    expect(
      isPlanClarifyingQuestion('Options:\n1. Map\n2. Static page\n3. Globe\nWhich one?')
    ).toBe(true)
    // The "?" need not be the final character (caught within the last lines).
    expect(isPlanClarifyingQuestion('Which one do you want? (please pick)')).toBe(true)
    // Mid-line "#" (a hash route) is not a Markdown heading.
    expect(isPlanClarifyingQuestion('Add a #/world route. Which framework?')).toBe(true)
    expect(isPlanClarifyingQuestion('  Which one do you want?  \n')).toBe(true)
  })

  it('does not pause a real plan, even one ending with a confirmation question', () => {
    // Markdown heading → structured plan.
    expect(isPlanClarifyingQuestion('## Plan\nStep 1: build it.\nReady?')).toBe(false)
    // Heading-less numbered plan ending in a generic confirmation (no choice cue).
    expect(
      isPlanClarifyingQuestion('1. Create index.html\n2. Add CSS\n3. Test it.\nSound good?')
    ).toBe(false)
    // Bold-labelled plan ending in a confirmation question.
    expect(
      isPlanClarifyingQuestion(
        '**Summary**\nBuild the page.\n**Steps**\n1. Do X\nDoes this work for you?'
      )
    ).toBe(false)
    // A question mark with no choice cue is a confirmation, not a clarification.
    expect(isPlanClarifyingQuestion('I built the page. OK to proceed?')).toBe(false)
    // No question at all.
    expect(isPlanClarifyingQuestion('I will implement the world page now.')).toBe(false)
    expect(isPlanClarifyingQuestion('')).toBe(false)
    expect(isPlanClarifyingQuestion('   ')).toBe(false)
  })
})
