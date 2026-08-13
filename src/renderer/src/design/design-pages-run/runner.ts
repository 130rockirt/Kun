import { useChatStore } from "../../store/chat-store"
import { collectAssistantTextForTurn } from "../../store/chat-store-runtime-helpers"
import type { ChatBlock, ToolBlock } from "../../agent/types"
import type { SendMessageOverrides } from "../../store/chat-store-types"
import {
  defaultPreviewNodeSizeForDesignTarget,
  type DesignContext
} from "../design-context"
import { buildStitchDesignMarkdown, STITCH_DESIGN_MD_PATH } from "../design-md-compat"
import {
  buildDesignLogoPrompt,
  buildDesignSpecPrompt,
  buildDesignSpecStub,
  buildFoundationFollowLines,
  designSpecPath,
  findFoundationArtifact,
  type DesignFoundationRole,
  type DesignFoundationStep
} from "../design-foundation"
import {
  DESIGN_PAGES_MAX,
  buildDesignPlanPrompt,
  buildHtmlSiblingManifest,
  buildPrototypeLinksForPage,
  extractAgentDesignSummary,
  parsePagesPlan,
  type DesignPagePlanEntry
} from "../design-pages"
import { prepareDesignPreviewFile } from "../design-preview-file"
import {
  buildDesignTurnPrompt,
  buildParallelDesignPagesPrompt,
  type ParallelDesignPageJob
} from "../design-turn-prompt"
import { createDesignArtifactId, defaultDesignArtifactNode, type DesignDirection } from "../design-types"
import type { ParallelDesignPageState } from "../design-workspace-store-types"
import { useDesignWorkspaceStore } from "../design-workspace-store"
import { useDesignSystemStore } from "../canvas/design-system-store"
import { PROJECT_DESIGN_MD_PATH } from '../design-md/design-md-paths'
import { parseProjectDesignMdWithOfficialLint } from '../design-md/design-md-adapter'
import type { RunDesignPagesDeps } from './orchestration-support'
import {
  PAGE_TIMEOUT_MS,
  PARALLEL_PAGES_TIMEOUT_MS,
  PLAN_TIMEOUT_MS,
  assistantTextForLastTurn,
  beginDesignPagesRun,
  buildDirectionName,
  captureDesignPagesRunIdentity,
  createFoundationCard,
  delay,
  designPagesRunArtifacts,
  designPagesRunCanStartTurn,
  designPagesRunIdentityMatches,
  finishDesignPagesRun,
  formatPageFlowLines,
  formatPageProductBriefLines,
  runTurn,
  syncParallelPageStates,
  waitForTurnComplete,
  writeWorkspaceTextFile
} from './orchestration-support'

/**
 * Stitch-style multi-page run. A project design system is discovered from the
 * canonical structured JSON file and rendered by the built-in canvas board; the
 * runner never asks an agent to generate a separate HTML style-guide artifact.
 */
export async function runDesignPages(deps: RunDesignPagesDeps): Promise<void> {
  let firstSendSettled = false
  const settleFirstSend = (sent: boolean): void => {
    if (firstSendSettled) return
    firstSendSettled = true
    deps.onFirstSendSettled?.(sent)
  }
  const signal = { cancelled: false }
  const identity = captureDesignPagesRunIdentity(deps)
  if (!identity) {
    settleFirstSend(false)
    return
  }
  if (!beginDesignPagesRun(signal)) {
    settleFirstSend(false)
    return
  }
  const store = useDesignWorkspaceStore.getState()
  store.setFileError(null)
  const withFoundation = deps.foundation !== false
  const contextMatches = (): boolean => designPagesRunIdentityMatches(identity)
  const fail = (message: string): void => {
    if (contextMatches()) useDesignWorkspaceStore.getState().setFileError(message)
  }

  const overrides = (display: string, continuation = false): SendMessageOverrides => ({
    displayText: display,
    ...(continuation ? { messageSource: 'design_continuation' as const } : {}),
    agentSurface: 'design',
    ...(deps.model ? { model: deps.model } : {}),
    ...(deps.providerId ? { providerId: deps.providerId } : {}),
    ...(deps.reasoningEffort ? { reasoningEffort: deps.reasoningEffort } : {}),
    ...(deps.serviceTier ? { serviceTier: deps.serviceTier } : {}),
    ...(deps.expectedThreadId ? { expectedThreadId: deps.expectedThreadId } : {}),
    ...(deps.designProfile ? { designProfile: deps.designProfile } : {}),
    ...(deps.designDocumentTarget
      ? { designDocumentTarget: deps.designDocumentTarget }
      : {}),
    ...(!continuation && deps.waitForRuntimeAdmission ? { waitForRuntimeAdmission: true } : {})
  })

  try {
    if (!contextMatches()) return
    const docId = identity.documentId
    const foundationBuiltIds = new Set<string>()
    let designMdRef: string | undefined
    let designSystemRef: string | undefined

    // 1) Plan the pages. With foundation on, the same turn writes design.md.
    let plan: DesignPagePlanEntry[]
    if (withFoundation) {
      store.setPagesRun({
        phase: 'foundation',
        step: 'spec',
        total: 0,
        done: 0,
        title: deps.labels?.foundationStep?.('spec') ?? 'Design brief'
      })
      const designMdPath = designSpecPath(docId)
      await writeWorkspaceTextFile(deps.workspaceRoot, designMdPath, buildDesignSpecStub(deps.brief))
      if (!contextMatches()) return
      const existingPages = buildHtmlSiblingManifest(designPagesRunArtifacts(identity), null)
      const specPrompt = buildDesignSpecPrompt({
        brief: deps.brief,
        workspaceRoot: deps.workspaceRoot,
        designMdPath,
        ...(deps.designContext ? { designContext: deps.designContext } : {}),
        ...(existingPages.length > 0 ? { existingPages } : {})
      })
      const specDisplay =
        deps.labels?.specDisplay?.(deps.brief) ??
        deps.labels?.plan?.(deps.brief) ??
        `Draft the design brief: ${deps.brief}`
      const status = await runTurn({
        sendMessage: deps.sendMessage,
        prompt: specPrompt,
        overrides: overrides(specDisplay),
        signal,
        timeoutMs: PLAN_TIMEOUT_MS,
        onSendSettled: settleFirstSend,
        beforeSend: deps.onFirstSendStarting,
        identity
      })
      if (status === 'cancelled' || status === 'context-changed') return
      if (status === 'send-failed') {
        fail('Could not start the design-brief turn.')
        return
      }
      if (status === 'timeout') {
        fail('The design-brief step timed out.')
        return
      }
      await delay(300) // let the final assistant block settle before we read it
      if (!contextMatches()) return
      plan = parsePagesPlan(assistantTextForLastTurn(identity), { max: DESIGN_PAGES_MAX })
      designMdRef = designMdPath
    } else {
      store.setPagesRun({ phase: 'planning', total: 0, done: 0, title: '' })
      const existingPages = buildHtmlSiblingManifest(designPagesRunArtifacts(identity), null)
      const planPrompt = buildDesignPlanPrompt({
        brief: deps.brief,
        workspaceRoot: deps.workspaceRoot,
        ...(deps.designContext ? { designContext: deps.designContext } : {}),
        ...(existingPages.length > 0 ? { existingPages } : {})
      })
      const planDisplay = deps.labels?.plan?.(deps.brief) ?? `Plan a multi-page design: ${deps.brief}`
      const status = await runTurn({
        sendMessage: deps.sendMessage,
        prompt: planPrompt,
        overrides: overrides(planDisplay),
        signal,
        timeoutMs: PLAN_TIMEOUT_MS,
        onSendSettled: settleFirstSend,
        beforeSend: deps.onFirstSendStarting,
        identity
      })
      if (status === 'cancelled' || status === 'context-changed') return
      if (status === 'send-failed') {
        fail('Could not start the multi-page planning turn.')
        return
      }
      if (status === 'timeout') {
        fail('The page-planning step timed out.')
        return
      }
      await delay(300)
      if (!contextMatches()) return
      plan = parsePagesPlan(assistantTextForLastTurn(identity), { max: DESIGN_PAGES_MAX })
    }
    if (plan.length === 0) {
      // The planner produced nothing parseable — degrade to a single page.
      plan = [{ title: deps.brief.slice(0, 40) || 'Design', brief: deps.brief }]
    }

    // 2) Foundation assets. The design system is a project-level structured
    // file, not an agent-generated HTML artifact. Reuse it when it already exists.
    if (withFoundation) {
      if (signal.cancelled || !contextMatches()) return
      const structuredSystem = await window.kunGui?.readWorkspaceFile?.({
        path: PROJECT_DESIGN_MD_PATH,
        workspaceRoot: deps.workspaceRoot
      }).catch(() => null)
      if (!contextMatches()) return
      if (structuredSystem?.ok && (await parseProjectDesignMdWithOfficialLint(structuredSystem.content, { truncated: structuredSystem.truncated })).ok) {
        designSystemRef = PROJECT_DESIGN_MD_PATH
      }

      if (signal.cancelled || !contextMatches()) return
      const existingLogo = findFoundationArtifact(designPagesRunArtifacts(identity), 'logo')
      if (existingLogo) {
        foundationBuiltIds.add(existingLogo.id)
      } else {
        store.setPagesRun({
          phase: 'foundation',
          step: 'logo',
          total: 0,
          done: 0,
          title: deps.labels?.foundationStep?.('logo') ?? 'Logo'
        })
        const card = await createFoundationCard({
          docId,
          workspaceRoot: deps.workspaceRoot,
          role: 'logo',
          title: deps.labels?.logoTitle?.() ?? 'Logo',
          identity
        })
        if (!card) {
          fail('Design preview setup failed for the logo.')
          return
        }
        const logoPrompt = buildDesignLogoPrompt({
          brief: deps.brief,
          workspaceRoot: deps.workspaceRoot,
          artifactRelativePath: card.relativePath,
          ...(designMdRef ? { designMdPath: designMdRef } : {}),
          ...(designSystemRef ? { designSystemMdPath: designSystemRef } : {}),
          ...(deps.designContext ? { designContext: deps.designContext } : {})
        })
        const status = await runTurn({
          sendMessage: deps.sendMessage,
          prompt: logoPrompt,
          overrides: overrides(deps.labels?.logoDisplay?.() ?? 'Design the brand logo', true),
          signal,
          timeoutMs: PAGE_TIMEOUT_MS,
          artifactId: card.id,
          identity
        })
        if (status === 'cancelled' || status === 'context-changed') return
        if (status === 'send-failed') {
          fail('Could not start the logo turn.')
          return
        }
        if (status === 'timeout') {
          fail('The logo step timed out.')
          return
        }
        foundationBuiltIds.add(card.id)
      }
    }

    // 3) Create a skeleton card per page up front so they all appear immediately.
    // baseIndex already accounts for any foundation cards added above.
    if (!contextMatches()) return
    const baseIndex = designPagesRunArtifacts(identity).length
    const planTitles = plan.map((p) => `"${p.title}"`).join(', ')
    const directionCreatedAt = new Date().toISOString()
    const direction: DesignDirection = {
      id: createDesignArtifactId(),
      name: buildDirectionName(deps.brief, plan),
      status: 'active',
      createdAt: directionCreatedAt
    }
    const pageDrafts = plan.map((entry, i) => {
      const id = createDesignArtifactId()
      return {
        entry,
        id,
        relativePath: `.kun-design/${docId}/${id}/v1.html`,
        designMdPath: `.kun-design/${docId}/${id}/DESIGN.md`,
        createdAt: new Date().toISOString(),
        node: {
          ...defaultDesignArtifactNode(baseIndex + i),
          ...defaultPreviewNodeSizeForDesignTarget(deps.designContext?.designTarget)
        }
      }
    })
    const plannedPages = pageDrafts.map((page) => ({
      title: page.entry.title,
      artifactId: page.id,
      relativePath: page.relativePath
    }))
    const created: Array<ParallelDesignPageJob & { entry: DesignPagePlanEntry }> = []
    for (const page of pageDrafts) {
      if (signal.cancelled || !contextMatches()) return
      const entry = page.entry
      const prototypeLinks = buildPrototypeLinksForPage(entry, page.relativePath, plannedPages)
      useDesignWorkspaceStore.getState().upsertArtifact({
        id: page.id,
        kind: 'html',
        title: entry.title,
        relativePath: page.relativePath,
        createdAt: page.createdAt,
        updatedAt: page.createdAt,
        versions: [
          {
            id: `${page.id}-v1`,
            relativePath: page.relativePath,
            createdAt: page.createdAt,
            summary: entry.brief
          }
        ],
        designMdPath: page.designMdPath,
        previewStatus: 'pending',
        node: page.node,
        direction,
        ...(prototypeLinks.length > 0 ? { prototypeLinks } : {})
      })
      if (
        !contextMatches() ||
        !designPagesRunArtifacts(identity).some((artifact) => artifact.id === page.id)
      ) return
      const prep = await prepareDesignPreviewFile(deps.workspaceRoot, page.relativePath)
      if (!contextMatches()) return
      if (!prep.ok) {
        fail(`Design preview setup failed: ${prep.message}`)
        return
      }
      created.push({
        artifactId: page.id,
        title: entry.title,
        relativePath: page.relativePath,
        designMdPath: page.designMdPath,
        brief: entry.brief,
        screenManifest: [],
        entry
      })
    }

    // 4) Generate pages in parallel. The parent design agent only delegates:
    // every child gets one pre-created artifact path and may edit ONLY that
    // page's HTML + DESIGN.md. `delegate_task` calls from one assistant message
    // run in a parallel batch in Kun's AgentLoop.
    const foundationLines = buildFoundationFollowLines({
      ...(designMdRef ? { designMdPath: designMdRef } : {}),
      ...(designSystemRef ? { designSystemMdPath: designSystemRef } : {})
    })
    const foundationBlock = foundationLines.length > 0 ? `${foundationLines.join('\n')}\n\n` : ''
    const createdIds = new Set(created.map((page) => page.artifactId))
    const readable = designPagesRunArtifacts(identity)
      .filter((a) => foundationBuiltIds.has(a.id) || createdIds.has(a.id))
    const jobs: ParallelDesignPageJob[] = created.map((page, i) => {
      const projectContext =
        created.length > 1
          ? `This is page ${i + 1} of ${created.length} in one app. All pages: ${planTitles}. Keep ONE cohesive design system across them; design ONLY this page now.\n\n`
          : ''
      const productBriefLines = formatPageProductBriefLines(page.entry)
      const productBriefContext = productBriefLines.length > 0 ? `${productBriefLines.join('\n')}\n\n` : ''
      const flowLines = formatPageFlowLines(page.entry, page.relativePath, plannedPages)
      const flowContext = flowLines.length > 0 ? `${flowLines.join('\n')}\n\n` : ''
      return {
        artifactId: page.artifactId,
        title: page.title,
        relativePath: page.relativePath,
        designMdPath: page.designMdPath,
        brief: `${foundationBlock}${projectContext}${productBriefContext}${flowContext}${page.entry.brief}`,
        screenManifest: buildHtmlSiblingManifest(readable, page.artifactId)
      }
    })

    if (jobs.length > 0) {
      if (!contextMatches()) return
      useDesignWorkspaceStore.getState().setParallelPageStates(
        jobs.map((job) => ({ artifactId: job.artifactId, status: 'queued' }))
      )
      useDesignWorkspaceStore.getState().setPagesRun({
        phase: 'generating',
        total: jobs.length,
        done: 0,
        title: jobs[0]?.title ?? 'Parallel pages'
      })
      useDesignWorkspaceStore.getState().setActiveArtifact(jobs[0].artifactId)

      const toolArtifactIds = new Map<string, string>()
      const unsubscribe = useChatStore.subscribe(() => {
        syncParallelPageStates(jobs, toolArtifactIds, identity)
      })
      const prompt = buildParallelDesignPagesPrompt({
        workspaceRoot: deps.workspaceRoot,
        jobs,
        projectBrief: deps.brief,
        ...(deps.generationPrompt ? { customPrompt: deps.generationPrompt } : {}),
        ...(deps.designContext ? { designContext: deps.designContext } : {})
      })
      let sent = false
      let status: 'complete' | 'timeout' | 'cancelled' | 'context-changed' = 'complete'
      try {
        if (!designPagesRunCanStartTurn(identity)) return
        sent = await deps.sendMessage(
          prompt,
          'agent',
          overrides(`Design ${jobs.length} pages in parallel`, true)
        )
        if (sent) status = await waitForTurnComplete(signal, PARALLEL_PAGES_TIMEOUT_MS, identity)
      } finally {
        unsubscribe()
      }
      if (!sent) {
        fail('Could not start the parallel page generation turn.')
        return
      }
      if (status === 'cancelled' || status === 'context-changed') return
      const finalStates = syncParallelPageStates(jobs, toolArtifactIds, identity)
      if (!finalStates) return
      if (status === 'timeout') {
        fail('Parallel page generation timed out.')
        return
      }
      for (const job of jobs) {
        const state = finalStates.find((item) => item.artifactId === job.artifactId)
        const summary = extractAgentDesignSummary(state?.summary ?? '') || state?.summary?.trim()
        if (summary) {
          useDesignWorkspaceStore.getState().setVersionSummary(job.artifactId, `${job.artifactId}-v1`, summary)
        }
      }
      const failed = finalStates.filter((state) => state.status === 'failed')
      if (failed.length > 0) {
        const names = failed
          .map((state) => jobs.find((job) => job.artifactId === state.artifactId)?.title ?? state.artifactId)
          .join(', ')
        fail(`Parallel page generation failed for: ${names}`)
      }
    }

    // Land on the primary (first) page so the canvas focuses something finished.
    if (created.length > 0 && contextMatches()) {
      useDesignWorkspaceStore.getState().setActiveArtifact(created[0].artifactId)
    }

    if (!signal.cancelled && contextMatches()) {
      const state = useDesignWorkspaceStore.getState()
      const targetDoc = state.documents.find((doc) => doc.id === identity.documentId)
      await writeWorkspaceTextFile(
        deps.workspaceRoot,
        STITCH_DESIGN_MD_PATH,
        buildStitchDesignMarkdown({
          title: targetDoc?.title,
          brief: deps.brief,
          ...(deps.designContext ? { designContext: deps.designContext } : {}),
          designSystem: useDesignSystemStore.getState().system,
          designSystemMdPath: designSystemRef ?? PROJECT_DESIGN_MD_PATH,
          ...(designMdRef ? { projectBriefPath: designMdRef } : {}),
          artifacts: targetDoc?.artifacts ?? []
        })
      )
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  } finally {
    settleFirstSend(false)
    finishDesignPagesRun(signal)
    useDesignWorkspaceStore.getState().setPagesRun(null)
  }
}
