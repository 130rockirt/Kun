import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'

const useTraces = vi.hoisted(() => vi.fn())
const runtimeRequest = vi.hoisted(() => vi.fn())
vi.mock('./useModelRequestTraces', () => ({ useModelRequestTraces: useTraces }))

import { AgentPerspectivePanel } from './AgentPerspectivePanel'

function textContent(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : textContent(child)).join('')
}

describe('AgentPerspectivePanel', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    runtimeRequest.mockReset()
    runtimeRequest.mockImplementation(async (_path: string, method?: string, body?: string) => ({
      ok: true,
      status: 200,
      body: JSON.stringify({
        id: 'thread-1',
        modelRequestCaptureEnabled:
          method === 'PATCH'
            ? JSON.parse(body ?? '{}').modelRequestCaptureEnabled === true
            : false
      })
    }))
    vi.stubGlobal('window', { kunGui: { runtimeRequest } })
    useTraces.mockReturnValue({
      records: [{
        schemaVersion: 1,
        id: 'trace-1',
        sequence: 1,
        threadId: 'thread-1',
        turnId: 'turn-1',
        provider: 'deepseek',
        model: 'deepseek-chat',
        endpointFormat: 'openai-chat',
        attempt: 1,
        attemptReason: 'initial',
        status: 'completed',
        startedAt: '2026-07-20T00:00:00.000Z',
        durationMs: 42,
        request: {
          method: 'POST',
          url: 'https://api.deepseek.com/chat/completions',
          urlRedacted: false,
          headers: {
            values: { authorization: '[REDACTED]', 'content-type': 'application/json' },
            redactedNames: ['authorization']
          },
          body: {
            text: JSON.stringify({
              model: 'deepseek-chat',
              messages: [
                { role: 'system', content: 'You are a coding assistant.' },
                { role: 'user', content: 'Inspect this request' }
              ],
              tools: [{
                type: 'function',
                function: {
                  name: 'read_file',
                  description: 'Read a file',
                  parameters: { type: 'object' }
                }
              }, {
                type: 'function',
                function: {
                  name: 'schedule_create',
                  description: 'Create a scheduled task',
                  parameters: { type: 'object', properties: { title: { type: 'string' } } }
                }
              }, {
                type: 'function',
                function: {
                  name: 'slides_export',
                  description: 'Export a slide deck',
                  parameters: { type: 'object' }
                }
              }],
              stream: true
            }),
            capturedBytes: 320,
            originalBytes: 320,
            truncated: false
          }
        },
        toolCatalog: [
          { name: 'read_file', providerKind: 'built-in', providerId: 'builtin' },
          { name: 'schedule_create', providerKind: 'mcp', providerId: 'mcp:gui_schedule' },
          { name: 'slides_export', providerKind: 'extension', providerId: 'extension:slides' }
        ],
        response: {
          status: 200,
          statusText: 'OK',
          headers: { values: { 'content-type': 'text/event-stream' }, redactedNames: [] },
          body: {
            text: 'data: {"choices":[]}\n\n',
            capturedBytes: 22,
            originalBytes: 22,
            truncated: false
          }
        },
        decoded: { text: 'Hello', reasoning: '', toolCalls: [] }
      }],
      selectedId: 'trace-1',
      selected: null,
      activeCount: 0,
      warnings: [],
      loading: false,
      loadingOlder: false,
      error: null,
      select: vi.fn(),
      refresh: vi.fn(),
      loadOlder: vi.fn()
    })
    const state = useTraces.getMockImplementation()?.()
    state.selected = state.records[0]
    useTraces.mockReturnValue(state)
  })

  it('persists the independent conversation capture switch and explains the disabled empty state', async () => {
    const state = useTraces()
    useTraces.mockReturnValue({
      ...state,
      records: [],
      selected: null,
      selectedId: null
    })

    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(AgentPerspectivePanel, {
        threadId: 'thread-1',
        active: true,
        threadRunning: false
      }))
      await Promise.resolve()
    })

    const capture = renderer.root.findByProps({
      role: 'switch',
      'aria-label': 'Capture model requests for this conversation'
    })
    expect(capture.props['aria-checked']).toBe(false)
    expect(textContent(renderer.root)).toContain('Capture is off for this conversation')

    await act(async () => {
      capture.props.onClick()
      await Promise.resolve()
    })

    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thread-1',
      'PATCH',
      JSON.stringify({ modelRequestCaptureEnabled: true })
    )
    expect(renderer.root.findByProps({
      role: 'switch',
      'aria-label': 'Capture model requests for this conversation'
    }).props['aria-checked']).toBe(true)
    const thumb = renderer.root.find((node) =>
      typeof node.props.className === 'string' &&
      node.props.className.includes('rounded-full bg-white')
    )
    expect(thumb.props.className).toContain('left-0')
    expect(thumb.props.className).toContain('translate-x-3.5')
  })

  it('renders the semantic inspector and preserves access to already-redacted raw data', () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement(AgentPerspectivePanel, {
        threadId: 'thread-1',
        active: true,
        threadRunning: false
      }))
    })

    const tabs = renderer.root.findAll((node) => node.props.role === 'tab')
    expect(tabs.map(textContent)).toEqual([
      'Summary', 'Input', 'Output', 'Technical details'
    ])
    expect(tabs[0]?.props['aria-selected']).toBe(true)
    expect(renderer.root.findByProps({ 'aria-label': 'Refresh requests' })).toBeDefined()
    expect(textContent(renderer.root)).toContain('LLM request')

    act(() => tabs[1]?.props.onClick())
    expect(textContent(renderer.root)).toContain('System prompt')
    expect(textContent(renderer.root)).toContain('Tool definitions')
    expect(textContent(renderer.root)).toContain('Inspect this request')
    expect(textContent(renderer.root)).toContain('read_file')

    act(() => tabs[3]?.props.onClick())
    const requestBody = renderer.root.findByProps({ 'aria-label': 'Request body' })
    expect(requestBody.props.value).toContain('"model": "deepseek-chat"')
    const renderedText = textContent(renderer.root)
    expect(renderedText).toContain('authorization')
    expect(renderedText).toContain('[REDACTED]')
    expect(renderedText).not.toContain('sk-secret')
  })

  it('renders Gemini CLI Code Assist requests as semantic sections', () => {
    const state = useTraces()
    const requestBody = JSON.stringify({
      model: 'gemini-3-flash-preview',
      project: 'managed-project',
      request: {
        systemInstruction: {
          role: 'user',
          parts: [{ text: 'Kun Gemini system prompt.' }]
        },
        contents: [{
          role: 'user',
          parts: [
            { text: 'Inspect Gemini semantics' },
            { inlineData: { mimeType: 'image/png', data: 'secret-image-bytes' } }
          ]
        }],
        tools: [{
          functionDeclarations: [{
            name: 'read_file',
            description: 'Read a file',
            parametersJsonSchema: { type: 'object' }
          }]
        }],
        generationConfig: { maxOutputTokens: 256 },
        thoughtSignature: 'secret-signature'
      }
    })
    const record = {
      ...state.records[0],
      provider: 'gemini-cli-subscription',
      model: 'gemini-3-flash-preview',
      endpointFormat: 'gemini-cli-api',
      request: {
        ...state.records[0].request,
        url: 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
        body: {
          text: requestBody,
          capturedBytes: requestBody.length,
          originalBytes: requestBody.length,
          truncated: false
        }
      },
      toolCatalog: [{ name: 'read_file', providerKind: 'built-in', providerId: 'builtin' }]
    }
    useTraces.mockReturnValue({ ...state, records: [record], selected: record })

    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement(AgentPerspectivePanel, {
        threadId: 'thread-1',
        active: true,
        threadRunning: false
      }))
    })

    const tabs = renderer.root.findAll((node) => node.props.role === 'tab')
    act(() => tabs[1]?.props.onClick())
    const rendered = textContent(renderer.root)
    expect(rendered).toContain('Kun Gemini system prompt.')
    expect(rendered).toContain('Inspect Gemini semantics')
    expect(rendered).toContain('[inline data: image/png]')
    expect(rendered).toContain('read_file')
    expect(rendered).toContain('generationConfig')
    expect(rendered).not.toContain('secret-image-bytes')
    expect(rendered).not.toContain('secret-signature')
  })

  it('keeps the inspector interactive and long content keyboard scrollable', () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement(AgentPerspectivePanel, {
        threadId: 'thread-1',
        active: true,
        threadRunning: false
      }))
    })

    const tabs = renderer.root.findAll((node) => node.props.role === 'tab')
    act(() => tabs[1]?.props.onClick())
    const panelRoot = renderer.root.findAllByType('div').find((node) =>
      String(node.props.className).includes('bg-ds-sidebar text-ds-ink')
    )
    expect(panelRoot?.props.className).toContain('ds-no-drag')

    const systemPrompt = renderer.root.findByProps({ 'aria-label': 'System prompt 1' })
    expect(systemPrompt.type).toBe('pre')
    expect(systemPrompt.props.tabIndex).toBe(0)
    expect(systemPrompt.props.className).toContain('overflow-auto')
    expect(systemPrompt.props.className).toContain('focus-visible:ring-1')

    const semanticSections = renderer.root.findAllByType('details')
    const systemSection = semanticSections.find((node) =>
      textContent(node.findByType('summary')).includes('System prompt')
    )
    expect(systemSection?.props.open).toBe(true)
    act(() => systemSection?.props.onToggle({ currentTarget: { open: false } }))
    act(() => renderer.root.findByProps({ 'aria-label': 'Search steps' }).props.onClick())
    const collapsedSystemSection = renderer.root.findAllByType('details').find((node) =>
      textContent(node.findByType('summary')).includes('System prompt')
    )
    expect(collapsedSystemSection?.props.open).toBe(false)

    for (const scrollable of renderer.root.findAllByType('pre')) {
      expect(scrollable.props.tabIndex).toBe(0)
      expect(scrollable.props['aria-label']).toBeTruthy()
    }
  })

  it('groups tool definitions by source with nested, initially bounded disclosure', () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement(AgentPerspectivePanel, {
        threadId: 'thread-1',
        active: true,
        threadRunning: false
      }))
    })

    const tabs = renderer.root.findAll((node) => node.props.role === 'tab')
    act(() => tabs[1]?.props.onClick())
    const kunSummary = renderer.root.findByProps({ 'aria-label': 'Toggle Kun system tools' })
    const mcpSummary = renderer.root.findByProps({ 'aria-label': 'Toggle MCP tools' })
    const extensionSummary = renderer.root.findByProps({ 'aria-label': 'Toggle Extensions tools' })
    expect(kunSummary.parent?.props.open).toBe(true)
    expect(mcpSummary.parent?.props.open).toBe(false)
    expect(extensionSummary.parent?.props.open).toBe(false)

    const coreSummary = renderer.root.findByProps({ 'aria-label': 'Toggle Common core group' })
    expect(coreSummary.parent?.props.open).toBe(true)
    const toolSummary = renderer.root.findByProps({ 'aria-label': 'Toggle read_file details' })
    expect(toolSummary.parent?.props.open).toBe(false)
    const schema = renderer.root.findByProps({ 'aria-label': 'read_file input schema' })
    expect(schema.props.className).toContain('max-h-40')
    expect(schema.props.className).toContain('overflow-auto')
    expect(textContent(renderer.root)).toContain('MCP Server · gui_schedule')
    expect(textContent(renderer.root)).toContain('Kun managed')

    const mainScroller = renderer.root.findAllByType('div').find((node) =>
      String(node.props.className).includes('min-h-0 flex-1 overflow-auto p-3')
    )
    expect(mainScroller).toBeDefined()
  })

  it('reuses exact provenance in the tool-call timeline, hero, and detail', () => {
    const state = useTraces()
    const record = {
      ...state.records[0],
      decoded: {
        text: '',
        reasoning: '',
        toolCalls: [{
          callId: 'call-schedule',
          toolName: 'schedule_create',
          arguments: { title: 'Daily report' }
        }]
      }
    }
    useTraces.mockReturnValue({ ...state, records: [record], selected: record })

    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement(AgentPerspectivePanel, {
        threadId: 'thread-1',
        active: true,
        threadRunning: false
      }))
    })

    const toolRow = renderer.root.findByProps({
      'data-event-id': 'tool:trace-1:call-schedule'
    })
    act(() => toolRow.props.onClick())
    const rendered = textContent(renderer.root)
    expect(rendered).toContain('Tool source')
    expect(rendered).toContain('MCP · gui_schedule')
    expect(rendered).toContain('Kun managed')
    expect(rendered).toContain('call-schedule')
  })

  it('renders newest-first turn groups and an infinite-scroll loading sentinel', () => {
    const state = useTraces()
    const older = {
      ...state.records[0],
      id: 'trace-old',
      sequence: 1,
      turnId: 'turn-old',
      startedAt: '2026-07-20T00:00:00.000Z'
    }
    const newer = {
      ...state.records[0],
      id: 'trace-new',
      sequence: 2,
      turnId: 'turn-new',
      startedAt: '2026-07-20T00:01:00.000Z'
    }
    useTraces.mockReturnValue({
      ...state,
      records: [older, newer],
      selectedId: 'trace-new',
      selected: newer,
      nextCursor: 'older-cursor',
      loadingOlder: true
    })

    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement(AgentPerspectivePanel, {
        threadId: 'thread-1',
        active: true,
        threadRunning: false
      }))
    })

    const groups = renderer.root.findAll((node) => Boolean(node.props['data-round-id']))
    expect(groups.map((node) => node.props['data-round-id'])).toEqual(['turn-new', 'turn-old'])
    expect(textContent(renderer.root)).toContain('Newest first')
    expect(textContent(groups[0]!)).toContain('Latest round')
    expect(textContent(renderer.root)).toContain('Loading earlier rounds…')
    expect(renderer.root.findByProps({
      'data-testid': 'agent-perspective-round-scroller'
    })).toBeDefined()
  })

  it('shows delegated SDK continuity, context ownership, and capability limits', () => {
    const state = useTraces()
    const record = {
      ...state.records[0],
      provider: 'claude-subscription',
      model: 'claude-sonnet-4-5',
      transport: 'sdk',
      endpointFormat: 'agent-sdk',
      request: {
        ...state.records[0].request,
        method: 'SDK',
        url: 'agent-sdk://local/query'
      },
      delegated: {
        providerKind: 'agent-sdk',
        phase: 'rebased',
        reason: 'native_state_unavailable',
        contextManagement: 'sdk-managed',
        nativeHistory: 'none',
        capabilities: {
          nativeResume: true,
          structuredStreaming: true,
          kunTools: true,
          externalApproval: true,
          liveSteering: false,
          nativeContextTelemetry: false,
          fork: false
        }
      }
    }
    useTraces.mockReturnValue({ ...state, records: [record], selected: record })

    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement(AgentPerspectivePanel, {
        threadId: 'thread-1',
        active: true,
        threadRunning: false
      }))
    })

    const rendered = textContent(renderer.root)
    expect(rendered).toContain('SDK execution')
    expect(rendered).toContain('Claude Agent SDK')
    expect(rendered).toContain('Rebased from Kun history')
    expect(rendered).toContain('Native checkpoint unavailable')
    expect(rendered).toContain('No provider-native history')
    expect(rendered).toContain('Native resume')
    expect(rendered).toContain('Live steering')
    expect(renderer.root.findByProps({ 'aria-label': 'SDK execution' })).toBeDefined()
  })
})
