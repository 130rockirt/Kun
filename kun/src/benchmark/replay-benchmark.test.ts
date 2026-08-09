import { describe, expect, it } from 'vitest'
import type { RuntimeEvent } from '../contracts/events.js'
import {
  compareReplayReports,
  evaluateReplayBudget,
  evaluateReplayQuality,
  formatReplayReportMarkdown,
  replaySuiteDefinitionHash,
  ReplaySuiteSchema,
  runReplaySuite,
  SseMessageDecoder,
  summarizeReplayEvents,
  summarizeReplayRuns,
  type ObservedReplayEvent,
  type ReplayReport,
  type ReplayRunResult
} from './replay-benchmark.js'
import { buildRuntimeCapabilityManifest } from '../contracts/capabilities.js'

const baseTimestamp = Date.parse('2026-06-29T00:00:00.000Z')

function observed(event: RuntimeEvent, elapsedMs: number, delayMs = 10): ObservedReplayEvent {
  return {
    event,
    elapsedMs,
    receivedAtMs: Date.parse(event.timestamp) + delayMs
  }
}

function itemBase(kind: string) {
  return {
    kind,
    id: `item_${kind}`,
    turnId: 'turn_1',
    threadId: 'thread_1',
    role: kind === 'tool_result' ? 'tool' : 'assistant',
    status: 'completed',
    createdAt: '2026-06-29T00:00:00.000Z'
  }
}

describe('replay benchmark', () => {
  it('decodes SSE messages across arbitrary chunks', () => {
    const decoder = new SseMessageDecoder()
    const payload = [
      'id: 4',
      'event: turn_completed',
      `data: ${JSON.stringify({
        kind: 'turn_completed',
        seq: 4,
        timestamp: '2026-06-29T00:00:00.000Z',
        threadId: 'thread_1',
        turnId: 'turn_1',
        status: 'completed'
      })}`,
      '',
      ''
    ].join('\n')

    expect(decoder.push(payload.slice(0, 31))).toEqual([])
    expect(decoder.push(payload.slice(31))).toEqual([
      expect.objectContaining({ id: '4', event: 'turn_completed' })
    ])
  })

  it('computes TTFT, tool, SSE, usage, and memory metrics from runtime events', () => {
    const timestamp = (offset: number) => new Date(baseTimestamp + offset).toISOString()
    const events: ObservedReplayEvent[] = [
      observed({
        kind: 'assistant_text_delta',
        seq: 1,
        timestamp: timestamp(100),
        threadId: 'thread_1',
        turnId: 'turn_1',
        item: { ...itemBase('assistant_text'), kind: 'assistant_text', text: 'hello' }
      } as RuntimeEvent, 120, 20),
      observed({
        kind: 'tool_call_started',
        seq: 2,
        timestamp: timestamp(180),
        threadId: 'thread_1',
        turnId: 'turn_1',
        item: {
          ...itemBase('tool_call'),
          kind: 'tool_call',
          toolName: 'read',
          callId: 'call_1',
          toolKind: 'tool_call',
          arguments: { path: 'README.md' }
        }
      } as RuntimeEvent, 200, 20),
      observed({
        kind: 'tool_call_finished',
        seq: 3,
        timestamp: timestamp(430),
        threadId: 'thread_1',
        turnId: 'turn_1',
        item: {
          ...itemBase('tool_result'),
          kind: 'tool_result',
          toolName: 'read',
          callId: 'call_1',
          toolKind: 'tool_call',
          output: { ok: true },
          isError: false
        }
      } as RuntimeEvent, 450, 20),
      observed({
        kind: 'usage',
        seq: 4,
        timestamp: timestamp(500),
        threadId: 'thread_1',
        turnId: 'turn_1',
        usage: {
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
          cacheHitTokens: 60,
          cacheMissTokens: 40,
          cacheHitRate: 0.6,
          cacheableTokenHitRate: 0.75,
          totalInputTokenHitRate: 0.6,
          turns: 1,
          costUsd: 0.001
        }
      }, 520, 20),
      observed({
        kind: 'turn_completed',
        seq: 5,
        timestamp: timestamp(580),
        threadId: 'thread_1',
        turnId: 'turn_1',
        status: 'completed'
      }, 600, 20)
    ]

    expect(summarizeReplayEvents(events, 600, 256 * 1024 * 1024)).toEqual({
      ttftMs: 120,
      totalMs: 600,
      assistantChars: 5,
      eventCount: 5,
      errorEvents: 0,
      toolCalls: 1,
      toolDurationMs: 250,
      toolDurationP95Ms: 250,
      sseDelayP50Ms: 20,
      sseDelayP95Ms: 20,
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cacheHitTokens: 60,
      cacheMissTokens: 40,
      cacheHitRate: 0.6,
      cacheableTokenHitRate: 0.75,
      totalInputTokenHitRate: 0.6,
      costUsd: 0.001,
      peakRssBytes: 256 * 1024 * 1024
    })
  })

  it('aggregates reports and identifies material regressions', () => {
    const baselineRun = replayRun('passed', 100, 1_000, 0.8)
    const currentRun = replayRun('passed', 200, 1_800, 0.6)
    const baseline = report([baselineRun], '2026-06-28T00:00:00.000Z')
    const current = report([currentRun], '2026-06-29T00:00:00.000Z')
    const comparison = compareReplayReports(current, baseline)

    expect(comparison.ttftP95MsDelta).toBe(100)
    expect(comparison.totalP95MsDelta).toBe(800)
    expect(comparison.cacheHitRateDelta).toBeCloseTo(-0.2)
    expect(comparison.regressions).toEqual(expect.arrayContaining([
      expect.stringContaining('total latency'),
      expect.stringContaining('cache hit rate')
    ]))
  })

  it('uses per-model comparison tolerances without changing global defaults', () => {
    const baseline = report([replayRun('passed', 100, 1_000, 0.8)], '2026-06-28T00:00:00.000Z')
    const current = report([replayRun('passed', 450, 1_900, 0.8)], '2026-06-29T00:00:00.000Z')
    current.runtime.model = 'local-model'

    const comparison = compareReplayReports(current, baseline, {
      allowModelChange: true,
      defaults: {
        maxSuccessRateDrop: 0.2,
        maxCacheHitRateDrop: 0.25
      },
      models: {
        'local-model': {
          maxTtftRelativeIncrease: 5,
          maxTotalRelativeIncrease: 5
        }
      }
    })

    expect(comparison.model).toBe('local-model')
    expect(comparison.policy.maxTtftRelativeIncrease).toBe(5)
    expect(comparison.policy.maxSuccessRateDrop).toBe(0.2)
    expect(comparison.policy.maxCacheHitRateDrop).toBe(0.25)
    expect(comparison.regressions).not.toEqual(expect.arrayContaining([
      expect.stringContaining('TTFT'),
      expect.stringContaining('total latency')
    ]))
  })

  it('applies comparison policies to each effective model in a mixed-model suite', () => {
    const baselineFast = replayRun('passed', 100, 1_000, 0.8)
    Object.assign(baselineFast, { id: 'fast#1', taskId: 'fast', model: 'fast-model' })
    const baselineAccurate = replayRun('passed', 100, 1_000, 0.8)
    Object.assign(baselineAccurate, { id: 'accurate#1', taskId: 'accurate', model: 'accurate-model' })
    const currentFast = replayRun('passed', 450, 1_900, 0.8)
    Object.assign(currentFast, { id: 'fast#1', taskId: 'fast', model: 'fast-model' })
    const currentAccurate = replayRun('passed', 500, 2_000, 0.8)
    Object.assign(currentAccurate, { id: 'accurate#1', taskId: 'accurate', model: 'accurate-model' })

    const baseline = report([baselineFast, baselineAccurate], '2026-06-28T00:00:00.000Z')
    const current = report([currentFast, currentAccurate], '2026-06-29T00:00:00.000Z')
    const comparison = compareReplayReports(current, baseline, {
      models: {
        'fast-model': {
          maxTtftRelativeIncrease: 5,
          maxTotalRelativeIncrease: 5
        }
      }
    })

    expect(comparison.model).toBeUndefined()
    expect(comparison.modelComparisons.map((entry) => entry.model)).toEqual([
      'accurate-model',
      'fast-model'
    ])
    expect(comparison.regressions).toEqual(expect.arrayContaining([
      expect.stringContaining('[model accurate-model] TTFT'),
      expect.stringContaining('[model accurate-model] total latency')
    ]))
    expect(comparison.regressions).not.toEqual(expect.arrayContaining([
      expect.stringContaining('[model fast-model]')
    ]))
  })

  it('supports explicit token and memory regression thresholds', () => {
    const baseline = report([replayRun('passed', 100, 1_000, 0.8)], '2026-06-28T00:00:00.000Z')
    const current = report([replayRun('passed', 100, 1_000, 0.8)], '2026-06-29T00:00:00.000Z')
    baseline.summary.promptTokens = 1_000
    current.summary.promptTokens = 1_500
    baseline.summary.peakRssBytes = 100_000
    current.summary.peakRssBytes = 200_000

    const comparison = compareReplayReports(current, baseline, {
      defaults: {
        maxPromptTokensRelativeIncrease: 0.1,
        maxPromptTokensAbsoluteIncrease: 100,
        maxPeakRssRelativeIncrease: 0.1,
        maxPeakRssAbsoluteIncreaseBytes: 10_000
      }
    })

    expect(comparison.regressions).toEqual(expect.arrayContaining([
      expect.stringContaining('prompt tokens'),
      expect.stringContaining('peak RSS')
    ]))
  })

  it('evaluates process peak RSS only through suite defaults', () => {
    const baseline = report([replayRun('passed', 100, 1_000, 0.8)], '2026-06-28T00:00:00.000Z')
    const current = report([replayRun('passed', 100, 1_000, 0.8)], '2026-06-29T00:00:00.000Z')
    baseline.runtime.model = 'local-model'
    current.runtime.model = 'local-model'
    baseline.summary.peakRssBytes = 100
    current.summary.peakRssBytes = 1_000

    const comparison = compareReplayReports(current, baseline, {
      defaults: { maxPeakRssAbsoluteIncreaseBytes: 100 }
    })

    expect(comparison.regressions).toEqual(expect.arrayContaining([
      expect.stringContaining('peak RSS')
    ]))
    expect(comparison.modelComparisons[0]).not.toHaveProperty('peakRssBytesDelta')
    expect(() => compareReplayReports(current, baseline, {
      models: {
        'local-model': { maxPeakRssAbsoluteIncreaseBytes: 1 }
      }
    })).toThrow()
  })

  it('enforces absolute token and memory thresholds when the baseline is zero', () => {
    const baseline = report([replayRun('passed', 100, 1_000, 0.8)], '2026-06-28T00:00:00.000Z')
    const current = report([replayRun('passed', 100, 1_000, 0.8)], '2026-06-29T00:00:00.000Z')
    baseline.summary.promptTokens = 0
    current.summary.promptTokens = 150
    baseline.summary.peakRssBytes = 0
    current.summary.peakRssBytes = 20_000

    const comparison = compareReplayReports(current, baseline, {
      defaults: {
        maxPromptTokensAbsoluteIncrease: 100,
        maxPeakRssAbsoluteIncreaseBytes: 10_000
      }
    })

    expect(comparison.regressions).toEqual(expect.arrayContaining([
      expect.stringContaining('prompt tokens'),
      expect.stringContaining('peak RSS')
    ]))
  })

  it('treats a positive increase from zero as a relative regression', () => {
    const baseline = report([replayRun('passed', 100, 1_000, 0.8)], '2026-06-28T00:00:00.000Z')
    const current = report([replayRun('passed', 100, 1_000, 0.8)], '2026-06-29T00:00:00.000Z')
    baseline.summary.promptTokens = 0
    current.summary.promptTokens = 10
    baseline.summary.costUsd = 0
    current.summary.costUsd = 0.01

    const comparison = compareReplayReports(current, baseline, {
      defaults: { maxPromptTokensRelativeIncrease: 0 }
    })

    expect(comparison.regressions).toEqual(expect.arrayContaining([
      expect.stringContaining('prompt tokens'),
      expect.stringContaining('cost increased')
    ]))
  })

  it('rejects an incompatible baseline unless model changes are explicit', () => {
    const baseline = report([replayRun('passed', 100, 1_000, 0.8)], '2026-06-28T00:00:00.000Z')
    const current = report([replayRun('passed', 100, 1_000, 0.8)], '2026-06-29T00:00:00.000Z')
    baseline.runtime.model = 'model-a'
    current.runtime.model = 'model-b'

    expect(() => compareReplayReports(current, baseline)).toThrow('runtime model')
    expect(() => compareReplayReports(current, baseline, {
      allowModelChange: true
    })).not.toThrow()

    current.suite.taskCount += 1
    expect(() => compareReplayReports(current, baseline, {
      allowModelChange: true
    })).toThrow('task count')
  })

  it('rejects comparisons recorded with different concurrency', () => {
    const baseline = report([replayRun('passed', 100, 1_000, 0.8)], '2026-06-28T00:00:00.000Z')
    const current = report([replayRun('passed', 100, 1_000, 0.8)], '2026-06-29T00:00:00.000Z')
    baseline.suite.concurrency = 1
    current.suite.concurrency = 2

    expect(() => compareReplayReports(current, baseline)).toThrow('concurrency')
  })

  it('rejects comparisons recorded with different thread retention', () => {
    const baseline = report([replayRun('passed', 100, 1_000, 0.8)], '2026-06-28T00:00:00.000Z')
    const current = report([replayRun('passed', 100, 1_000, 0.8)], '2026-06-29T00:00:00.000Z')
    baseline.suite.keepThreads = false
    current.suite.keepThreads = true

    expect(() => compareReplayReports(current, baseline)).toThrow('thread retention')
  })

  it('rejects reports whose normalized suite definitions differ', () => {
    const baseline = report([replayRun('passed', 100, 1_000, 0.8)], '2026-06-28T00:00:00.000Z')
    const current = report([replayRun('passed', 100, 1_000, 0.8)], '2026-06-29T00:00:00.000Z')
    baseline.suite.definitionHash = 'a'.repeat(64)
    current.suite.definitionHash = 'b'.repeat(64)

    expect(() => compareReplayReports(current, baseline)).toThrow('suite definition')
  })

  it('fingerprints semantic suite inputs while leaving model changes to policy', () => {
    const baseline = ReplaySuiteSchema.parse({
      version: 1,
      name: 'fingerprint',
      defaults: { model: 'model-a', timeoutMs: 1_000 },
      tasks: [{ id: 'task', prompt: 'same prompt', model: 'task-model-a' }]
    })
    const modelChanged = ReplaySuiteSchema.parse({
      version: 1,
      name: 'fingerprint',
      defaults: { model: 'model-b', timeoutMs: 1_000 },
      tasks: [{ id: 'task', prompt: 'same prompt', model: 'task-model-b' }]
    })
    const promptChanged = ReplaySuiteSchema.parse({
      version: 1,
      name: 'fingerprint',
      defaults: { model: 'model-b', timeoutMs: 1_000 },
      tasks: [{ id: 'task', prompt: 'changed prompt', model: 'task-model-b' }]
    })

    expect(replaySuiteDefinitionHash(baseline, baseline.tasks)).toBe(
      replaySuiteDefinitionHash(modelChanged, modelChanged.tasks)
    )
    expect(replaySuiteDefinitionHash(baseline, baseline.tasks)).not.toBe(
      replaySuiteDefinitionHash(promptChanged, promptChanged.tasks)
    )
  })

})

function replayRun(
  status: ReplayRunResult['status'],
  ttftMs: number,
  totalMs: number,
  cacheHitRate: number
): ReplayRunResult {
  return {
    id: 'task#1',
    taskId: 'task',
    iteration: 1,
    tags: [],
    status,
    failureReasons: [],
    metrics: {
      ttftMs,
      totalMs,
      assistantChars: 10,
      eventCount: 5,
      errorEvents: 0,
      toolCalls: 0,
      toolDurationMs: 0,
      toolDurationP95Ms: null,
      sseDelayP50Ms: 10,
      sseDelayP95Ms: 20,
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cacheHitTokens: cacheHitRate * 100,
      cacheMissTokens: (1 - cacheHitRate) * 100,
      cacheHitRate,
      cacheableTokenHitRate: cacheHitRate,
      totalInputTokenHitRate: cacheHitRate,
      costUsd: 0.001,
      peakRssBytes: 100
    }
  }
}

function report(runs: ReplayRunResult[], generatedAt: string): ReplayReport {
  return {
    version: 1,
    generatedAt,
    suite: { name: 'test', taskCount: runs.length, repeat: 1 },
    runtime: { baseUrl: 'http://127.0.0.1', startedAt: generatedAt },
    summary: summarizeReplayRuns(runs),
    runs
  }
}
