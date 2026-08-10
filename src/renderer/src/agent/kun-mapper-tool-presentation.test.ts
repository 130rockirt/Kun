import { describe, expect, it, vi } from 'vitest'
import {
  chatBlockFromItem,
  dispatchKunRuntimeEvent,
  dispatchKunRuntimeEvents,
  mergeChatBlocks,
  runtimeProjectionActionsFromEvent,
  threadFromCore
} from './kun-mapper'
import type { CoreRuntimeEventJson, CoreTurnItemJson } from './kun-contract'
import type { ThreadErrorOptions, ThreadEventSink } from './types'
import {
  PRESENTATION_STUDIO_EXTENSION_ID,
  presentationStudioCanonicalToolId,
  presentationStudioModelAlias
} from '@shared/presentation-artifact'

function makeSink(): ThreadEventSink {
  return {
    onSeq: () => undefined,
    onDeltas: () => undefined,
    onUserMessage: () => undefined,
    onTool: () => undefined,
    onCompaction: () => undefined,
    onApproval: () => undefined,
    onUserInput: () => undefined,
    onUserInputStatus: () => undefined,
    onGoal: () => undefined,
    onTodos: () => undefined,
    onTurnComplete: () => undefined,
    onError: () => undefined
  }
}

describe('tool presentation inference', () => {
  it('prefers explicit toolKind from Kun over local heuristics', () => {
    const block = chatBlockFromItem({
      id: 'item_explicit_kind',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_result',
      toolName: 'custom_tool',
      toolKind: 'command_execution',
      callId: 'call_explicit',
      output: { path: '/tmp/should-not-force-file-kind', command: 'echo hi' }
    })
    expect(block).toMatchObject({
      kind: 'tool',
      toolKind: 'command_execution',
      meta: { command: 'echo hi' }
    })
  })

  it('uses the explicit command_execution kind and preserves the command string', () => {
    const block = chatBlockFromItem({
      id: 'item_shell',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_call',
      toolName: 'shell',
      toolKind: 'command_execution',
      callId: 'call_shell',
      arguments: { command: 'npm test' }
    })
    expect(block).toMatchObject({
      kind: 'tool',
      toolKind: 'command_execution',
      meta: { command: 'npm test', toolName: 'shell' }
    })
  })

  it('surfaces bash session metadata on command blocks', () => {
    const block = chatBlockFromItem({
      id: 'item_bash_session',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_result',
      toolName: 'bash',
      toolKind: 'command_execution',
      callId: 'call_bash',
      output: {
        command: 'npm run dev',
        session_id: 'bash_abc123',
        status: 'running',
        pid: 1234,
        shell: 'bash',
        cwd: '/tmp/app'
      }
    })
    expect(block).toMatchObject({
      kind: 'tool',
      toolKind: 'command_execution',
      meta: {
        command: 'npm run dev',
        session_id: 'bash_abc123',
        status: 'running',
        pid: 1234,
        shell: 'bash',
        cwd: '/tmp/app'
      }
    })
  })

  it('uses the explicit file_change kind and surfaces the path', () => {
    const block = chatBlockFromItem({
      id: 'item_file',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_result',
      toolName: 'write_file',
      toolKind: 'file_change',
      callId: 'call_file',
      output: { path: '/tmp/demo.ts', bytes_written: 12 }
    })
    expect(block).toMatchObject({
      kind: 'tool',
      toolKind: 'file_change',
      filePath: '/tmp/demo.ts'
    })
  })

  it('maps office edits as file changes and retains their structured preview hashes', () => {
    const expectedSha256 = 'a'.repeat(64)
    const beforeSha256 = 'b'.repeat(64)
    const afterSha256 = 'c'.repeat(64)
    const call = chatBlockFromItem({
      id: 'item_office_call',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'running',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_call',
      toolName: 'office_edit',
      callId: 'call_office_edit',
      arguments: { path: 'reports/brief.docx', expectedSha256, operations: [] }
    })
    const result = chatBlockFromItem({
      id: 'item_office_result',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:01.000Z',
      kind: 'tool_result',
      toolName: 'office_edit',
      callId: 'call_office_edit',
      output: {
        path: 'reports/brief.docx',
        before_sha256: beforeSha256,
        after_sha256: afterSha256,
        preview_invalidated: true
      }
    })

    expect(call).toMatchObject({
      toolKind: 'file_change',
      filePath: 'reports/brief.docx',
      meta: { toolName: 'office_edit', expectedSha256 }
    })
    expect(result).toMatchObject({
      toolKind: 'file_change',
      filePath: 'reports/brief.docx',
      meta: { toolName: 'office_edit', beforeSha256, afterSha256, previewInvalidated: true }
    })
    expect(mergeChatBlocks([call!, result!])[0]).toMatchObject({
      meta: { expectedSha256, beforeSha256, afterSha256, previewInvalidated: true }
    })
  })

  it('surfaces final output and destination path aliases for generated artifacts', () => {
    const ppt = chatBlockFromItem({
      id: 'item_ppt',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_result',
      toolName: 'ppt_master_run',
      toolKind: 'file_change',
      callId: 'call_ppt',
      output: {
        output_path: '/tmp/presentations/brief.pptx',
        generatedFiles: [{
          relativePath: 'presentations/brief.pptx',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        }]
      }
    })
    const htmlCopy = chatBlockFromItem({
      id: 'item_html_copy',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_result',
      toolName: presentationStudioModelAlias('presentation-export-copy'),
      toolKind: 'file_change',
      callId: 'call_html_copy',
      output: {
        content: {
          sourcePath: 'brief.kun-ppt.html',
          destinationPath: 'brief-copy.kun-ppt.html',
          contentSha256: 'a'.repeat(64)
        },
        summary: 'Exported copy'
      }
    })

    expect(ppt).toMatchObject({
      filePath: '/tmp/presentations/brief.pptx',
      meta: {
        generatedFiles: [{
          relativePath: 'presentations/brief.pptx',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        }]
      }
    })
    expect(htmlCopy).toMatchObject({
      filePath: 'brief-copy.kun-ppt.html',
      meta: {
        canonicalToolId: presentationStudioCanonicalToolId('presentation-export-copy'),
        presentationArtifactProducer: PRESENTATION_STUDIO_EXTENSION_ID,
        presentationArtifactSha256: 'a'.repeat(64)
      }
    })
  })

  it('unwraps progressive extension gateway presentation writes with trusted provenance', () => {
    const block = chatBlockFromItem({
      id: 'item_gateway_html',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_result',
      toolName: 'extension_tool_call',
      toolKind: 'tool_call',
      callId: 'call_gateway_html',
      output: {
        canonicalToolId: presentationStudioCanonicalToolId('presentation-apply'),
        result: {
          content: {
            path: 'brief.kun-ppt.html',
            resultingRevision: 2,
            contentSha256: 'b'.repeat(64)
          },
          summary: 'Applied operations'
        }
      }
    })

    expect(block).toMatchObject({
      toolKind: 'file_change',
      filePath: 'brief.kun-ppt.html',
      meta: {
        canonicalToolId: presentationStudioCanonicalToolId('presentation-apply'),
        presentationArtifactProducer: PRESENTATION_STUDIO_EXTENSION_ID,
        presentationArtifactSha256: 'b'.repeat(64)
      }
    })
  })

  it('preserves workspace-write semantics from a generic progressive extension gateway', () => {
    const block = chatBlockFromItem({
      id: 'item_gateway_ppt',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_result',
      toolName: 'extension_tool_call',
      toolKind: 'tool_call',
      callId: 'call_gateway_ppt',
      output: {
        canonicalToolId: 'extension:example.exporter/export-ppt',
        sideEffect: 'workspace-write',
        result: { content: { destinationPath: 'presentations/brief.pptx' } }
      }
    })

    expect(block).toMatchObject({
      toolKind: 'file_change',
      filePath: 'presentations/brief.pptx'
    })
  })

  it('classifies built-in write/edit tools as file_change by name when toolKind is omitted', () => {
    const block = chatBlockFromItem({
      id: 'item_write_builtin',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_result',
      toolName: 'write',
      callId: 'call_write',
      output: { path: '/tmp/demo.ts', bytes_written: 12 }
    })
    expect(block).toMatchObject({
      kind: 'tool',
      toolKind: 'file_change',
      filePath: '/tmp/demo.ts'
    })
  })

  it('classifies built-in bash by name as command_execution when toolKind is omitted', () => {
    const block = chatBlockFromItem({
      id: 'item_bash_builtin',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_result',
      toolName: 'bash',
      callId: 'call_bash',
      output: { command: 'pwd', output: '/tmp' }
    })
    expect(block).toMatchObject({
      kind: 'tool',
      toolKind: 'command_execution',
      meta: { command: 'pwd', toolName: 'bash' }
    })
  })

  it('falls back to payload shape when legacy items omit toolKind', () => {
    const block = chatBlockFromItem({
      id: 'item_legacy',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_result',
      toolName: 'future_tool',
      callId: 'call_legacy',
      output: { command: 'npm test', path: '/tmp/demo.ts' }
    })
    expect(block).toMatchObject({
      kind: 'tool',
      toolKind: 'command_execution',
      meta: { command: 'npm test' }
    })
  })

  it('keeps validated extension composer metadata on persisted user blocks', () => {
    const composerContext = {
      schemaVersion: 1 as const,
      id: 'video-selection',
      title: 'Interview selection',
      summary: 'Revision 4 with one selected clip',
      reference: { projectId: 'project-1', selectedItemIds: ['clip-1'] },
      revision: 4,
      generation: 7,
      attachmentId: `extension-context:${'a'.repeat(64)}`,
      provenance: {
        extensionId: 'acme.video-editor',
        extensionVersion: '1.1.0',
        viewContributionId: 'extension:acme.video-editor/editor',
        workspaceId: 'b'.repeat(64)
      }
    }
    const block = chatBlockFromItem({
      id: 'item-user-context',
      turnId: 'turn-1',
      threadId: 'thread-1',
      role: 'user',
      status: 'completed',
      createdAt: '2026-07-14T00:00:00.000Z',
      kind: 'user_message',
      text: 'Use the selection',
      composerContexts: [composerContext]
    })
    expect(block).toMatchObject({
      kind: 'user',
      meta: { composerContexts: [composerContext] }
    })
  })
})
