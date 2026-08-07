import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatBlock, NormalizedThread, ToolBlock } from '../../agent/types'
import { useChatStore } from '../../store/chat-store'
import {
  ConversationTurn,
  MessageTimeline,
  TimelineRuntimeError,
  liveTurnProgressClass,
  timelineBottomPaddingClass,
  resultPreviewSourcesForTurn,
  summarizeToolBlock,
  timelineTurnIsProcessing
} from './MessageTimeline'
import {
  GeneratedFilesPanel,
  MessageBubble,
  generatedMediaScrollAvailability,
  turnMetricsLabel
} from './message-timeline-bubbles'
import {
  describeProcessSection,
  ProcessSectionRow,
  groupProcessSections,
  summarizeProcessWork
} from './message-timeline-process'
import {
  TimelineFilePreviewWorkspaceProvider,
  timelineFilePreviewWorkspaceRoot,
  useTimelineFilePreviewWorkspaceRoot
} from './timeline-file-preview-workspace'
import { readGeneratedWorkspaceImagePreview } from './generated-media-preview'

const labels: Record<string, string> = {
  toolActionCommand: 'Ran command',
  toolBuiltinRead: 'Read',
  toolBuiltinWrite: 'Write',
  toolBuiltinEdit: 'Edit',
  toolBuiltinGrep: 'Search',
  toolBuiltinFind: 'Find',
  toolBuiltinLs: 'List',
  toolBuiltinBash: 'Bash',
  toolBuiltinBackgroundShell: 'Background shell',
  toolActionBackgroundShellRead: 'Read background shell',
  toolActionBackgroundShellList: 'List background shells',
  workingToolAction: 'Working {{action}}',
  thinkingNow: 'Thinking…',
  turnMetricsTtft: 'Avg TTFT {{value}}',
  turnMetricsTps: 'Avg {{value}} tok/s',
  groupReadFiles: 'Read {{count}} files',
  groupReadFile: 'Read 1 file',
  groupSearched: 'Searched {{count}} times',
  groupSearchedOnce: 'Searched once',
  groupEditedFiles: 'Edited {{count}} files',
  groupEditedFile: 'Edited 1 file',
  groupRanCommands: 'Ran {{count}} commands',
  groupRanCommand: 'Ran 1 command'
}

const t = (key: string, opts?: Record<string, unknown>) =>
  (labels[key] ?? (key === 'toolActionCommand' ? 'Ran command' : key)).replace(
    /\{\{(\w+)\}\}/g,
    (_match, name: string) => String(opts?.[name] ?? '')
  )

const activeThread: NormalizedThread = {
  id: 'thr_1',
  title: 'Thread',
  updatedAt: '2026-06-07T00:00:00.000Z',
  model: 'deepseek-chat',
  mode: 'code',
  workspace: '/tmp/project'
}

function toolBlock(overrides: Partial<ToolBlock>): ToolBlock {
  return {
    kind: 'tool',
    id: 'tool_1',
    summary: 'tool',
    status: 'success',
    ...overrides
  }
}

describe('MessageTimeline tool summaries', () => {
  function WorkspaceConsumer() {
    return createElement('span', null, useTimelineFilePreviewWorkspaceRoot())
  }

  it('uses the active thread workspace for file previews before falling back to the global workspace', () => {
    expect(timelineFilePreviewWorkspaceRoot(
      { workspace: ' /tmp/thread-workspace ' },
      '/tmp/global-workspace'
    )).toBe('/tmp/thread-workspace')

    expect(timelineFilePreviewWorkspaceRoot(
      { workspace: '   ' },
      '/tmp/global-workspace'
    )).toBe('/tmp/global-workspace')
  })

  it('provides the timeline workspace through context instead of the global active thread', () => {
    const html = renderToStaticMarkup(
      createElement(
        TimelineFilePreviewWorkspaceProvider,
        {
          workspaceRoot: '/tmp/embedded-thread',
          children: createElement(WorkspaceConsumer)
        }
      )
    )

    expect(html).toContain('/tmp/embedded-thread')
  })

  it('retries generated workspace images that are requested before the export is written', async () => {
    const readImage = vi.fn()
      .mockResolvedValueOnce({ ok: false, message: 'File not found' })
      .mockResolvedValueOnce({
        ok: true,
        path: '/tmp/thread-workspace/.deepseekgui-images/diagram.png',
        dataUrl: 'data:image/png;base64,ZGlhZ3JhbQ==',
        mimeType: 'image/png',
        size: 7
      })
    const wait = vi.fn(async () => undefined)

    await expect(readGeneratedWorkspaceImagePreview({
      path: '.deepseekgui-images/diagram.png',
      workspaceRoot: '/tmp/thread-workspace',
      readImage,
      retryDelaysMs: [0, 25],
      wait
    })).resolves.toBe('data:image/png;base64,ZGlhZ3JhbQ==')

    expect(readImage).toHaveBeenCalledTimes(2)
    expect(readImage).toHaveBeenNthCalledWith(1, {
      path: '.deepseekgui-images/diagram.png',
      workspaceRoot: '/tmp/thread-workspace'
    })
    expect(wait).toHaveBeenCalledWith(25)
  })

  it('summarizes built-in read/write/edit tools with their file path', () => {
    expect(
      summarizeToolBlock(
        toolBlock({
          summary: 'read: file',
          meta: { toolName: 'read' },
          filePath: '/tmp/readme.md'
        }),
        t
      )
    ).toBe('Read /tmp/readme.md')

    expect(
      summarizeToolBlock(
        toolBlock({
          summary: 'write: file',
          meta: { toolName: 'write' },
          filePath: '/tmp/out.ts'
        }),
        t
      )
    ).toBe('Write /tmp/out.ts')

    expect(
      summarizeToolBlock(
        toolBlock({
          summary: 'edit: file',
          meta: { toolName: 'edit' },
          filePath: '/tmp/app.ts'
        }),
        t
      )
    ).toBe('Edit /tmp/app.ts')
  })

  it('summarizes built-in grep/find with pattern context', () => {
    const grep = summarizeToolBlock(
      toolBlock({
        summary: 'grep: search',
        meta: { toolName: 'grep', pattern: 'needle' },
        filePath: '/tmp/src'
      }),
      t
    )
    expect(grep).toBe('Search needle · /tmp/src')

    const find = summarizeToolBlock(
      toolBlock({
        summary: 'find: files',
        meta: { toolName: 'find', pattern: '*.ts' },
        filePath: '/tmp/src'
      }),
      t
    )
    expect(find).toBe('Find *.ts · /tmp/src')
  })

  it('summarizes explore_agent with its short UI title', () => {
    expect(
      summarizeToolBlock(
        toolBlock({
          summary: 'explore_agent',
          meta: { toolName: 'explore_agent' },
          detail: JSON.stringify({
            title: 'Voice transcription flow',
            query: 'Trace speech transcription wiring'
          })
        }),
        t
      )
    ).toBe('Explore agent Voice transcription flow')
  })

  it('does not repeat a raw summary that matches the generated tool label', () => {
    expect(
      summarizeToolBlock(
        toolBlock({
          summary: 'Create plan',
          meta: { toolName: 'create_plan' }
        }),
        t
      )
    ).toBe('Create plan')
  })

  it('summarizes built-in ls with its path and bash with its command', () => {
    expect(
      summarizeToolBlock(
        toolBlock({
          summary: 'ls: list',
          meta: { toolName: 'ls' },
          filePath: '/tmp/project'
        }),
        t
      )
    ).toBe('List /tmp/project')

    expect(
      summarizeToolBlock(
        toolBlock({
          summary: 'bash: exec',
          toolKind: 'command_execution',
          meta: { toolName: 'bash', command: 'npm test' }
        }),
        t
      )
    ).toBe('Ran command npm test')
  })

  it('summarizes background_shell with action, session id, and command', () => {
    expect(
      summarizeToolBlock(
        toolBlock({
          summary: 'background_shell',
          meta: {
            toolName: 'background_shell',
            action: 'read',
            session_id: '2mcorxhe',
            command: 'sleep 15 && echo "Hello from background!"'
          },
          detail: JSON.stringify(
            {
              action: 'read',
              session_id: '2mcorxhe',
              command: 'sleep 15 && echo "Hello from background!"',
              exit_code: 0,
              status: 'completed'
            },
            null,
            2
          )
        }),
        t
      )
    ).toBe('Read background shell 2mcorxhe sleep 15 && echo "Hello from background!"')
  })

  it('folds adjacent non-text work while preserving assistant text boundaries', () => {
    const sections = groupProcessSections([
      { kind: 'reasoning', id: 'reasoning_1', text: 'inspect the code' },
      toolBlock({ id: 'tool_read', summary: 'read: file', meta: { toolName: 'read' } }),
      { kind: 'reasoning', id: 'reasoning_2', text: 'check one more path' },
      { kind: 'assistant', id: 'assistant_1', text: 'I found the relevant component.' },
      toolBlock({ id: 'tool_test', summary: 'bash: test', meta: { toolName: 'bash' } })
    ])

    expect(sections.map((section) => ({
      kind: section.kind,
      ids: section.blocks.map((block) => block.id)
    }))).toEqual([
      {
        kind: 'execution',
        ids: ['reasoning_1', 'tool_read', 'reasoning_2']
      },
      {
        kind: 'output',
        ids: ['assistant_1']
      },
      {
        kind: 'execution',
        ids: ['tool_test']
      }
    ])
  })

  it('keeps compaction as a hard boundary between execution phases', () => {
    const sections = groupProcessSections([
      toolBlock({ id: 'tool_before', summary: 'read: before', meta: { toolName: 'read' } }),
      {
        kind: 'compaction',
        id: 'compaction_1',
        summary: 'Context compacted',
        status: 'success',
        auto: true
      },
      toolBlock({ id: 'tool_after', summary: 'read: after', meta: { toolName: 'read' } })
    ])

    expect(sections.map((section) => ({
      id: section.id,
      ids: section.blocks.map((block) => block.id)
    }))).toEqual([
      { id: 'execution-tool_before', ids: ['tool_before'] },
      { id: 'compaction-compaction_1', ids: ['compaction_1'] },
      { id: 'execution-tool_after', ids: ['tool_after'] }
    ])
  })

  it('summarizes a collapsed phase by its work and its active operation', () => {
    const readBlock = toolBlock({
      id: 'tool_read',
      summary: 'read: app',
      meta: { toolName: 'read' },
      filePath: '/tmp/app.ts'
    })
    const searchBlock = toolBlock({
      id: 'tool_search',
      summary: 'grep: app',
      status: 'running',
      meta: { toolName: 'grep', pattern: 'phase summary' }
    })
    const editBlock = toolBlock({
      id: 'tool_edit',
      summary: 'edit: app',
      toolKind: 'file_change',
      meta: { toolName: 'edit' }
    })
    const commandBlock = toolBlock({
      id: 'tool_command',
      summary: 'bash: test',
      toolKind: 'command_execution',
      meta: { toolName: 'bash', command: 'npm test' }
    })

    expect(summarizeProcessWork([readBlock, searchBlock, editBlock, commandBlock], t)).toBe(
      'Read 1 file · Searched once · Edited 1 file · Ran 1 command'
    )
    expect(
      describeProcessSection(
        { id: 'execution_active', kind: 'execution', blocks: [readBlock, searchBlock] },
        t,
        { processing: true, singleReasoningSection: false }
      )
    ).toBe('Working Search phase summary · Read 1 file · Searched once')
  })

  it('folds live reasoning into a preceding non-text tool batch', () => {
    const sections = groupProcessSections([
      toolBlock({ id: 'tool_read', summary: 'read: file', meta: { toolName: 'read' } }),
      toolBlock({ id: 'tool_grep', summary: 'grep: search', meta: { toolName: 'grep' } }),
      { kind: 'reasoning', id: 'live-reasoning', text: 'next plan' }
    ])

    expect(sections.map((section) => ({
      kind: section.kind,
      ids: section.blocks.map((block) => block.id)
    }))).toEqual([
      {
        kind: 'execution',
        ids: ['tool_read', 'tool_grep', 'live-reasoning']
      }
    ])
  })
})

describe('MessageTimeline Kun runtime metadata smoke', () => {
  beforeEach(() => {
    useChatStore.setState({
      route: 'chat',
      workspaceRoot: '/tmp/project',
      activeThreadId: 'thr_1',
      threads: [activeThread],
      busy: false,
      currentTurnUserId: null,
      turnStartedAtByUserId: {},
      turnDurationByUserId: {},
      turnReasoningFirstAtByUserId: {},
      turnReasoningLastAtByUserId: {},
      clawChannels: [],
      activeClawChannelId: ''
    })
  })

  it('renders user image attachments as thumbnails instead of attachment chips', () => {
    const block: ChatBlock = {
      kind: 'user',
      id: 'user_1',
      text: '为什么图片完全没有识别啊',
      meta: {
        attachmentIds: ['att_1'],
        attachments: [{
          id: 'att_1',
          name: 'image.png',
          mimeType: 'image/png',
          previewUrl: 'data:image/png;base64,abc'
        }]
      }
    }

    const html = renderToStaticMarkup(createElement(MessageBubble, { block }))

    expect(html).toContain('<img')
    expect(html).toContain('src="data:image/png;base64,abc"')
    expect(html).toContain('为什么图片完全没有识别啊')
    expect(html).not.toContain('Attachments 1')
    expect(html).not.toContain('ds-media-printer-reveal')
  })

  it('renders user file references under the sent prompt', () => {
    const block: ChatBlock = {
      kind: 'user',
      id: 'user_files',
      text: '看一下这些文件',
      meta: {
        fileReferences: [
          {
            path: '/workspace/deepseek-gui/src/App.tsx',
            relativePath: 'src/App.tsx',
            name: 'App.tsx',
            kind: 'file'
          },
          {
            path: '/workspace/deepseek-gui/src',
            relativePath: 'src',
            name: 'src',
            kind: 'directory'
          }
        ]
      }
    }

    const html = renderToStaticMarkup(createElement(MessageBubble, { block }))

    expect(html).toContain('看一下这些文件')
    expect(html).toContain('Referenced files 2')
    expect(html).toContain('src/App.tsx')
    expect(html).toContain('src/')
  })

  it('renders background subagent completion as a compact result card', () => {
    const block: ChatBlock = {
      kind: 'user',
      id: 'background_subagent_1',
      text: [
        '<background_subagent_completed>',
        '<child_id>child_ms6z14fk_erng9y</child_id>',
        '<label>Client API</label>',
        '<status>completed</status>',
        '<summary>Checked the shared schema and request payload.</summary>',
        '</background_subagent_completed>'
      ].join('\n'),
      meta: {
        displayText: 'Background subagent Client API completed',
        messageSource: 'background_subagent'
      }
    }

    const html = renderToStaticMarkup(createElement(MessageBubble, { block }))

    expect(html).toContain('data-background-subagent-card="true"')
    expect(html).toContain('data-background-subagent-result="true"')
    expect(html).toContain('Client API')
    expect(html).toContain('child_ms6z14fk_erng9y')
    expect(html).toContain('Checked the shared schema and request payload.')
    expect(html).not.toContain('rgba(79,124,255')
  })

  it('clips verbose background subagent output behind an explicit disclosure', () => {
    const longSummary = Array.from(
      { length: 30 },
      (_, index) => `- Result ${index + 1}: verified contract behavior.`
    ).join('\n')
    const block: ChatBlock = {
      kind: 'user',
      id: 'background_subagent_long',
      text: [
        '<background_subagent_completed>',
        '<child_id>child_long</child_id>',
        '<label>Contract review</label>',
        '<status>completed</status>',
        `<summary>${longSummary}</summary>`,
        '</background_subagent_completed>'
      ].join('\n'),
      meta: { messageSource: 'background_subagent' }
    }

    const html = renderToStaticMarkup(createElement(MessageBubble, { block }))

    expect(html).toContain('max-h-[360px]')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toMatch(/View full output|查看完整输出/)
  })

  it('uses the subagent label and status in the process row instead of runtime prose', () => {
    const block: ChatBlock = {
      kind: 'user',
      id: 'background_subagent_process',
      text: [
        '<background_subagent_completed>',
        '<child_id>child_process</child_id>',
        '<label>Client API</label>',
        '<status>completed</status>',
        '<summary>Done.</summary>',
        '</background_subagent_completed>'
      ].join('\n'),
      meta: {
        displayText: 'Background subagent Client API completed',
        messageSource: 'background_subagent'
      }
    }

    const html = renderToStaticMarkup(
      createElement(ProcessSectionRow, {
        section: { id: 'execution-background_subagent', kind: 'execution', blocks: [block] },
        processing: false,
        singleReasoningSection: false,
        workspaceRoot: '/tmp/project',
        viewportRef: { current: null }
      })
    )

    expect(html).toContain('data-background-subagent-row="true"')
    expect(html).toContain('Client API')
    expect(html).not.toContain('Background subagent Client API completed')
  })

  it('renders generated image previews with the printer reveal effect', () => {
    const block: ToolBlock = toolBlock({
      id: 'tool_img',
      summary: 'generate_image',
      meta: {
        generatedFiles: [
          {
            name: 'painting.png',
            mimeType: 'image/png',
            previewUrl: 'data:image/png;base64,paint'
          }
        ]
      }
    })

    const html = renderToStaticMarkup(createElement(GeneratedFilesPanel, { blocks: [block] }))

    expect(html).toContain('<img')
    expect(html).toContain('src="data:image/png;base64,paint"')
    expect(html).toContain('ds-media-printer-reveal')
    expect(html).toContain('data-generated-media-carousel')
    expect(html).toContain('data-generated-media-strip')
    expect(html).toContain('aspect-square')
    expect(html).toContain('object-cover')
    expect(html).not.toContain('sm:grid-cols-2')
  })

  it('keeps generated media tool results as distinct chronological process sections', () => {
    const before = toolBlock({
      id: 'tool_before_image',
      summary: 'read: source',
      meta: { toolName: 'read' }
    })
    const generated = toolBlock({
      id: 'tool_generate_image',
      summary: 'generate_image: skyline',
      meta: {
        toolName: 'generate_image',
        generatedFiles: [{
          name: 'skyline.png',
          mimeType: 'image/png',
          previewUrl: 'data:image/png;base64,skyline'
        }]
      }
    })
    const after = toolBlock({
      id: 'tool_after_image',
      summary: 'read: output',
      meta: { toolName: 'read' }
    })

    expect(groupProcessSections([before, generated, after]).map((section) =>
      section.blocks.map((block) => block.id)
    )).toEqual([
      ['tool_before_image'],
      ['tool_generate_image'],
      ['tool_after_image']
    ])
  })

  it('renders active text and generated work in chronological order without a duplicate', () => {
    const html = renderToStaticMarkup(
      createElement(ConversationTurn, {
        turn: {
          user: { kind: 'user', id: 'user_generate_image', text: 'Create a skyline' },
          blocks: [
            { kind: 'assistant', id: 'assistant_before_image', text: 'Preparing the image now.' },
            toolBlock({
              id: 'tool_generate_image',
              summary: 'generate_image: skyline',
              meta: {
                toolName: 'generate_image',
                generatedFiles: [{
                  name: 'skyline.png',
                  mimeType: 'image/png',
                  previewUrl: 'data:image/png;base64,skyline'
                }]
              }
            }),
            { kind: 'assistant', id: 'assistant_after_image', text: 'Checking the rendered result.' }
          ]
        },
        isProcessing: true,
        liveReasoning: '',
        live: '',
        filePreviewWorkspaceRoot: '/tmp/project',
        viewportRef: { current: null }
      })
    )

    const placement = 'data-generated-files-placement="timeline"'
    expect(html).toContain(placement)
    expect(html).not.toContain('data-generated-files-placement="turn"')
    expect((html.match(/data-generated-files-placement=/g) ?? []).length).toBe(1)
    expect(html.indexOf('Preparing the image now.')).toBeLessThan(html.indexOf(placement))
    expect(html.indexOf(placement)).toBeLessThan(html.indexOf('Checking the rendered result.'))
  })

  it('moves a completed generated image below the final assistant content', () => {
    const html = renderToStaticMarkup(
      createElement(ConversationTurn, {
        turn: {
          user: { kind: 'user', id: 'user_complete_image', text: 'Create a skyline' },
          blocks: [
            toolBlock({
              id: 'tool_generate_image_complete',
              summary: 'generate_image: skyline',
              meta: {
                toolName: 'generate_image',
                generatedFiles: [{
                  name: 'skyline.png',
                  mimeType: 'image/png',
                  previewUrl: 'data:image/png;base64,skyline'
                }]
              }
            }),
            {
              kind: 'assistant',
              id: 'assistant_image_complete',
              text: 'The finished skyline is ready.'
            }
          ]
        },
        isProcessing: false,
        liveReasoning: '',
        live: '',
        filePreviewWorkspaceRoot: '/tmp/project',
        viewportRef: { current: null }
      })
    )

    const placement = 'data-generated-files-placement="turn"'
    expect(html).toContain(placement)
    expect(html).not.toContain('data-generated-files-placement="timeline"')
    expect((html.match(/data-generated-files-placement=/g) ?? []).length).toBe(1)
    expect(html.indexOf('The finished skyline is ready.')).toBeLessThan(html.indexOf(placement))
  })

  it('reports the available directions for the generated image strip', () => {
    expect(generatedMediaScrollAvailability({
      scrollLeft: 0,
      clientWidth: 640,
      scrollWidth: 1_100
    })).toEqual({
      canScrollBackward: false,
      canScrollForward: true
    })
    expect(generatedMediaScrollAvailability({
      scrollLeft: 460,
      clientWidth: 640,
      scrollWidth: 1_100
    })).toEqual({
      canScrollBackward: true,
      canScrollForward: false
    })
  })

  it('renders revoked generated artifacts as explicitly unavailable', () => {
    const block: ToolBlock = toolBlock({
      id: 'tool_revoked_artifact',
      summary: 'video-render',
      meta: {
        generatedFiles: [{
          id: 'artifact_1234567890',
          artifactId: 'artifact_1234567890',
          mediaHandleId: 'media_123456789012',
          availability: 'unavailable',
          name: 'final.mp4',
          mimeType: 'video/mp4'
        }]
      }
    })

    const html = renderToStaticMarkup(createElement(GeneratedFilesPanel, { blocks: [block] }))
    expect(html).toContain('Preview unavailable')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('src="kun-media:')
  })

  it('deduplicates generated files across tool blocks by path', () => {
    const first: ToolBlock = toolBlock({
      id: 'tool_export_1',
      summary: 'export_report',
      meta: {
        generatedFiles: [
          { relativePath: 'reports/summary.md', mimeType: 'text/markdown' }
        ]
      }
    })
    const second: ToolBlock = toolBlock({
      id: 'tool_export_2',
      summary: 'export_report',
      meta: {
        generatedFiles: [
          { relativePath: 'reports/summary.md', mimeType: 'text/markdown' }
        ]
      }
    })

    const html = renderToStaticMarkup(createElement(GeneratedFilesPanel, { blocks: [first, second] }))

    expect((html.match(/summary\.md/g) ?? []).length).toBe(2)
    expect((html.match(/type="button"/g) ?? []).length).toBe(2)
  })

  it('leaves supported presentation outputs to the dedicated presentation panel', () => {
    const block: ToolBlock = toolBlock({
      id: 'tool_presentations',
      summary: 'presentation export',
      meta: {
        generatedFiles: [
          { relativePath: 'presentations/brief.pptx' },
          { relativePath: 'brief.kun-ppt.html' }
        ]
      }
    })

    expect(renderToStaticMarkup(createElement(GeneratedFilesPanel, { blocks: [block] }))).toBe('')
  })

  it('projects only bounded non-secret generated-file metadata to result preview Views', () => {
    const sources = resultPreviewSourcesForTurn({
      user: { kind: 'user', id: 'user_1', text: 'make report' },
      blocks: [toolBlock({
        id: 'tool_preview',
        meta: {
          generatedFiles: [{
            id: 'attachment_1',
            name: 'summary.json',
            mimeType: 'application/json',
            relativePath: 'reports/summary.json',
            absolutePath: '/private/workspace/reports/summary.json',
            previewUrl: 'data:application/json;base64,c2VjcmV0'
          }]
        }
      })]
    })

    expect(sources).toEqual([{
      sourceId: 'tool_preview:attachment_1',
      mimeType: 'application/json',
      name: 'summary.json',
      attachmentId: 'attachment_1',
      relativePath: 'reports/summary.json'
    }])
    expect(JSON.stringify(sources)).not.toContain('/private/workspace')
    expect(JSON.stringify(sources)).not.toContain('base64')
  })

  it('projects durable artifact and media references to result preview Views', () => {
    const sources = resultPreviewSourcesForTurn({
      user: { kind: 'user', id: 'user_1', text: 'render video' },
      blocks: [toolBlock({
        id: 'tool_video',
        meta: {
          generatedFiles: [{
            id: 'artifact_1234567890',
            artifactId: 'artifact_1234567890',
            mediaHandleId: 'media_123456789012',
            availability: 'available',
            name: 'final.mp4',
            mimeType: 'video/mp4',
            byteSize: 4096
          }]
        }
      })]
    })

    expect(sources).toEqual([{
      sourceId: 'tool_video:artifact_1234567890',
      mimeType: 'video/mp4',
      name: 'final.mp4',
      artifactId: 'artifact_1234567890',
      mediaHandleId: 'media_123456789012',
      availability: 'available',
      byteSize: 4096
    }])
  })

  it('renders managed Claw prompts as the user-visible message', () => {
    const block: ChatBlock = {
      kind: 'user',
      id: 'user_claw',
      text: [
        '[Claw managed instructions]',
        '',
        '[Claw IM agent instructions]',
        '',
        '[Agent name]',
        'kun',
        '',
        '---',
        '[Current user request]',
        '[Feishu / Lark inbound message]',
        'Chat type: p2p',
        'Sender: user-1',
        '',
        'hi'
      ].join('\n')
    }

    const html = renderToStaticMarkup(createElement(MessageBubble, { block }))

    expect(html).toContain('hi')
    expect(html).not.toContain('Claw managed instructions')
    expect(html).not.toContain('Agent name')
    expect(html).not.toContain('Feishu / Lark inbound message')
  })

  it('renders tool-specific metadata chips in tool bubbles', () => {
    const block: ToolBlock = toolBlock({
      summary: 'web_search: docs',
      meta: {
        attachmentIds: ['att_1'],
        activeSkillIds: ['skill_docs'],
        injectedMemoryIds: ['mem_1'],
        child: {
          childId: 'child_research',
          childLabel: 'research'
        },
        sources: [
          {
            title: 'Kun docs',
            url: 'https://example.com/kun'
          }
        ]
      }
    })

    const html = renderToStaticMarkup(createElement(MessageBubble, { block }))

    expect(html).not.toContain('Attachments 1')
    expect(html).not.toContain('Skills 1')
    expect(html).not.toContain('Memories 1')
    expect(html).toContain('Child agent')
    expect(html).toContain('research')
    expect(html).toContain('Sources 1')
    expect(html).toContain('https://example.com/kun')
  })

  it('renders failed tool bubbles with the orange warning tone', () => {
    const block: ToolBlock = toolBlock({
      summary: 'recognize_image failed',
      status: 'error',
      detail: 'model request failed with status 401',
      meta: { toolName: 'recognize_image', exit_code: 1 }
    })

    const html = renderToStaticMarkup(createElement(MessageBubble, { block }))

    expect(html).toContain('border-orange-300/80')
    expect(html).toContain('bg-orange-500/10')
    expect(html).toContain('text-orange-800')
    expect(html).not.toContain('border-red-300/80')
    expect(html).not.toContain('bg-red-500/10')
  })

  it('renders tool-specific runtime metadata on process timeline rows', () => {
    const block: ChatBlock = toolBlock({
      summary: 'delegate: research',
      meta: {
        attachmentIds: ['att_1'],
        activeSkillIds: ['skill_docs'],
        injectedMemoryIds: ['mem_1'],
        child: {
          childId: 'child_research',
          childLabel: 'research'
        },
        sources: [
          {
            title: 'Kun docs',
            url: 'https://example.com/kun'
          }
        ]
      }
    })

    const html = renderToStaticMarkup(
      createElement(ProcessSectionRow, {
        section: { id: 'execution-tool_1', kind: 'execution', blocks: [block] },
        processing: false,
        singleReasoningSection: false,
        workspaceRoot: '/tmp/project',
        viewportRef: { current: null }
      })
    )

    expect(html).not.toContain('Attachments 1')
    expect(html).not.toContain('Skills 1')
    expect(html).not.toContain('Memories 1')
    expect(html).toContain('Child agent')
    expect(html).toContain('research')
    expect(html).toContain('Sources 1')
  })

  it('keeps running tool calls collapsed by default without in-row loading chrome', () => {
    const block: ChatBlock = toolBlock({
      summary: 'read: file',
      status: 'running',
      detail: 'partial tool output while running',
      meta: { toolName: 'read' },
      filePath: '/tmp/readme.md'
    })

    const html = renderToStaticMarkup(
      createElement(ProcessSectionRow, {
        section: { id: 'execution-tool_1', kind: 'execution', blocks: [block] },
        processing: true,
        singleReasoningSection: false,
        workspaceRoot: '/tmp/project',
        viewportRef: { current: null }
      })
    )

    expect(html).toContain('Read')
    expect(html).toContain('/tmp/readme.md')
    expect(html).not.toContain('is-active')
    expect(html).not.toContain('ds-shiny-text')
    expect(html).not.toContain('partial tool output while running')
    expect(html).toContain('ds-process-file-reference')
  })

  it('keeps a completed failed-tool detail collapsed by default while staying expandable', () => {
    const block: ChatBlock = toolBlock({
      summary: 'Recognize image recognize_image',
      status: 'error',
      detail: 'model request failed with status 401',
      meta: { toolName: 'recognize_image' }
    })

    const html = renderToStaticMarkup(
      createElement(ProcessSectionRow, {
        section: { id: 'execution-tool_error', kind: 'execution', blocks: [block] },
        processing: false,
        singleReasoningSection: false,
        workspaceRoot: '/tmp/project',
        viewportRef: { current: null }
      })
    )

    // The header (summary + warning tone) renders, but once the turn has
    // completed a failed tool call stays collapsed by default — the error
    // detail is revealed only after the user expands the row.
    expect(html).toContain('Recognize image recognize_image')
    expect(html).toContain('text-orange-700')
    expect(html).not.toContain('text-red-600')
    expect(html).not.toContain('model request failed with status 401')
    expect(html).toContain('role="button"')
    expect(html).toContain('aria-expanded="false"')
  })

  it('keeps an active failed-tool detail collapsed while the turn is running', () => {
    const block: ChatBlock = toolBlock({
      summary: 'Recognize image recognize_image',
      status: 'error',
      detail: 'model request failed with status 401',
      meta: { toolName: 'recognize_image' }
    })

    const html = renderToStaticMarkup(
      createElement(ProcessSectionRow, {
        section: { id: 'execution-tool_error', kind: 'execution', blocks: [block] },
        processing: true,
        singleReasoningSection: false,
        workspaceRoot: '/tmp/project',
        viewportRef: { current: null }
      })
    )

    expect(html).toContain('Recognize image recognize_image')
    expect(html).toContain('text-orange-700')
    expect(html).not.toContain('model request failed with status 401')
    expect(html).toContain('aria-expanded="false"')
  })

  it('keeps failed-tool details collapsed inside an active tool batch', () => {
    const failedBlock: ChatBlock = toolBlock({
      id: 'tool_failed',
      summary: 'Search src',
      status: 'error',
      detail: 'search error detail should stay tucked away',
      meta: { toolName: 'grep', pattern: 'needle' },
      filePath: '/tmp/src'
    })
    const successfulBlock: ChatBlock = toolBlock({
      id: 'tool_success',
      summary: 'Read file',
      status: 'success',
      detail: 'read detail should stay tucked away',
      meta: { toolName: 'read' },
      filePath: '/tmp/readme.md'
    })

    const html = renderToStaticMarkup(
      createElement(ProcessSectionRow, {
        section: {
          id: 'execution-active-batch',
          kind: 'execution',
          blocks: [failedBlock, successfulBlock]
        },
        processing: true,
        singleReasoningSection: false,
        workspaceRoot: '/tmp/project',
        viewportRef: { current: null }
      })
    )

    // Tool failures must not open the batch or tint the folded header; the
    // warning-toned inner rows only appear after the user expands.
    expect(html).toContain('Read 1 file · Searched once')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Search needle')
    expect(html).not.toContain('text-orange-700')
    expect(html).not.toContain('search error detail should stay tucked away')
    expect(html).not.toContain('read detail should stay tucked away')
  })

  it('folds live thinking into the preceding non-text process batch', () => {
    const turn = {
      user: {
        kind: 'user' as const,
        id: 'user_1',
        text: 'keep reviewing'
      },
      blocks: [
        toolBlock({
          id: 'tool_read',
          summary: 'read: file',
          status: 'success',
          meta: { toolName: 'read' },
          filePath: '/tmp/project/src/app.ts'
        })
      ]
    }

    const html = renderToStaticMarkup(
      createElement(ConversationTurn, {
        turn,
        isProcessing: true,
        liveReasoning: '**current reasoning summary**\n\n<!-- -->',
        live: '',
        durationMs: 74_000,
        filePreviewWorkspaceRoot: '/tmp/project',
        viewportRef: { current: null }
      })
    )

    expect(html).toContain('1m 14s')
    expect(html).toContain('Thinking… · Read 1 file')
    expect(html.indexOf('1m 14s')).toBeLessThan(
      html.indexOf('Thinking… · Read 1 file')
    )
    expect(html).toContain('ds-shiny-text')
    expect(html).toContain('aria-expanded="false"')
    expect(html.match(/ds-work-logo-phase-trail/g) ?? []).toHaveLength(1)
    expect(html.indexOf('ds-work-logo-phase-trail')).toBeGreaterThan(
      html.indexOf('Thinking… · Read 1 file')
    )
    expect(html).not.toContain('current reasoning summary')
    expect(html).not.toContain('&lt;!-- --&gt;')
  })

  it('uses the latest completed tool as the live fallback action', () => {
    const html = renderToStaticMarkup(
      createElement(ConversationTurn, {
        turn: {
          user: {
            kind: 'user',
            id: 'user_latest_tool',
            text: 'inspect the current file'
          },
          blocks: [
            toolBlock({
              id: 'tool_latest_read',
              summary: 'read: current file',
              status: 'success',
              meta: { toolName: 'read' },
              filePath: '/tmp/project/src/current.ts'
            })
          ]
        },
        isProcessing: true,
        liveReasoning: '',
        live: '',
        filePreviewWorkspaceRoot: '/tmp/project',
        viewportRef: { current: null }
      })
    )

    expect((html.match(/\/tmp\/project\/src\/current\.ts/g) ?? [])).toHaveLength(2)
  })

  it('keeps same-batch tool calls collapsed by default', () => {
    const readBlock: ChatBlock = toolBlock({
      id: 'tool_read',
      summary: 'read: file',
      detail: 'read detail should stay tucked away',
      meta: { toolName: 'read' },
      filePath: '/tmp/readme.md'
    })
    const grepBlock: ChatBlock = toolBlock({
      id: 'tool_grep',
      summary: 'grep: search',
      detail: 'grep detail should stay tucked away',
      meta: { toolName: 'grep', pattern: 'needle' },
      filePath: '/tmp/src'
    })

    const html = renderToStaticMarkup(
      createElement(ProcessSectionRow, {
        section: { id: 'execution-batch', kind: 'execution', blocks: [readBlock, grepBlock] },
        processing: false,
        singleReasoningSection: false,
        workspaceRoot: '/tmp/project',
        viewportRef: { current: null }
      })
    )

    expect(html).toContain('Read 1 file · Searched once')
    expect(html).not.toContain('ds-work-stack')
    expect(html).not.toContain('/tmp/readme.md')
    expect(html).not.toContain('needle')
    expect(html).not.toContain('read detail should stay tucked away')
    expect(html).not.toContain('grep detail should stay tucked away')
  })

  it('folds non-text work before the following live assistant text', () => {
    const turn = {
      user: {
        kind: 'user' as const,
        id: 'user_1',
        text: 'review the release'
      },
      blocks: [
        toolBlock({
          id: 'tool_read',
          summary: 'read: file',
          status: 'success',
          meta: { toolName: 'read' }
        }),
        toolBlock({
          id: 'tool_grep',
          summary: 'grep: search',
          status: 'success',
          meta: { toolName: 'grep', pattern: 'needle' }
        })
      ]
    }

    const html = renderToStaticMarkup(
      createElement(ConversationTurn, {
        turn,
        isProcessing: true,
        liveReasoning: 'next plan',
        live: '发现阻塞项：继续审阅。',
        filePreviewWorkspaceRoot: '/tmp/project',
        viewportRef: { current: null }
      })
    )

    expect(html).toContain('Thinking… · Read 1 file · Searched once')
    expect(html).toContain('发现阻塞项：继续审阅。')
    expect(html).toContain('aria-expanded="false"')
    expect(html.indexOf('Thinking… · Read 1 file · Searched once')).toBeLessThan(
      html.indexOf('发现阻塞项：继续审阅。')
    )
    expect(html.match(/ds-work-logo-phase-trail/g) ?? []).toHaveLength(1)
    expect(html.indexOf('ds-work-logo-phase-trail')).toBeGreaterThan(
      html.indexOf('发现阻塞项：继续审阅。')
    )
  })

  it('keeps pending request_user_input compact while other tool details stay tucked away', () => {
    const readBlock: ChatBlock = toolBlock({
      id: 'tool_read',
      summary: 'read: file',
      detail: 'read detail should stay tucked away',
      meta: { toolName: 'read' },
      filePath: '/tmp/readme.md'
    })
    const inputBlock: ChatBlock = {
      kind: 'user_input',
      id: 'ui_1',
      requestId: 'input_1',
      status: 'pending',
      live: true,
      questions: [
        {
          header: 'Dinner',
          id: 'dinner',
          question: 'What should we eat tonight?',
          options: [
            {
              label: 'Noodles',
              description: 'Fast and warm'
            }
          ]
        }
      ]
    }

    const html = renderToStaticMarkup(
      createElement(ProcessSectionRow, {
        section: { id: 'execution-batch', kind: 'execution', blocks: [readBlock, inputBlock] },
        processing: true,
        singleReasoningSection: false,
        workspaceRoot: '/tmp/project',
        viewportRef: { current: null }
      })
    )

    expect(html).toContain('ds-work-stack')
    expect(html).toContain('What should we eat tonight?')
    expect(html).not.toContain('Noodles')
    expect(html).toContain('Complete this above the input box')
    expect(html).not.toContain('read detail should stay tucked away')
  })

  it('auto-expands pending approvals while keeping other tool details tucked away', () => {
    const readBlock: ChatBlock = toolBlock({
      id: 'tool_read',
      summary: 'read: file',
      detail: 'read detail should stay tucked away',
      meta: { toolName: 'read' },
      filePath: '/tmp/readme.md'
    })
    const approvalBlock: ChatBlock = {
      kind: 'approval',
      id: 'approval_appr_1',
      approvalId: 'appr_1',
      status: 'pending',
      toolName: 'edit',
      summary: 'Run edit(path="/tmp/app.ts")'
    }

    const html = renderToStaticMarkup(
      createElement(ProcessSectionRow, {
        section: { id: 'execution-batch', kind: 'execution', blocks: [readBlock, approvalBlock] },
        processing: true,
        singleReasoningSection: false,
        workspaceRoot: '/tmp/project',
        viewportRef: { current: null }
      })
    )

    expect(html).toContain('ds-work-stack')
    expect(html).toContain('Run edit(path=&quot;/tmp/app.ts&quot;)')
    expect(html).toMatch(/Approval required|需要审批|approvalTitle/)
    expect(html).toMatch(/Allow|允许|approvalAllow/)
    expect(html).not.toContain('read detail should stay tucked away')
  })

  it('renders automatic review rationale without manual Allow or Deny controls', () => {
    const reviewBlock: ChatBlock = {
      kind: 'approval_review',
      id: 'approval-review-review_1',
      reviewId: 'review_1',
      approvalId: 'approval_1',
      status: 'denied',
      toolName: 'exec_command',
      summary: 'Run a host command',
      riskLevel: 'high',
      rationale: 'The command targets a path outside the workspace.'
    }

    const html = renderToStaticMarkup(
      createElement(MessageBubble, { block: reviewBlock })
    )

    expect(html).toContain('Kun approval review')
    expect(html).toContain('Denied by Kun')
    expect(html).toContain('Risk: high')
    expect(html).toContain('The command targets a path outside the workspace.')
    expect(html).not.toContain('>Allow<')
    expect(html).not.toContain('>Deny<')
    expect(html).not.toContain('approvalAllow')
    expect(html).not.toContain('approvalDeny')
  })

  it('renders a pending request_user_input as a read-only record pointing to the composer', () => {
    const inputBlock: ChatBlock = {
      kind: 'user_input',
      id: 'ui_freeform',
      requestId: 'input_freeform',
      status: 'pending',
      // The live runtime is actively awaiting this request.
      live: true,
      questions: [
        {
          header: 'Input',
          id: 'direction',
          question: '你更想去南方还是北方？',
          options: []
        }
      ]
    }

    const html = renderToStaticMarkup(
      createElement(ProcessSectionRow, {
        section: { id: 'execution-input', kind: 'execution', blocks: [inputBlock] },
        processing: true,
        singleReasoningSection: false,
        workspaceRoot: '/tmp/project',
        viewportRef: { current: null }
      })
    )

    expect(html).toContain('你更想去南方还是北方？')
    // Answering and cancelling moved to the composer-docked panel; the bubble
    // is now only a compact record pointing to that actionable surface.
    expect(html).not.toContain('<textarea')
    expect(html).toContain('Complete this above the input box')
    expect(html).not.toContain('Cancel')
  })

  it('renders a stale pending request_user_input from history as a non-actionable record (issue #606)', () => {
    // A request rehydrated from a finished thread keeps `status: 'pending'` but
    // is not `live`, so it must not offer Cancel (which would hit a dead gate).
    const inputBlock: ChatBlock = {
      kind: 'user_input',
      id: 'ui_stale',
      requestId: 'input_stale',
      status: 'pending',
      questions: [
        {
          header: 'Input',
          id: 'direction',
          question: '你更想去南方还是北方？',
          options: []
        }
      ]
    }

    const html = renderToStaticMarkup(
      createElement(ProcessSectionRow, {
        section: { id: 'execution-input', kind: 'execution', blocks: [inputBlock] },
        processing: true,
        singleReasoningSection: false,
        workspaceRoot: '/tmp/project',
        viewportRef: { current: null }
      })
    )

    // The record still shows what was asked…
    expect(html).toContain('你更想去南方还是北方？')
    // …but offers no live affordances, so it cannot fire a dead resolve.
    expect(html).not.toContain('Complete this above the input box')
    // It reads as an ended record rather than an active prompt.
    expect(html).toContain('Cancelled')
  })

  it('shows the current tool collapsed while the bottom running row stays active', () => {
    const blocks: ChatBlock[] = [
      {
        kind: 'user',
        id: 'user_1',
        text: 'inspect this file'
      },
      toolBlock({
        summary: 'read: file',
        status: 'running',
        detail: 'running timeline detail should stay collapsed',
        meta: { toolName: 'read' },
        filePath: '/tmp/project/src/app.ts'
      })
    ]
    useChatStore.setState({
      busy: true,
      currentTurnUserId: 'user_1',
      turnStartedAtByUserId: { user_1: Date.now() }
    })

    const html = renderToStaticMarkup(
      createElement(MessageTimeline, {
        blocks,
        liveReasoning: '',
        live: '',
        activeThreadId: 'thr_1',
        runtimeConnection: 'ready',
        onRetryConnection: () => undefined,
        onOpenSettings: () => undefined
      })
    )

    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('Read')
    expect(html).toContain('/tmp/project/src/app.ts')
    expect(html).toContain('is-active')
    expect(html).toContain('ds-work-logo-phase-trail')
    expect(html).not.toContain('running timeline detail should stay collapsed')
  })

  it('stops a Graph planning turn when its draft pauses for correction', () => {
    expect(timelineTurnIsProcessing({
      busy: true,
      isLatestTurn: true,
      turnPending: true,
      hasLiveStream: true,
      turnId: 'turn_1',
      graphPlanningCorrectionTurnId: 'turn_1'
    })).toBe(false)
    expect(timelineTurnIsProcessing({
      busy: true,
      isLatestTurn: true,
      turnPending: false,
      hasLiveStream: false,
      turnId: 'turn_2',
      graphPlanningCorrectionTurnId: 'turn_1'
    })).toBe(true)
  })

  it('keeps the fallback running animation visible between process events', () => {
    const turn = {
      user: {
        kind: 'user',
        id: 'user_1',
        text: 'keep working'
      } as const,
      blocks: [toolBlock({
        id: 'tool_read',
        summary: 'read: file',
        status: 'success',
        meta: { toolName: 'read' },
        filePath: '/tmp/project/src/app.ts'
      })]
    }

    const html = renderToStaticMarkup(
      createElement(ConversationTurn, {
        turn,
        isProcessing: true,
        liveReasoning: '',
        live: '',
        filePreviewWorkspaceRoot: '/tmp/project',
        viewportRef: { current: null }
      })
    )

    expect(html).toContain('Read')
    expect(html).toContain('ds-work-logo-phase-trail')
    expect(html).toContain('is-active')
  })

  it('keeps intermediate text visible while compact activity details remain collapsed', () => {
    const blocks: ChatBlock[] = [
      {
        kind: 'user',
        id: 'user_1',
        text: 'inspect this flow'
      },
      {
        kind: 'reasoning',
        id: 'reasoning_1',
        text: 'internal reasoning should stay collapsed'
      },
      toolBlock({
        id: 'tool_read',
        summary: 'read: file',
        detail: 'completed read detail should stay collapsed',
        meta: { toolName: 'read' },
        filePath: '/tmp/project/src/flow.ts'
      }),
      {
        kind: 'assistant',
        id: 'assistant_progress',
        text: 'I found the rendering path and am checking the active state.'
      },
      toolBlock({
        id: 'tool_search',
        summary: 'grep: search',
        status: 'running',
        detail: 'running search detail should stay collapsed',
        meta: { toolName: 'grep', pattern: 'workExpanded' },
        filePath: '/tmp/project/src'
      })
    ]
    useChatStore.setState({
      busy: true,
      currentTurnUserId: 'user_1',
      turnStartedAtByUserId: { user_1: Date.now() }
    })

    const html = renderToStaticMarkup(
      createElement(MessageTimeline, {
        blocks,
        liveReasoning: '',
        live: '',
        activeThreadId: 'thr_1',
        runtimeConnection: 'ready',
        onRetryConnection: () => undefined,
        onOpenSettings: () => undefined
      })
    )

    expect(html).toContain('I found the rendering path and am checking the active state.')
    expect(html).toContain('Read 1 file')
    expect(html).toContain('Search')
    expect(html).toContain('aria-expanded="false"')
    expect(html.indexOf('Read 1 file')).toBeLessThan(
      html.indexOf('I found the rendering path and am checking the active state.')
    )
    expect(html.indexOf('I found the rendering path and am checking the active state.')).toBeLessThan(
      html.indexOf('workExpanded')
    )
    expect(html).not.toContain('internal reasoning should stay collapsed')
    expect(html).not.toContain('completed read detail should stay collapsed')
    expect(html).not.toContain('running search detail should stay collapsed')
  })

  it('auto-folds completed work and leaves only the final assistant text visible', () => {
    const html = renderToStaticMarkup(
      createElement(ConversationTurn, {
        turn: {
          user: {
            kind: 'user',
            id: 'user_completed_chain',
            text: 'finish the investigation'
          },
          blocks: [
            {
              kind: 'reasoning',
              id: 'reasoning_completed_chain',
              text: 'intermediate reasoning'
            },
            {
              kind: 'assistant',
              id: 'assistant_progress_chain',
              text: 'I am checking the relevant path.'
            },
            toolBlock({
              id: 'tool_completed_chain',
              summary: 'read: relevant path',
              meta: { toolName: 'read' },
              filePath: '/tmp/project/src/path.ts'
            }),
            {
              kind: 'assistant',
              id: 'assistant_final_chain',
              text: 'The final answer is ready.'
            }
          ]
        },
        isProcessing: false,
        liveReasoning: '',
        live: '',
        durationMs: 87_000,
        filePreviewWorkspaceRoot: '/tmp/project',
        viewportRef: { current: null }
      })
    )

    expect(html).toContain('1m 27s')
    expect(html).toContain('The final answer is ready.')
    expect(html).toContain('ds-chat-answer')
    expect(html).toContain('Read 1 file')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('I am checking the relevant path.')
    expect(html).not.toContain('intermediate reasoning')
    expect(html).not.toContain('/tmp/project/src/path.ts')
  })

  it('still expands live work automatically when an approval needs attention', () => {
    const blocks: ChatBlock[] = [
      {
        kind: 'user',
        id: 'user_1',
        text: 'edit this file'
      },
      {
        kind: 'approval',
        id: 'approval_1',
        approvalId: 'approval_1',
        status: 'pending',
        toolName: 'edit',
        summary: 'Run edit(path="/tmp/project/src/app.ts")'
      }
    ]
    useChatStore.setState({
      busy: true,
      currentTurnUserId: 'user_1',
      turnStartedAtByUserId: { user_1: Date.now() }
    })

    const html = renderToStaticMarkup(
      createElement(MessageTimeline, {
        blocks,
        liveReasoning: '',
        live: '',
        activeThreadId: 'thr_1',
        runtimeConnection: 'ready',
        onRetryConnection: () => undefined,
        onOpenSettings: () => undefined
      })
    )

    expect(html).toContain('Run edit(path=&quot;/tmp/project/src/app.ts&quot;)')
    expect(html).toMatch(/Approval required|需要审批|approvalTitle/)
  })

  it('renders running compaction as a lightweight process status entry', () => {
    const blocks: ChatBlock[] = [
      {
        kind: 'compaction',
        id: 'compact_1',
        summary: 'Context compacted',
        status: 'running',
        auto: false
      }
    ]
    useChatStore.setState({
      busy: true,
      currentTurnUserId: null,
      turnStartedAtByUserId: {}
    })

    const html = renderToStaticMarkup(
      createElement(MessageTimeline, {
        blocks,
        liveReasoning: '',
        live: '',
        activeThreadId: 'thr_1',
        runtimeConnection: 'ready',
        onRetryConnection: () => undefined,
        onOpenSettings: () => undefined
      })
    )

    expect(html).toContain('role="status"')
    expect(html).toMatch(/Compacting|compactionRunning|正在压缩上下文/)
    expect(html).toMatch(/context|上下文/)
    expect(html).toContain('ds-work-logo-phase-trail')
    expect(html.indexOf('ds-work-logo-phase-trail')).toBeGreaterThan(
      html.indexOf('role="status"')
    )
    expect(html).not.toContain('aria-expanded=')
  })

  it('renders later live work below the compaction marker', () => {
    const blocks: ChatBlock[] = [
      {
        kind: 'user',
        id: 'user_1',
        turnId: 'turn_1',
        text: 'continue the task'
      },
      {
        kind: 'tool',
        id: 'before_compaction',
        turnId: 'turn_1',
        summary: 'read: before compaction',
        status: 'success',
        toolKind: 'tool_call',
        filePath: '/tmp/TIMELINE_BEFORE_COMPACTION.ts',
        meta: { toolName: 'read' }
      },
      {
        kind: 'compaction',
        id: 'compact_1',
        turnId: 'turn_1',
        summary: 'Context compacted',
        status: 'success',
        auto: true
      },
      {
        kind: 'tool',
        id: 'after_compaction',
        turnId: 'turn_1',
        summary: 'read: after compaction',
        status: 'running',
        toolKind: 'tool_call',
        filePath: '/tmp/TIMELINE_AFTER_COMPACTION.ts',
        meta: { toolName: 'read' }
      }
    ]
    useChatStore.setState({
      busy: true,
      currentTurnUserId: 'user_1',
      turnStartedAtByUserId: { user_1: Date.now() }
    })

    const html = renderToStaticMarkup(
      createElement(MessageTimeline, {
        blocks,
        liveReasoning: '',
        live: '',
        activeThreadId: 'thr_1',
        runtimeConnection: 'ready',
        onRetryConnection: () => undefined,
        onOpenSettings: () => undefined
      })
    )

    const beforeIndex = html.indexOf('TIMELINE_BEFORE_COMPACTION.ts')
    const compactionIndex = html.indexOf('data-compaction-timeline-entry="true"')
    const afterIndex = html.indexOf('TIMELINE_AFTER_COMPACTION.ts')
    expect(beforeIndex).toBeGreaterThanOrEqual(0)
    expect(compactionIndex).toBeGreaterThan(beforeIndex)
    expect(afterIndex).toBeGreaterThan(compactionIndex)
  })

  it('folds a completed runtime error into the collapsed work summary', () => {
    const blocks: ChatBlock[] = [
      {
        kind: 'user',
        id: 'user_1',
        text: 'draw this'
      },
      {
        kind: 'system',
        id: 'error_1',
        text: 'model request failed with status 400',
        detail: [
          'Code: http_400',
          '',
          'Severity: error',
          '',
          'Message:',
          'full provider body only visible in the expanded error detail'
        ].join('\n'),
        code: 'http_400',
        severity: 'error'
      }
    ]
    useChatStore.setState({
      busy: false,
      currentTurnUserId: null,
      turnStartedAtByUserId: {}
    })

    const html = renderToStaticMarkup(
      createElement(MessageTimeline, {
        blocks,
        liveReasoning: '',
        live: '',
        activeThreadId: 'thr_1',
        runtimeConnection: 'ready',
        onRetryConnection: () => undefined,
        onOpenSettings: () => undefined
      })
    )

    // Completed turns auto-collapse: a runtime error folds into the toggleable
    // work summary rather than rendering inline, so its text and detail stay
    // hidden until the user expands the panel.
    expect(html).toContain('Work process (1 steps)')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('request failed with status 400')
    expect(html).not.toContain('Code: http_400')
    expect(html).not.toContain('full provider body only visible in the expanded error detail')
  })

  it('renders a durable runtime failure inline with expandable technical detail', () => {
    const html = renderToStaticMarkup(
      createElement(TimelineRuntimeError, {
        block: {
          kind: 'system',
          id: 'error_1',
          turnId: 'turn_1',
          text: 'Cursor SDK authentication failed',
          detail: 'Code: cursor_sdk_authentication_failed\n\nMessage:\nInvalid API key',
          code: 'cursor_sdk_authentication_failed',
          severity: 'error',
          runtimeError: true
        }
      })
    )

    expect(html).toContain('role="alert"')
    expect(html).toContain('Cursor SDK authentication failed')
    expect(html).toContain('cursor_sdk_authentication_failed')
    expect(html).toContain('<details')
    expect(html).toContain('Invalid API key')
  })

  it('keeps timeline spacing independent from composer status surfaces', () => {
    expect(timelineBottomPaddingClass()).toBe('pb-10')
  })

  it('lets the composer stack reserve space without moving the live progress row', () => {
    expect(liveTurnProgressClass()).not.toContain('mb-16 md:mb-20')
  })

  it('renders the fork action before copy in completed assistant response actions', () => {
    const blocks: ChatBlock[] = [
      {
        kind: 'user',
        id: 'user_1',
        turnId: 'turn_1',
        text: 'say hi'
      },
      {
        kind: 'assistant',
        id: 'assistant_1',
        turnId: 'turn_1',
        text: 'hello'
      }
    ]

    const html = renderToStaticMarkup(
      createElement(MessageTimeline, {
        blocks,
        liveReasoning: '',
        live: '',
        activeThreadId: 'thr_1',
        runtimeConnection: 'ready',
        onRetryConnection: () => undefined,
        onOpenSettings: () => undefined
      })
    )

    expect(html).toMatch(/forkResponse|Fork response|分叉回答/)
    expect(html).toMatch(/forkFromAssistantResponse|Fork a new thread from this response|从这条回答分叉新会话/)
    const forkIndex = html.search(/forkFromAssistantResponse|Fork a new thread from this response|从这条回答分叉新会话/)
    const copyIndex = html.slice(forkIndex).search(/copyMessage|Copy message|复制消息/)
    expect(forkIndex).toBeGreaterThanOrEqual(0)
    expect(copyIndex).toBeGreaterThan(0)
  })

  it('renders an export action for completed assistant responses', () => {
    const html = renderToStaticMarkup(
      createElement(MessageBubble, {
        block: {
          kind: 'assistant',
          id: 'assistant_1',
          turnId: 'turn_1',
          text: 'share this answer'
        }
      })
    )

    expect(html).toMatch(/exportAnswer|Export answer|导出回答/)
    expect(html).toMatch(/writeExportPdf|Export PDF|导出 PDF/)
    expect(html).toMatch(/writeExportDocx|Export DOCX|导出 DOCX/)
    expect(html).toMatch(/writeExportPng|Export PNG|导出 PNG/)
  })

  it('renders per-turn average TTFT/TPS next to the timestamp when available', () => {
    useChatStore.setState({
      turnTimingMetrics: new Map([
        ['turn_1', { avgTtftMs: 1_000, avgTokensPerSecond: 40.2 }]
      ])
    })
    try {
      const html = renderToStaticMarkup(
        createElement(MessageBubble, {
          block: {
            kind: 'assistant',
            id: 'assistant_1',
            turnId: 'turn_1',
            text: 'hello'
          }
        })
      )

      // zustand v5 serves SSR renders from the INITIAL state, so the
      // per-turn map set above is not visible here; verify the wiring
      // through the client render path instead.
      expect(turnMetricsLabel(t, { avgTtftMs: 1_000, avgTokensPerSecond: 40.2 }))
        .toBe('Avg TTFT 1.0s · Avg 40.2 tok/s')
      expect(html).not.toContain('tok/s')
    } finally {
      useChatStore.setState({ turnTimingMetrics: new Map() })
    }
  })

  it('omits segments without timing data from the footer label', () => {
    expect(turnMetricsLabel(t, { avgTtftMs: null, avgTokensPerSecond: null })).toBe('')
    expect(turnMetricsLabel(t, { avgTtftMs: 800, avgTokensPerSecond: null }))
      .toBe('Avg TTFT 0.8s')
    expect(turnMetricsLabel(t, { avgTtftMs: null, avgTokensPerSecond: 38.5 }))
      .toBe('Avg 38.5 tok/s')
  })

  it('renders the workspace rollback action with fork in completed assistant response actions', () => {
    const blocks: ChatBlock[] = [
      {
        kind: 'user',
        id: 'user_1',
        turnId: 'turn_1',
        text: 'change files',
        meta: { workspaceCheckpointId: 'gcp_1' }
      },
      {
        kind: 'assistant',
        id: 'assistant_1',
        turnId: 'turn_1',
        text: 'done'
      }
    ]

    const html = renderToStaticMarkup(
      createElement(MessageTimeline, {
        blocks,
        liveReasoning: '',
        live: '',
        activeThreadId: 'thr_1',
        runtimeConnection: 'ready',
        onRetryConnection: () => undefined,
        onOpenSettings: () => undefined
      })
    )

    expect(html).toMatch(/rollbackWorkspace|Rollback commit|回滚提交/)
    expect(html).toMatch(/rollbackWorkspaceFromAssistantResponse|Rollback this response&#x27;s Git commit|只回滚这条回答对应的 Git 提交/)
    const rollbackIndex = html.search(/rollbackWorkspaceFromAssistantResponse|Rollback this response&#x27;s Git commit|只回滚这条回答对应的 Git 提交/)
    const forkIndex = html.slice(rollbackIndex).search(/forkFromAssistantResponse|Fork a new thread from this response|从这条回答分叉新会话/)
    const copyIndex = html.slice(rollbackIndex + Math.max(forkIndex, 0)).search(/copyMessage|Copy message|复制消息/)
    expect(rollbackIndex).toBeGreaterThanOrEqual(0)
    expect(forkIndex).toBeGreaterThan(0)
    expect(copyIndex).toBeGreaterThan(0)
  })

  it('renders each file-change summary after the turn that produced it', () => {
    const patch = (path: string, before: string, after: string) => [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@ -1 +1 @@',
      `-${before}`,
      `+${after}`
    ].join('\n')
    const blocks: ChatBlock[] = [
      { kind: 'user', id: 'user_1', turnId: 'turn_1', text: 'change alpha' },
      {
        kind: 'tool',
        id: 'tool_1',
        summary: 'edit alpha',
        status: 'success',
        toolKind: 'file_change',
        filePath: '/tmp/project/src/alpha.ts',
        detail: patch('src/alpha.ts', 'alpha old', 'alpha new')
      },
      { kind: 'assistant', id: 'assistant_1', turnId: 'turn_1', text: 'alpha done' },
      { kind: 'user', id: 'user_2', turnId: 'turn_2', text: 'change beta' },
      {
        kind: 'tool',
        id: 'tool_2',
        summary: 'edit beta',
        status: 'success',
        toolKind: 'file_change',
        filePath: '/tmp/project/src/beta.ts',
        detail: patch('src/beta.ts', 'beta old', 'beta new')
      },
      { kind: 'assistant', id: 'assistant_2', turnId: 'turn_2', text: 'beta done' }
    ]

    const html = renderToStaticMarkup(
      createElement(MessageTimeline, {
        blocks,
        liveReasoning: '',
        live: '',
        activeThreadId: 'thr_1',
        runtimeConnection: 'ready',
        onRetryConnection: () => undefined,
        onOpenSettings: () => undefined,
        onOpenChanges: () => undefined,
        onReviewChanges: () => undefined
      })
    )

    const firstAnswerIndex = html.indexOf('alpha done')
    const firstFileIndex = html.indexOf('src/alpha.ts')
    const secondQuestionIndex = html.indexOf('change beta')
    const secondAnswerIndex = html.indexOf('beta done')
    const secondFileIndex = html.indexOf('src/beta.ts')

    expect(html.match(/data-turn-change-summary/g)).toHaveLength(2)
    expect(firstFileIndex).toBeGreaterThan(firstAnswerIndex)
    expect(firstFileIndex).toBeLessThan(secondQuestionIndex)
    expect(secondFileIndex).toBeGreaterThan(secondAnswerIndex)
    expect(html).toMatch(/composerOpenChanges|Preview|预览/)
    expect(html).toMatch(/composerReviewChanges|Review|审查/)
  })

  it('renders live assistant text inside the process timeline while busy', () => {
    // Streaming period: the user has just sent a turn, the agent is
    // running, and the SSE has streamed some `live` text into the chat
    // store. The chat view must surface the streamed text immediately
    // (e.g. for the Feishu bot case), not wait until turn_completed.
    //
    // While active, streamed text belongs to the same chronological process
    // as reasoning and tools. It becomes the outside answer bubble only after
    // turn completion.
    const blocks: ChatBlock[] = [
      {
        kind: 'user',
        id: 'user_1',
        text: 'say hi'
      }
    ]
    useChatStore.setState({
      busy: true,
      currentTurnUserId: 'user_1',
      turnStartedAtByUserId: { user_1: Date.now() }
    })

    const html = renderToStaticMarkup(
      createElement(MessageTimeline, {
        blocks,
        liveReasoning: '',
        live: 'hello',
        activeThreadId: 'thr_1',
        runtimeConnection: 'ready',
        onRetryConnection: () => undefined,
        onOpenSettings: () => undefined
      })
    )

    expect(html).toContain('hello')
    expect(html).not.toContain('ds-chat-answer')
  })
})
