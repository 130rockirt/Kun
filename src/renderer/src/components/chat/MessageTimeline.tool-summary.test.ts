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
  summarizeToolBlock
} from './MessageTimeline'
import {
  GeneratedFilesPanel,
  MessageBubble,
  generatedMediaScrollAvailability
} from './message-timeline-bubbles'
import { ProcessSectionRow, groupProcessSections } from './message-timeline-process'
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
  toolActionBackgroundShellList: 'List background shells'
}

const t = (key: string) => labels[key] ?? (key === 'toolActionCommand' ? 'Ran command' : key)

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

  it('coalesces reasoning and tools into one activity phase until visible text appears', () => {
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

  it('keeps live reasoning out of a completed tool batch so thinking does not eat the summary', () => {
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
        ids: ['tool_read', 'tool_grep']
      },
      {
        kind: 'reasoning',
        ids: ['live-reasoning']
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

  it('renders active generated work before the merged visible assistant reply without a duplicate', () => {
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
    expect(html.indexOf(placement)).toBeLessThan(html.indexOf('Preparing the image now.'))
    expect(html.indexOf('Preparing the image now.')).toBeLessThan(html.indexOf('Checking the rendered result.'))
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
    expect(html).toContain('Used 2 tools')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Search needle')
    expect(html).not.toContain('text-orange-700')
    expect(html).not.toContain('search error detail should stay tucked away')
    expect(html).not.toContain('read detail should stay tucked away')
  })

  it('keeps live thinking on the turn-bottom loading row', () => {
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
        filePreviewWorkspaceRoot: '/tmp/project',
        viewportRef: { current: null }
      })
    )

    expect(html).toContain('Read')
    expect(html).toContain('ds-shiny-text')
    expect(html).toContain('ds-work-logo')
    expect(html).toContain('is-active')
    expect(html).toMatch(/Thinking|思考中|thinkingNow/)
    expect(html).not.toContain('current reasoning summary')
    expect(html).not.toContain('&lt;!-- --&gt;')
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

    expect(html).toContain('Used 2 tools')
    expect(html).not.toContain('ds-work-stack')
    expect(html).not.toContain('/tmp/readme.md')
    expect(html).not.toContain('needle')
    expect(html).not.toContain('read detail should stay tucked away')
    expect(html).not.toContain('grep detail should stay tucked away')
  })

  it('keeps the completed tool summary visible while live thinking stays at the turn bottom', () => {
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

    expect(html).toContain('Used 2 tools')
    expect(html).toContain('发现阻塞项：继续审阅。')
    expect(html).toMatch(/Thinking|思考中|thinkingNow/)
    expect(html.indexOf('Used 2 tools')).toBeLessThan(html.search(/Thinking|思考中|thinkingNow/))
    expect(html.indexOf('发现阻塞项：继续审阅。')).toBeLessThan(html.search(/Thinking|思考中|thinkingNow/))
  })

  it('auto-expands pending request_user_input while keeping other tool details tucked away', () => {
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
    expect(html).toContain('Noodles')
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
    // Answering moved to the composer-docked panel; the bubble is now the
    // record, so it no longer hosts interactive inputs — only a pointer + cancel.
    expect(html).not.toContain('<textarea')
    expect(html).toContain('Answer below the input box')
    expect(html).toContain('Cancel')
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
    // …but offers no live affordances (the "answer below" hint and the Cancel
    // button share one `pending` branch), so it can't fire a dead resolve.
    expect(html).not.toContain('Answer below the input box')
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
    expect(html).toContain('Used 2 tools')
    expect(html).not.toContain('internal reasoning should stay collapsed')
    expect(html).not.toContain('completed read detail should stay collapsed')
    expect(html).not.toContain('running search detail should stay collapsed')
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

  it('renders running compaction as a lightweight status divider', () => {
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
    expect(html).toMatch(/Compacting context|compactionRunning|正在压缩上下文/)
    expect(html).not.toContain('aria-expanded=')
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

  it('renders the live assistant bubble while busy is true (streaming period)', () => {
    // Streaming period: the user has just sent a turn, the agent is
    // running, and the SSE has streamed some `live` text into the chat
    // store. The chat view must surface the streamed text immediately
    // (e.g. for the Feishu bot case), not wait until turn_completed.
    //
    // We assert against the `ds-chat-answer` class which is only emitted
    // by the live assistant `MessageBubble`. The process-section fold
    // in `deriveTurnSections` would render the same text via
    // `ProcessSectionRow`, so a plain text assertion is not specific
    // enough — we want the actual `live-assistant` bubble here.
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

    expect(html).toContain('ds-chat-answer')
    expect(html).toContain('hello')
  })
})
