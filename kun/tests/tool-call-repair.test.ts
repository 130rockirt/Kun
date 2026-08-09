import { describe, expect, it } from 'vitest'

import {
  isUnresolvedRawToolArgumentsEnvelope,
  MAX_RAW_TOOL_ARGUMENT_ENVELOPE_BYTES,
  normalizeRawToolArgumentsEnvelope,
  projectToolArgumentsForPersistence
} from '../src/domain/tool-argument-envelope.js'
import { repairDispatchToolArguments } from '../src/loop/tool-call-repair.js'

describe('tool call dispatch repair', () => {
  it('flattens common wrapper argument objects', () => {
    const repaired = repairDispatchToolArguments({
      tool_name: 'read',
      arguments: { path: 'src/app.ts' }
    })

    expect(repaired.arguments).toEqual({ path: 'src/app.ts' })
    expect(repaired.notes).toEqual(['flattened arguments wrapper'])
  })

  it('parses fenced JSON from wrapper strings', () => {
    const repaired = repairDispatchToolArguments({
      input: '```json\n{"query":"auth"}\n```'
    })

    expect(repaired.arguments).toEqual({ query: 'auth' })
    expect(repaired.notes).toEqual(['flattened input wrapper'])
  })

  it('scavenges a JSON object from a single string argument', () => {
    const repaired = repairDispatchToolArguments({
      query: 'please use {"path":"README.md"} now'
    })

    expect(repaired.arguments).toEqual({ path: 'README.md' })
    expect(repaired.notes).toEqual(['scavenged JSON object from query'])
  })

  it('unwraps a parseable __raw object with transport metadata', () => {
    const repaired = repairDispatchToolArguments({
      tool_name: 'graph_define_plan',
      __raw: '{"plan":{"title":"Small graph","tasks":[]}}'
    })

    expect(repaired.arguments).toEqual({
      plan: { title: 'Small graph', tasks: [] }
    })
    expect(repaired.notes).toEqual(['flattened __raw wrapper'])
  })

  it('preserves truncated, scalar, array, and conflicting __raw envelopes', () => {
    for (const raw of [
      '{"plan":',
      '[]',
      '42',
      'null',
      '```json\n{"plan":{"title":"fenced"}}\n```',
      'prefix {"plan":{"title":"embedded"}} suffix'
    ]) {
      const repaired = repairDispatchToolArguments({ __raw: raw })
      expect(repaired.arguments).toEqual({ __raw: raw })
      expect(repaired.notes).toEqual([])
    }

    const conflicting = repairDispatchToolArguments({
      __raw: '{"plan":{"title":"wrapped"}}',
      plan: { title: 'explicit' }
    })
    expect(conflicting.arguments).toEqual({
      __raw: '{"plan":{"title":"wrapped"}}',
      plan: { title: 'explicit' }
    })
    expect(conflicting.notes).toEqual([])
  })

  it('preserves oversized raw envelopes without parsing or truncating them', () => {
    const raw = JSON.stringify({
      plan: { title: 'Oversized', description: 'x'.repeat(MAX_RAW_TOOL_ARGUMENT_ENVELOPE_BYTES) }
    })
    const envelope = { __raw: raw, provider_id: 'provider-transport-metadata' }

    const repaired = repairDispatchToolArguments(envelope, { maxStringBytes: 8 })

    expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(MAX_RAW_TOOL_ARGUMENT_ENVELOPE_BYTES)
    expect(repaired).toEqual({ arguments: envelope, notes: [] })
  })

  it('classifies raw transport envelopes without treating business fields as metadata', () => {
    expect(isUnresolvedRawToolArgumentsEnvelope({
      __raw: '{"plan":{}}',
      call_id: 'call_1',
      providerId: 'provider_1'
    })).toBe(true)
    expect(isUnresolvedRawToolArgumentsEnvelope({
      __raw: '{"plan":{}}',
      plan: { title: 'explicit' }
    })).toBe(false)

    for (const key of ['id', 'name', 'type', 'index', 'provider', 'tool']) {
      expect(isUnresolvedRawToolArgumentsEnvelope({
        __raw: '{"plan":{}}',
        [key]: 'business-value'
      })).toBe(false)
    }
  })

  it('replaces unresolved raw payloads with a bounded persistence summary', () => {
    const raw = '{"plan":{"title":"private-persistence-marker"'
    const projected = projectToolArgumentsForPersistence({
      __raw: raw,
      id: 'business-id'
    })

    expect(projected).toMatchObject({
      arguments: { id: 'business-id' },
      rawSummary: expect.stringMatching(
        new RegExp(`^Incomplete tool arguments omitted \\(${Buffer.byteLength(raw, 'utf8')} UTF-8 bytes; sha256 [a-f0-9]{64}\\)\\.$`)
      )
    })
    expect(JSON.stringify(projected)).not.toContain('private-persistence-marker')

    const transportOnly = projectToolArgumentsForPersistence({
      __raw: raw,
      provider_id: 'private-provider-metadata',
      call_id: 'private-call-metadata'
    })
    expect(transportOnly.arguments).toEqual({})
    expect(JSON.stringify(transportOnly)).not.toContain('private-provider-metadata')
    expect(JSON.stringify(transportOnly)).not.toContain('private-call-metadata')
  })

  it('keeps already canonical arguments unchanged across repeated repair', () => {
    const canonical = { plan: { title: 'Canonical', tasks: [] } }
    const once = repairDispatchToolArguments(canonical)
    const twice = repairDispatchToolArguments(once.arguments)

    expect(once).toEqual({ arguments: canonical, notes: [] })
    expect(twice).toEqual({ arguments: canonical, notes: [] })

    const normalized = normalizeRawToolArgumentsEnvelope({
      __raw: JSON.stringify({
        __raw: '{"plan":{"title":"Canonical","tasks":[]}}',
        call_id: 'nested_transport_call'
      })
    })
    expect(normalized).toEqual(canonical)
    expect(normalizeRawToolArgumentsEnvelope(normalized)).toBe(normalized)
  })

  it('truncates very large non-file-change strings without touching file edits', () => {
    const repaired = repairDispatchToolArguments(
      { transcript: 'a'.repeat(32) },
      { maxStringBytes: 8 }
    )
    expect(String(repaired.arguments.transcript)).toContain('[truncated by Kun tool argument repair]')
    expect(repaired.notes).toEqual(['truncated 1 oversized argument string(s)'])

    const preserved = repairDispatchToolArguments(
      { content: 'a'.repeat(32) },
      { toolKind: 'file_change', maxStringBytes: 8 }
    )
    expect(preserved.arguments).toEqual({ content: 'a'.repeat(32) })
    expect(preserved.notes).toEqual([])
  })
})
