import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GRAPH_CONTRACT_VERSION } from '../contracts/graph.js'
import { FileProjectAgentRegistry } from './project-agent-registry.js'
import { testGraphConfig } from './graph-test-fixtures.test-support.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('FileProjectAgentRegistry', () => {
  it.runIf(process.platform === 'win32')(
    'uses one project identity for Windows path casing variants',
    async () => {
      const parent = await mkdtemp(join(tmpdir(), 'kun-graph-project-case-'))
      const workspace = join(parent, 'GraphWorkspace')
      const alternate = join(parent, 'graphworkspace')
      const root = await mkdtemp(join(tmpdir(), 'kun-graph-registry-case-'))
      await mkdir(workspace)
      roots.push(parent, root)
      const registry = new FileProjectAgentRegistry({
        rootDir: root,
        config: () => testGraphConfig()
      })
      expect((await registry.identify(alternate)).projectId)
        .toBe((await registry.identify(workspace)).projectId)
    }
  )

  it('uses stable project identity, hard eligibility, and explainable evidence ranking', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-graph-project-'))
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-registry-'))
    roots.push(workspace, root)
    let id = 0
    const registry = new FileProjectAgentRegistry({
      rootDir: root,
      config: () => testGraphConfig({ routing: { minTaskFit: 0 } }),
      nextId: (prefix) => `${prefix}_${++id}`
    })
    const identity = await registry.identify(workspace)
    expect((await registry.identify(workspace)).projectId).toBe(identity.projectId)
    const now = new Date().toISOString()
    await registry.saveProfile(identity, {
      version: GRAPH_CONTRACT_VERSION,
      profileId: 'read_reviewer',
      profileVersion: 1,
      origin: 'user',
      lifecycle: 'trusted',
      name: 'TypeScript Reviewer',
      description: 'Reviews TypeScript implementation and tests',
      systemPrompt: 'Review TypeScript code.',
      model: 'test-model',
      providerId: 'default',
      reasoningEffort: 'off',
      capabilities: {
        taskTypes: ['review'],
        capabilityTags: ['typescript', 'testing'],
        toolPolicy: 'readOnly',
        allowedTools: ['read'],
        blockedTools: [],
        allowedSkills: [],
        blockedSkills: [],
        allowedMcpServers: [],
        blockedMcpServers: [],
        approvalPolicy: 'never',
        sandboxMode: 'read-only',
        readScopes: ['.'],
        writeScopes: [],
        networkAllowed: false,
        maximumRiskClass: 'medium'
      },
      provenanceEpisodeIds: [],
      createdAt: now,
      createdBy: 'user'
    }, 'test profile')
    await registry.saveProfile(identity, {
      version: GRAPH_CONTRACT_VERSION,
      profileId: 'writer',
      profileVersion: 1,
      origin: 'user',
      lifecycle: 'trusted',
      name: 'Writer',
      description: 'Writes implementation files',
      systemPrompt: 'Implement changes.',
      model: 'test-model',
      providerId: 'default',
      reasoningEffort: 'off',
      capabilities: {
        taskTypes: ['work'],
        capabilityTags: ['typescript'],
        toolPolicy: 'inherit',
        allowedTools: ['read', 'write'],
        blockedTools: [],
        allowedSkills: [],
        blockedSkills: [],
        allowedMcpServers: [],
        blockedMcpServers: [],
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        readScopes: ['.'],
        writeScopes: ['src'],
        networkAllowed: false,
        maximumRiskClass: 'high'
      },
      provenanceEpisodeIds: [],
      createdAt: now,
      createdBy: 'user'
    }, 'test profile')
    const routed = await registry.route(identity, {
      version: GRAPH_CONTRACT_VERSION,
      projectId: identity.projectId,
      taskType: 'review',
      query: 'Review TypeScript tests',
      riskClass: 'low',
      requiredTools: ['read'],
      requiredSkills: [],
      requiredMcpServers: [],
      readScopes: ['src'],
      writeScopes: [],
      networkRequired: false,
      modelCapabilityTags: []
    })
    expect(routed.profile?.profileId).toBe('read_reviewer')
    expect(routed.explanation.recalled[0]?.score).toMatchObject({
      profileId: 'read_reviewer',
      evidenceCount: 0
    })
    const writeRoute = await registry.route(identity, {
      ...routed.explanation.request,
      taskType: 'work',
      query: 'Implement TypeScript source',
      requiredTools: ['write'],
      writeScopes: ['src']
    })
    expect(writeRoute.profile?.profileId).toBe('writer')
    expect(writeRoute.explanation.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ profileId: 'read_reviewer' })
    ]))
  })

  it('persists score dimensions and supports audited import, merge, disable, restore, and delete', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-graph-project-'))
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-registry-'))
    roots.push(workspace, root)
    let id = 0
    const registry = new FileProjectAgentRegistry({
      rootDir: root,
      config: () => testGraphConfig({ routing: { minTaskFit: 0 } }),
      nextId: (prefix) => `${prefix}_${++id}`
    })
    const identity = await registry.identify(workspace)
    const first = profile('agent_one', ['read', 'write'], ['src'], ['src/generated'])
    const second = profile('agent_two', ['read'], ['src/feature'], [])
    await registry.saveProfile(identity, first, 'first profile')
    await registry.saveProfile(identity, second, 'second profile')
    await registry.recordProfileExport(identity.projectId, first)

    await registry.route(identity, {
      version: GRAPH_CONTRACT_VERSION,
      projectId: identity.projectId,
      taskType: 'work',
      query: 'typescript work',
      riskClass: 'low',
      requiredTools: ['read'],
      requiredSkills: [],
      requiredMcpServers: [],
      readScopes: ['src/feature'],
      writeScopes: [],
      networkRequired: false,
      modelCapabilityTags: ['typescript']
    })
    expect(await registry.listScores(identity.projectId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        profileId: 'agent_one',
        taskFit: expect.any(Number),
        quality: expect.any(Number),
        trust: expect.any(Number),
        freshness: expect.any(Number),
        efficiency: expect.any(Number),
        confidence: expect.any(Number),
        availability: expect.any(Number),
        load: expect.any(Number),
        aggregate: expect.any(Number)
      })
    ]))

    const imported = await registry.importProfile(identity, first, 'portable import')
    expect(imported).toMatchObject({
      profileId: 'agent_one',
      profileVersion: 2,
      origin: 'user',
      lifecycle: 'candidate'
    })
    const merged = await registry.mergeProfiles(
      identity,
      ['agent_one', 'agent_two'],
      'merged_agent',
      'Merged Agent',
      'merge duplicate specialists'
    )
    expect(merged).toMatchObject({
      profileId: 'merged_agent',
      lifecycle: 'candidate',
      aliasProfileIds: ['agent_one', 'agent_two'],
      capabilities: {
        allowedTools: ['read'],
        readScopes: ['src/feature'],
        writeScopes: [],
        networkAllowed: false
      }
    })
    expect(await registry.getProfile(identity.projectId, 'agent_one')).toMatchObject({
      profileId: 'merged_agent',
      lifecycle: 'candidate'
    })
    await registry.transitionProfile(identity, 'merged_agent', 'probation', 'begin probation')
    await registry.transitionProfile(identity, 'merged_agent', 'trusted', 'promote')
    await registry.transitionProfile(identity, 'merged_agent', 'dormant', 'disable')
    await registry.transitionProfile(identity, 'merged_agent', 'trusted', 'restore')
    await registry.transitionProfile(identity, 'merged_agent', 'archived', 'archive')
    await registry.transitionProfile(identity, 'merged_agent', 'deleted', 'delete')
    expect((await registry.listAudit(identity.projectId)).map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        'export',
        'import',
        'merge',
        'promote',
        'disable',
        'restore',
        'archive',
        'delete'
      ])
    )
  })

  it('penalizes only relevant missed opportunities and automatically dormants with an audit trail', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-graph-project-'))
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-registry-'))
    roots.push(workspace, root)
    let id = 0
    const registry = new FileProjectAgentRegistry({
      rootDir: root,
      config: () => testGraphConfig({
        routing: {
          minTaskFit: 0.4,
          dormantMissedOpportunityThreshold: 2
        }
      }),
      nextId: (prefix) => `${prefix}_${++id}`
    })
    const identity = await registry.identify(workspace)
    await registry.saveProfile(identity, profile('specialist', ['read'], ['src'], []), 'seed')
    const initialRoute = await registry.route(identity, {
      version: GRAPH_CONTRACT_VERSION,
      projectId: identity.projectId,
      taskType: 'work',
      query: 'TypeScript work',
      riskClass: 'low',
      requiredTools: ['read'],
      requiredSkills: [],
      requiredMcpServers: [],
      readScopes: ['src'],
      writeScopes: [],
      networkRequired: false,
      modelCapabilityTags: []
    })
    expect(initialRoute.profile?.profileId).toBe('specialist')
    const evidence = (
      evidenceId: string,
      patch: Partial<{
        eligible: boolean
        recalled: boolean
        selected: boolean
        taskFit: number
      }>
    ) => ({
      version: GRAPH_CONTRACT_VERSION,
      evidenceId,
      profileId: 'specialist',
      profileVersion: 1,
      runId: `run_${evidenceId}`,
      nodeId: 'routing',
      taskFingerprint: 'a'.repeat(64),
      source: 'missed_opportunity' as const,
      outcome: 'neutral' as const,
      quality: 0.7,
      costTokens: 0,
      latencyMs: 0,
      eligible: false,
      recalled: false,
      selected: false,
      taskFit: 0,
      summary: 'routing observation',
      createdAt: new Date().toISOString(),
      ...patch
    })

    await registry.recordEvidence(identity, evidence('irrelevant', {}))
    expect((await registry.getProfile(identity.projectId, 'specialist'))?.lifecycle).toBe('trusted')
    expect((await registry.listScores(identity.projectId))
      .find((score) => score.profileId === 'specialist')?.missedOpportunities).toBe(0)
    const unpenalizedAggregate = (await registry.listScores(identity.projectId))
      .find((score) => score.profileId === 'specialist')!.aggregate

    await registry.recordEvidence(identity, evidence('relevant_1', {
      eligible: true,
      recalled: true,
      taskFit: 0.8
    }))
    const penalized = (await registry.listScores(identity.projectId))
      .find((score) => score.profileId === 'specialist' && score.profileVersion === 1)
    expect(penalized?.missedOpportunities).toBe(1)
    expect(penalized!.aggregate).toBeLessThan(unpenalizedAggregate)

    await registry.recordEvidence(identity, evidence('relevant_2', {
      eligible: true,
      recalled: true,
      taskFit: 0.8
    }))
    const dormant = await registry.getProfile(identity.projectId, 'specialist')
    expect(dormant).toMatchObject({ profileVersion: 2, lifecycle: 'dormant' })
    expect(await registry.listAudit(identity.projectId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actor: 'system',
        action: 'disable',
        targetId: 'specialist',
        reason: expect.stringContaining('2 relevant recalled opportunities')
      })
    ]))
  })

  it('routes probation profiles only through sampled low-risk read-only evaluation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-graph-project-probation-'))
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-registry-probation-'))
    roots.push(workspace, root)
    const registry = new FileProjectAgentRegistry({
      rootDir: root,
      config: () => testGraphConfig({
        routing: { minTaskFit: 0, explorationRatio: 1 }
      })
    })
    const identity = await registry.identify(workspace)
    await registry.saveProfile(identity, {
      ...profile('probation_reader', ['read'], ['src'], []),
      lifecycle: 'probation'
    }, 'start safe probation')
    const request = {
      version: GRAPH_CONTRACT_VERSION,
      projectId: identity.projectId,
      taskType: 'work',
      query: 'Review TypeScript source',
      riskClass: 'low' as const,
      requiredTools: ['read'],
      requiredSkills: [],
      requiredMcpServers: [],
      readScopes: ['src'],
      writeScopes: [],
      networkRequired: false,
      modelCapabilityTags: []
    }

    expect((await registry.route(identity, {
      ...request,
      probationEligible: true
    })).profile?.profileId).toBe('probation_reader')
    expect((await registry.route(identity, request)).explanation.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profileId: 'probation_reader',
          reason: expect.stringContaining('not eligible')
        })
      ])
    )
    expect((await registry.route(identity, {
      ...request,
      probationEligible: true,
      writeScopes: ['src/generated']
    })).explanation.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({
        profileId: 'probation_reader',
        reason: expect.stringContaining('low-risk read-only')
      })
    ]))
  })

  it('compacts expired audit history while retaining the latest explanation per target', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-graph-project-'))
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-registry-'))
    roots.push(workspace, root)
    let current = '2026-07-20T00:00:00.000Z'
    let id = 0
    const registry = new FileProjectAgentRegistry({
      rootDir: root,
      config: () => testGraphConfig({ retention: { auditDays: 1 } }),
      nowIso: () => current,
      nextId: (prefix) => `${prefix}_${++id}`
    })
    const identity = await registry.identify(workspace)
    const first = {
      ...profile('versioned_agent', ['read'], ['src'], []),
      createdAt: current
    }
    await registry.saveProfile(identity, first, 'old version')
    current = '2026-07-26T00:00:00.000Z'
    await registry.saveProfile(identity, {
      ...first,
      profileVersion: 2,
      description: 'Updated TypeScript work profile',
      supersedesVersion: 1,
      rollbackVersion: 1,
      createdAt: current
    }, 'current version')

    expect(await registry.listAudit(identity.projectId)).toHaveLength(2)
    await expect(registry.compactRetention(identity.projectId))
      .resolves.toEqual({ auditRemoved: 1 })
    expect(await registry.listAudit(identity.projectId)).toEqual([
      expect.objectContaining({
        targetId: 'versioned_agent',
        reason: 'current version'
      })
    ])
  })

  it('keeps recall bounded while routing across a thousand project agents', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-graph-project-scale-'))
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-registry-scale-'))
    roots.push(workspace, root)
    const config = testGraphConfig({ routing: { recallLimit: 12, minTaskFit: 0 } })
    const registry = new FileProjectAgentRegistry({
      rootDir: root,
      config: () => config
    })
    const identity = await registry.identify(workspace)
    const profiles = Array.from({ length: 1_000 }, (_, index) => ({
      ...profile(`agent_${String(index).padStart(4, '0')}`, ['read'], ['src'], []),
      description: index === 777
        ? 'Specialized unicorn protocol reviewer'
        : 'General TypeScript work profile'
    }))
    const projectDir = join(root, identity.projectId)
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, 'registry.json'), `${JSON.stringify({
      version: GRAPH_CONTRACT_VERSION,
      identity,
      profiles,
      evidence: [],
      explanations: [],
      candidates: [],
      scores: [],
      audit: [],
      updatedAt: new Date().toISOString()
    })}\n`)

    const startedAt = performance.now()
    const routed = await registry.route(identity, {
      version: GRAPH_CONTRACT_VERSION,
      projectId: identity.projectId,
      taskType: 'work',
      query: 'Review the specialized unicorn protocol',
      riskClass: 'low',
      requiredTools: ['read'],
      requiredSkills: [],
      requiredMcpServers: [],
      readScopes: ['src'],
      writeScopes: [],
      networkRequired: false,
      modelCapabilityTags: []
    })

    expect(routed.profile?.profileId).toBe('agent_0777')
    expect(routed.explanation.recalled.length).toBeLessThanOrEqual(12)
    expect(await registry.listProfiles(identity.projectId)).toHaveLength(1_000)
    expect(performance.now() - startedAt).toBeLessThan(5_000)
  })
})

function profile(
  profileId: string,
  allowedTools: string[],
  readScopes: string[],
  writeScopes: string[]
) {
  return {
    version: GRAPH_CONTRACT_VERSION,
    profileId,
    profileVersion: 1,
    origin: 'user' as const,
    lifecycle: 'trusted' as const,
    name: profileId,
    description: 'TypeScript work profile',
    systemPrompt: 'Work only in assigned scopes.',
    model: 'test-model',
    providerId: 'default',
    reasoningEffort: 'off' as const,
    capabilities: {
      taskTypes: ['work'],
      capabilityTags: ['typescript'],
      toolPolicy: writeScopes.length ? 'inherit' as const : 'readOnly' as const,
      allowedTools,
      blockedTools: [],
      allowedSkills: [],
      blockedSkills: [],
      allowedMcpServers: [],
      blockedMcpServers: [],
      approvalPolicy: 'on-request' as const,
      sandboxMode: writeScopes.length ? 'workspace-write' as const : 'read-only' as const,
      readScopes,
      writeScopes,
      networkAllowed: false,
      maximumRiskClass: 'low' as const
    },
    provenanceEpisodeIds: [],
    createdAt: new Date().toISOString(),
    createdBy: 'user' as const
  }
}
