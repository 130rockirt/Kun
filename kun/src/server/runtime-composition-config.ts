import {
  join,
  isDeepStrictEqual,
  isLoopbackHost,
  CapabilityRegistry,
  buildGoalLocalTools,
  buildTodoLocalTools,
  buildPptMasterLocalTools,
  buildPptAgentLocalTools,
  buildDefaultLocalTools,
  createReadArtifactTool,
  buildMcpToolProviders,
  buildMemoryToolProviders,
  buildSkillToolProviders,
  buildDelegationToolProviders,
  buildComponentDesignToolProviders,
  buildWebToolProviders,
  buildImageGenToolProviders,
  protocolSupportsImageEdit,
  buildComputerUseToolProviders,
  buildBrowserUseToolProviders,
  buildOfficeCliToolProviders,
  buildMusicGenToolProviders,
  buildSpeechGenToolProviders,
  buildVideoGenToolProviders,
  buildRuntimeCapabilityManifest,
  DEFAULT_APPROVAL_REVIEWER,
  AgentLoop,
  type AgentLoopOptions,
  modelCapabilitiesForModel,
  modelContextProfilesFromConfig,
  DEFAULT_QUALITY_CONFIG,
  buildBuiltinHooks,
  mergeBuiltinSubagentProfiles,
  buildExploreAgentToolProvider,
  buildPptAgentToolProvider,
  type RuntimeConfigApplyRequest,
  type RuntimeConfigApplyResponse,
  SkillRuntime,
  InstructionRuntime,
  resolveConfiguredHooks
} from './runtime-factory-dependencies.js'
import type { createRuntimeExtensionComposition } from './runtime-composition-extensions.js'
import {
  builtinToolOptionsForOptions,
  llmDebugCaptureEnabled,
  mergeRuntimeConfigApplyOptions,
  modelRequestCaptureDefaultEnabled,
  tokenEconomyConfigForOptions
} from './runtime-factory-config.js'
import {
  buildModelClientRouterInput,
  hydrateLegacyCredentialOptions,
  modelConnectionSeedsForOptions,
  modelContextProfilesByProvider
} from './runtime-factory-model.js'
import {
  createPersistentAttachmentStore,
  createPersistentMemoryStore
} from './runtime-factory-storage.js'

export function createRuntimeConfigController(
  extensions: Awaited<ReturnType<typeof createRuntimeExtensionComposition>>
) {
  const { agent } = extensions
  const { registryComposition } = agent
  const { services } = registryComposition
  const { model } = services
  const { core } = model
  const {
    nowIso,
    llmDebug,
    threadService,
    graphRuntime,
    graphToolsProvider,
    modelCapabilities
  } = core
  const {
    refreshDelegatedProviderIds,
    extensionCredentialKeyProvider,
    extensionModelProviders,
    legacyCredentialMigration,
    modelConnections,
    resolveLegacyRequestCredentials,
    migrateLegacyProviderCredentials,
    buildApprovalReviewClients,
    directModelClient,
    approvalReviewModelClient,
    modelClient,
    timedModelClient,
    subagentRouter,
    resolveCapabilityProviderCredential,
    oauthEncryptor
  } = model
  const {
    turnService,
    withBackgroundShellTools,
    reviewService,
    pruneUnsentAttachments,
    designCanvasProvider,
    taskGraphTool,
    childToolHost
  } = services
  const { delegationRuntime } = registryComposition
  const {
    toolHost,
    extensionTools,
    buildMainDelegatedRuntime,
    sdkRuntime,
    extensionAgent
  } = agent
  const { extensionPreparations } = extensions
  let activeOptions = core.activeOptions
  let modelProfiles = core.modelProfiles
  let providerModelProfiles = core.providerModelProfiles
  let tokenEconomy = core.tokenEconomy
  let mcpProviders = services.mcpProviders
  let skillRuntime = services.skillRuntime
  let instructionRuntime = services.instructionRuntime
  let attachmentStore = services.attachmentStore
  let memoryStore = services.memoryStore
  let webProviders = services.webProviders
  let imageGenProviders = services.imageGenProviders
  let speechGenProviders = services.speechGenProviders
  let musicGenProviders = services.musicGenProviders
  let videoGenProviders = services.videoGenProviders
  let computerUseProviders = services.computerUseProviders
  let browserUseProviders = services.browserUseProviders
  let baseToolProviders = services.baseToolProviders
  let resolvedHooks = services.resolvedHooks
  let childRegistry = services.childRegistry
  let registry = registryComposition.registry
  let capabilities = registryComposition.capabilities
  let loopOptions = agent.loopOptions
  let loop = agent.loop
	  const startedAt = activeOptions.startedAt ?? nowIso()
	  const rebuildCapabilities = (): typeof capabilities => buildRuntimeCapabilityManifest({
	    config: activeOptions.capabilities,
	    model: modelCapabilities(activeOptions.model),
	    mcp: {
	      configuredServers: Object.keys(activeOptions.capabilities?.mcp.servers ?? {}).length,
	      connectedServers: mcpProviders.connectedServers,
	      toolCount: mcpProviders.toolCount,
	      lastError: mcpProviders.diagnostics.find((diagnostic) => diagnostic.lastError)?.lastError,
	      search: {
	        active: mcpProviders.search.active,
	        indexedToolCount: mcpProviders.search.indexedToolCount,
	        advertisedToolCount: mcpProviders.search.advertisedToolCount
	      }
	    },
	    web: {
	      fetchAvailable: webProviders.fetchAvailable,
	      searchAvailable: webProviders.searchAvailable,
	      provider: webProviders.provider,
	      reason: webProviders.diagnostics.find((diagnostic) => diagnostic.reason)?.reason
	    },
	    skills: {
	      configuredRoots: activeOptions.capabilities?.skills.roots.length,
	      discoveredSkills: skillRuntime.count(),
	      reason: skillRuntime.diagnostics().validationErrors[0]?.message
	    },
	    instructions: {
	      available: instructionRuntime.enabled(),
	      lastSourceCount: instructionRuntime.diagnostics().lastInjection?.sources.length ?? 0,
	      lastInjectedBytes: instructionRuntime.diagnostics().lastInjection?.injectedBytes ?? 0
	    },
	    attachments: {
	      available: Boolean(attachmentStore)
	    },
	    memory: {
	      available: Boolean(memoryStore)
	    },
	    subagents: {
	      available: Boolean(delegationRuntime?.enabled())
	    },
	    imageGen: {
	      available: imageGenProviders.available,
	      reason: imageGenProviders.diagnostics.find((diagnostic) => diagnostic.reason)?.reason
	    },
	    speechGen: {
	      available: speechGenProviders.available,
	      reason: speechGenProviders.diagnostics.find((diagnostic) => diagnostic.reason)?.reason
	    },
	    musicGen: {
	      available: musicGenProviders.available,
	      reason: musicGenProviders.diagnostics.find((diagnostic) => diagnostic.reason)?.reason
	    },
	    videoGen: {
	      available: videoGenProviders.available,
	      reason: videoGenProviders.diagnostics.find((diagnostic) => diagnostic.reason)?.reason
	    },
	    computerUse: {
	      available: computerUseProviders.available,
	      reason: computerUseProviders.diagnostics.find((diagnostic) => diagnostic.reason)?.reason
	    },
	    browserUse: {
	      available: browserUseProviders.available,
	      interactionRequired: browserUseProviders.interactionRequired,
	      reason: browserUseProviders.reason
	    }
	  })
	  let applyConfigQueue: Promise<RuntimeConfigApplyResponse> = Promise.resolve({ ok: true })
	  const applyConfig = (request: RuntimeConfigApplyRequest): Promise<RuntimeConfigApplyResponse> => {
	    const task = applyConfigQueue
	      .catch(() => ({ ok: true }) as RuntimeConfigApplyResponse)
	      .then(() => applyConfigOnce(request))
	    applyConfigQueue = task
	    return task
	  }
	  const applyConfigOnce = async (
	    request: RuntimeConfigApplyRequest
	  ): Promise<RuntimeConfigApplyResponse> => {
	    if (
	      request.serve?.observability !== undefined &&
	      !isDeepStrictEqual(request.serve.observability, activeOptions.observability ?? {})
	    ) {
	      return {
	        ok: false,
	        code: 'restart_required',
	        message: 'observability exporter changes require a runtime restart'
	      }
	    }
	    const mergedOptions = mergeRuntimeConfigApplyOptions(activeOptions, request)
	    if (llmDebugCaptureEnabled(mergedOptions) !== llmDebugCaptureEnabled(activeOptions)) {
	      return {
	        ok: false,
	        code: 'restart_required',
	        message: 'Agent Perspective capture changes require a runtime restart'
	      }
	    }
	    let nextOptions = await hydrateLegacyCredentialOptions(
	      mergedOptions,
	      legacyCredentialMigration
	    )
	    if (nextOptions.localModelGateway?.enabled && !isLoopbackHost(nextOptions.host)) {
	      return {
	        ok: false,
	        code: 'invalid_config',
	        message: 'unauthenticated local model gateway requires a loopback serve host'
	      }
	    }
	    const nextSubagentsEnabled = nextOptions.capabilities?.subagents.enabled === true
	    if (nextSubagentsEnabled && !delegationRuntime) {
	      return {
	        ok: false,
	        code: 'restart_required',
	        message: 'enabling subagents requires a runtime restart'
	      }
	    }

	    const nextModelProfiles = modelContextProfilesFromConfig({
	      contextCompaction: nextOptions.contextCompaction,
	      models: nextOptions.models
	    })
	    const nextProviderModelProfiles = modelContextProfilesByProvider(nextOptions.providers)
	    const nextTokenEconomy = tokenEconomyConfigForOptions(nextOptions)
	    const nextMcpHasOAuth = Object.values(nextOptions.capabilities?.mcp?.servers ?? {}).some((server) =>
	      server.oauth?.enabled !== false && Boolean(server.oauth) && server.transport !== 'stdio'
	    )
	    const nextOAuthEncryptor = nextMcpHasOAuth
	      ? extensionCredentialKeyProvider.encryptor
	      : undefined
	    const [nextMcpProviders, nextSkillRuntime] = await Promise.all([
	      buildMcpToolProviders(nextOptions.capabilities?.mcp, {
	        oauthStorageDir: join(activeOptions.dataDir, 'mcp-oauth'),
	        ...(nextOAuthEncryptor ? { oauthEncryptor: nextOAuthEncryptor } : {})
	      }),
	      SkillRuntime.create(nextOptions.capabilities?.skills)
	    ])
	    let stagedGenerationCommitted = false
	    try {
	    const nextInstructionRuntime = new InstructionRuntime(
	      nextOptions.capabilities?.instructions
	    )
	    const nextAttachmentStore = createPersistentAttachmentStore(nextOptions, nowIso)
	    await pruneUnsentAttachments(nextAttachmentStore)
	    const nextMemoryStore = createPersistentMemoryStore(nextOptions, nowIso)
	    const nextWebProviders = buildWebToolProviders(nextOptions.capabilities?.web)
	    const nextImageGenProviders = buildImageGenToolProviders(nextOptions.capabilities?.imageGen, {
	      attachmentStore: nextAttachmentStore,
	      nowIso,
	      resolveCredential: resolveCapabilityProviderCredential
	    })
	    const nextSpeechGenProviders = buildSpeechGenToolProviders(nextOptions.capabilities?.speechGen, {
	      nowIso,
	      resolveCredential: resolveCapabilityProviderCredential
	    })
	    const nextMusicGenProviders = buildMusicGenToolProviders(nextOptions.capabilities?.musicGen, {
	      nowIso,
	      resolveCredential: resolveCapabilityProviderCredential
	    })
	    const nextVideoGenProviders = buildVideoGenToolProviders(nextOptions.capabilities?.videoGen, {
	      nowIso,
	      resolveCredential: resolveCapabilityProviderCredential
	    })
	    const nextComputerUseProviders = await buildComputerUseToolProviders(nextOptions.capabilities?.computerUse)
	    const nextBrowserUseProviders = buildBrowserUseToolProviders(nextOptions.capabilities?.browserUse)
	    const nextPptMasterProvider = {
	      id: 'ppt-master',
	      kind: 'skill' as const,
	      enabled: true,
	      available: true,
	      tools: [
	        ...buildPptMasterLocalTools(),
	        ...buildPptAgentLocalTools({
	          enabled: () => nextOptions.lab?.pptAgent?.enabled !== false,
	          toolchainDirectory: () => process.env.KUN_PPT_TOOLCHAIN_DIR
	        })
	      ]
	    }
	    const nextResolvedHooks = [
	      ...buildBuiltinHooks({ quality: nextOptions.quality ?? DEFAULT_QUALITY_CONFIG }),
	      ...resolveConfiguredHooks(nextOptions.hooks)
	    ]
	    const nextOfficeCliProviders = buildOfficeCliToolProviders({
	      binaryPath: process.env.KUN_OFFICECLI_BINARY,
	      profileDir: join(nextOptions.dataDir, 'officecli-profile')
	    })
	    const nextBaseToolProviders = [
	      {
	        id: 'builtin',
	        kind: 'built-in' as const,
	        enabled: true,
	        available: true,
	        tools: withBackgroundShellTools(
	          buildDefaultLocalTools({}, builtinToolOptionsForOptions(nextOptions)),
	          nextOptions
	        )
	      },
	      {
	        id: 'artifacts',
	        kind: 'built-in' as const,
	        enabled: true,
	        available: true,
	        tools: [createReadArtifactTool()]
	      },
	      graphToolsProvider,
	      ...nextMcpProviders.providers,
	      ...nextWebProviders.providers,
	      ...buildMemoryToolProviders(nextMemoryStore),
	      ...buildSkillToolProviders(nextSkillRuntime),
	      ...nextImageGenProviders.providers,
	      ...nextSpeechGenProviders.providers,
	      ...nextMusicGenProviders.providers,
	      ...nextVideoGenProviders.providers,
	      ...nextOfficeCliProviders,
	      nextPptMasterProvider,
	      designCanvasProvider
	    ]
	    const nextChildRegistry = new CapabilityRegistry(nextBaseToolProviders)
	    const nextRegistry = new CapabilityRegistry([
	      ...nextBaseToolProviders,
	      ...nextComputerUseProviders.providers,
	      ...nextBrowserUseProviders.providers,
	      {
	        id: 'goal',
	        kind: 'built-in' as const,
	        enabled: true,
	        available: true,
	        tools: buildGoalLocalTools(threadService)
	      },
	      {
	        id: 'todo',
	        kind: 'built-in' as const,
	        enabled: true,
	        available: true,
	        tools: buildTodoLocalTools(threadService)
	      },
	      {
	        id: 'planning',
	        kind: 'built-in' as const,
	        enabled: true,
	        available: true,
	        tools: [taskGraphTool]
	      },
	      ...buildDelegationToolProviders(delegationRuntime, subagentRouter),
	      ...buildExploreAgentToolProvider(
	        delegationRuntime,
	        () => activeOptions.lab?.exploreAgent
	      ),
	      ...buildPptAgentToolProvider(
	        delegationRuntime,
	        () => ({
	          ...nextOptions.lab?.pptAgent,
	          imageGenAvailable: nextImageGenProviders.available,
	          imageGenReason: nextImageGenProviders.diagnostics.find((diagnostic) => diagnostic.reason)?.reason,
	          imageGenSupportsReferenceEdit: protocolSupportsImageEdit(nextOptions.capabilities?.imageGen?.protocol)
	        })
	      ),
	      ...buildComponentDesignToolProviders(delegationRuntime)
	    ])

	    // Import provider catalogs for rolling GUI compatibility, but preserve
	    // the registry-owned default. Current GUI/TUI clients use revisioned
	    // registry writes directly; this path only adds/reconciles catalogs.
	    const registryBeforeApply = await modelConnections.snapshot()
	    await modelConnections.initialize(modelConnectionSeedsForOptions(nextOptions))
	    if (registryBeforeApply.providers.length === 0 && request.modelSelection) {
	      await modelConnections.synchronizeDefaultSelection(request.modelSelection)
	    }
	    const materializedConnections = await modelConnections.materialize()
	    if (materializedConnections.providers.size > 0) {
	      const selected = materializedConnections.selected
	      nextOptions = {
	        ...nextOptions,
	        ...(selected
	          ? {
	              model: selected.model,
	              apiKey: selected.config.apiKey,
	              credentialSourceId: selected.config.credentialSourceId,
	              baseUrl: selected.config.baseUrl ?? nextOptions.baseUrl,
	              endpointFormat: selected.config.endpointFormat ?? nextOptions.endpointFormat,
	              headers: selected.config.headers,
	              geminiAuth: selected.config.geminiAuth
	            }
	          : {}),
	        providers: Object.fromEntries(materializedConnections.providers.entries()),
	        modelProxyUrl: materializedConnections.proxy.enabled
	          ? materializedConnections.proxy.url
	          : undefined,
	        routePools: materializedConnections.routePools,
	        localModelGateway: materializedConnections.localModelGateway
	      }
	    }
	    await migrateLegacyProviderCredentials(nextOptions)

	    const nextModelClients = buildModelClientRouterInput(
	      nextOptions,
	      (model) => modelCapabilitiesForModel(model, nextModelProfiles),
	      llmDebug,
	      resolveLegacyRequestCredentials
	    )
	    for (const [providerId, client] of extensionModelProviders.clientMap()) {
	      nextModelClients.providers.set(providerId, client)
	    }
	    const nextDelegatedRuntime = buildMainDelegatedRuntime({
	      options: nextOptions,
	      registry: nextRegistry,
	      skillRuntime: nextSkillRuntime,
	      instructionRuntime: nextInstructionRuntime,
	      attachmentStore: nextAttachmentStore,
	      memoryStore: nextMemoryStore
	    })
	    const nextLoopOptions: AgentLoopOptions = {
	      ...loopOptions,
	      skillRuntime: nextSkillRuntime,
	      instructionRuntime: nextInstructionRuntime,
	      tokenEconomy: nextTokenEconomy,
	      contextCompaction: nextOptions.contextCompaction,
	      roles: nextOptions.roles,
	      toolStorm: nextOptions.runtime?.toolStorm,
	      turnLimits: nextOptions.runtime?.turnLimits,
	      toolArgumentRepair: nextOptions.runtime?.toolArgumentRepair,
	      hooks: nextResolvedHooks,
	      attachmentStore: nextAttachmentStore,
	      memoryStore: nextMemoryStore
	    }
	    const nextLoop = new AgentLoop(nextLoopOptions)
	    const previousMcpProviders = mcpProviders
	    activeOptions = nextOptions
    core.activeOptions = activeOptions
	    await graphRuntime.reconfigureBackgroundServices()
	    modelProfiles = nextModelProfiles
	    providerModelProfiles = nextProviderModelProfiles
	    tokenEconomy = nextTokenEconomy
    core.modelProfiles = modelProfiles
    core.providerModelProfiles = providerModelProfiles
    core.tokenEconomy = tokenEconomy
	    refreshDelegatedProviderIds()
	    directModelClient.replace(nextModelClients)
	    approvalReviewModelClient.replace(
	      buildApprovalReviewClients(activeOptions, nextModelClients)
	    )
	    modelClient.replacePools(activeOptions.routePools ?? [])
	    if (delegationRuntime && activeOptions.capabilities?.subagents) {
	      delegationRuntime.replaceConfig(mergeBuiltinSubagentProfiles(activeOptions.capabilities.subagents))
	    }
	    skillRuntime = nextSkillRuntime
	    instructionRuntime = nextInstructionRuntime
	    mcpProviders = nextMcpProviders
	    webProviders = nextWebProviders
	    attachmentStore = nextAttachmentStore
	    memoryStore = nextMemoryStore
	    imageGenProviders = nextImageGenProviders
	    speechGenProviders = nextSpeechGenProviders
	    musicGenProviders = nextMusicGenProviders
	    videoGenProviders = nextVideoGenProviders
	    computerUseProviders = nextComputerUseProviders
	    browserUseProviders = nextBrowserUseProviders
	    resolvedHooks = nextResolvedHooks
	    baseToolProviders = nextBaseToolProviders
	    childRegistry = nextChildRegistry
	    registry = nextRegistry
	    extensionTools.rebindRegistry(registry)
	    childToolHost.replaceRuntimeComponents({ registry: childRegistry, hooks: resolvedHooks })
	    toolHost.replaceRuntimeComponents({ registry, hooks: resolvedHooks })
	    sdkRuntime.replace(nextDelegatedRuntime)
	    turnService.updateRuntimeConfig({
	      defaultModel: activeOptions.model,
	      contextCompaction: activeOptions.contextCompaction,
	      model: timedModelClient,
	      maxConcurrentTurns: activeOptions.runtime?.turnLimits?.maxConcurrentTurns
	    })
	    extensionAgent.updateRuntimeConfig({
	      defaultBinding: { providerId: 'default', modelId: activeOptions.model }
	    })
	    extensionPreparations.clear()
	    threadService.updateRuntimeDefaults({
	      approvalPolicy: activeOptions.approvalPolicy,
	      sandboxMode: activeOptions.sandboxMode,
	      approvalReviewer: activeOptions.approvalReviewer ?? DEFAULT_APPROVAL_REVIEWER,
	      modelRequestCaptureEnabled: modelRequestCaptureDefaultEnabled(activeOptions)
	    })
	    reviewService.updateRuntimeConfig({
	      defaultModel: activeOptions.model,
	      models: activeOptions.models,
	      contextCompaction: activeOptions.contextCompaction,
	      tokenEconomy,
	      runtime: activeOptions.runtime,
	      reasoningEffort: activeOptions.roles?.codeReviewReasoningEffort,
	      roleModel: activeOptions.roles?.codeReviewModel,
	      roleProviderId: activeOptions.roles?.codeReviewProviderId,
	      roleAccountId: activeOptions.roles?.codeReviewAccountId
	    })
	    loopOptions = nextLoopOptions
	    loop = nextLoop
	    capabilities = rebuildCapabilities()
    services.instructionRuntime = instructionRuntime
    services.mcpProviders = mcpProviders
    services.skillRuntime = skillRuntime
    services.attachmentStore = attachmentStore
    services.memoryStore = memoryStore
    services.webProviders = webProviders
    services.imageGenProviders = imageGenProviders
    services.speechGenProviders = speechGenProviders
    services.musicGenProviders = musicGenProviders
    services.videoGenProviders = videoGenProviders
    services.computerUseProviders = computerUseProviders
    services.browserUseProviders = browserUseProviders
    services.resolvedHooks = resolvedHooks
    services.baseToolProviders = baseToolProviders
    services.childRegistry = childRegistry
    registryComposition.registry = registry
    registryComposition.capabilities = capabilities
    agent.loopOptions = loopOptions
    agent.loop = loop
	    void mcpProviders.startBackgroundReconnect((provider) => {
	      try {
	        registry.registerProvider(provider)
	      } catch {
	        // ignore duplicate/colliding registration
	      }
	      try {
	        childRegistry.registerProvider(provider)
	      } catch {
	        // ignore duplicate/colliding registration
	      }
	    })
	    void previousMcpProviders.close().catch(() => undefined)
	    stagedGenerationCommitted = true
	    return { ok: true }
	    } catch (error) {
	      return {
	        ok: false,
	        code: 'invalid_config',
	        message: error instanceof Error ? error.message : String(error)
	      }
	    } finally {
	      if (!stagedGenerationCommitted) {
	        await nextMcpProviders.close().catch(() => undefined)
	      }
	    }
	  }
  return {
    applyConfig,
    rebuildCapabilities,
    startedAt,
    get activeOptions() { return activeOptions },
    get capabilities() { return capabilities },
    get registry() { return registry },
    get loopOptions() { return loopOptions },
    get loop() { return loop }
  }
}
