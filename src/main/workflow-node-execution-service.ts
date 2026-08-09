import type {
  AppSettingsV1,
  WorkflowNodeV1,
  WorkflowV1
} from '../shared/app-settings'
import { sleep, type ScheduleRuntimeDeps } from './schedule-runtime-helpers'
import { WorkflowRunCoordinator } from './workflow-run-coordinator'
import { createWorkflowNodeExecutorRegistry } from './workflow-node-executor-registry'
import type { InterpScope, WorkflowPayload } from './workflow-expression'
import { executeCoreWorkflowNode, isCoreWorkflowNode } from './workflow-core-node-adapter'
import { executeHttpWorkflowNode } from './workflow-http-node-adapter'
import { executeAiWorkflowNode } from './workflow-ai-node-adapter'
import { executeImageWorkflowNode } from './workflow-image-node-adapter'
import {
  executeCodeWorkflowNode,
  executeCustomWorkflowNode
} from './workflow-code-node-adapter'
import { executeNestedWorkflowNode } from './workflow-nested-node-adapter'
import { executeApprovalWorkflowNode } from './workflow-approval-node-adapter'
import {
  executeWorkflowGraph,
  type WorkflowGraphExecutionContext,
  type WorkflowGraphRunResult
} from './workflow-graph-executor'
import type {
  NodeExecutionContext,
  NodeOutcome
} from './workflow-runtime-helpers'

export class WorkflowNodeExecutionService {
  private readonly nodeExecutors = createWorkflowNodeExecutorRegistry<NodeOutcome>()

  constructor(
    private readonly deps: ScheduleRuntimeDeps,
    private readonly runCoordinator: WorkflowRunCoordinator
  ) {}

  runGraph(
    workflow: WorkflowV1,
    triggerNodeId: string,
    initialPayload: WorkflowPayload,
    context: WorkflowGraphExecutionContext
  ): Promise<WorkflowGraphRunResult> {
    return executeWorkflowGraph({
      workflow,
      triggerNodeId,
      initialPayload,
      context,
      executeNode: (request) => this.executeNode(
        request.node,
        request.payload,
        request.settings,
        request.inputs,
        request.depth,
        request.runWorkspace,
        request.scope,
        request.runVars,
        request.runRef,
        request.signal,
        request.cancelId,
        request.statusWorkflowId
      ),
      setLive: (nodeId, status) => {
        if (context.statusWorkflowId) this.runCoordinator.setLive(context.statusWorkflowId, nodeId, status)
      },
      setLiveResult: (result) => this.runCoordinator.setLiveResult(context.statusWorkflowId, result),
      isCanceled: () => Boolean(
        context.signal?.aborted || this.runCoordinator.isCanceled(context.cancelId)
      ),
      logError: (message, details) => this.deps.logError('workflow', message, details)
    })
  }

  async executeNode(
    node: WorkflowNodeV1,
    payload: WorkflowPayload,
    settings: AppSettingsV1,
    inputs: WorkflowPayload[] = [payload],
    depth = 0,
    runWorkspace = '',
    scope: InterpScope = {},
    runVars: Record<string, unknown> = {},
    runRef?: { workflowId: string; runId: string },
    signal?: AbortSignal,
    cancelId?: string,
    statusWorkflowId?: string
  ): Promise<NodeOutcome> {
    const context: NodeExecutionContext = {
      payload,
      settings,
      inputs,
      depth,
      runWorkspace,
      scope,
      runVars,
      runRef,
      signal,
      cancelId,
      statusWorkflowId
    }
    return this.nodeExecutors.execute(node, {
      executeCore: (registeredNode) => this.executeCoreNode(registeredNode, context),
      executeAi: (registeredNode) => this.executeAiNode(registeredNode, context),
      executeImage: (registeredNode) => this.executeImageNode(registeredNode, context),
      executeCode: (registeredNode) => this.executeCodeNode(registeredNode, context),
      executeNested: (registeredNode) => this.executeNestedNode(registeredNode, context),
      executeHttp: (registeredNode) => this.executeHttpNode(registeredNode, context),
      executeApproval: (registeredNode) => this.executeApprovalNode(registeredNode, context),
      executeCustom: (registeredNode) => this.executeCustomNode(registeredNode, context)
    })
  }

  private async executeCoreNode(
    node: WorkflowNodeV1,
    context: NodeExecutionContext
  ): Promise<NodeOutcome> {
    if (!isCoreWorkflowNode(node)) {
      throw new Error(`Core workflow node adapter received unsupported kind: ${node.type}`)
    }
    const coreOutcome = await executeCoreWorkflowNode({
      node,
      payload: context.payload,
      inputs: context.inputs,
      scope: context.scope,
      runVars: context.runVars,
      sleep: (ms) => sleep(ms, context.signal)
    })
    if (coreOutcome) return coreOutcome
    throw new Error(`Core workflow node adapter returned no outcome: ${node.type}`)
  }

  private executeAiNode(node: WorkflowNodeV1, context: NodeExecutionContext): Promise<NodeOutcome> {
    if (node.type !== 'ai-agent' && node.type !== 'parameter-extractor' && node.type !== 'question-classifier') {
      throw new Error(`AI workflow node adapter received unsupported kind: ${node.type}`)
    }
    return executeAiWorkflowNode({
      node,
      payload: context.payload,
      settings: context.settings,
      deps: this.deps,
      runWorkspace: context.runWorkspace,
      scope: context.scope,
      ...(context.signal ? { signal: context.signal } : {})
    })
  }

  private executeImageNode(node: WorkflowNodeV1, context: NodeExecutionContext): Promise<NodeOutcome> {
    if (node.type !== 'generate-image') {
      throw new Error(`Image workflow node adapter received unsupported kind: ${node.type}`)
    }
    return executeImageWorkflowNode({
      node,
      payload: context.payload,
      settings: context.settings,
      runWorkspace: context.runWorkspace,
      scope: context.scope,
      ...(context.signal ? { signal: context.signal } : {})
    })
  }

  private executeCodeNode(node: WorkflowNodeV1, context: NodeExecutionContext): Promise<NodeOutcome> {
    if (node.type !== 'code') {
      throw new Error(`Code workflow node adapter received unsupported kind: ${node.type}`)
    }
    return executeCodeWorkflowNode({
      node,
      payload: context.payload,
      ...(context.signal ? { signal: context.signal } : {})
    })
  }

  private executeNestedNode(node: WorkflowNodeV1, context: NodeExecutionContext): Promise<NodeOutcome> {
    if (node.type !== 'subworkflow' && node.type !== 'loop') {
      throw new Error(`Nested workflow node adapter received unsupported kind: ${node.type}`)
    }
    return executeNestedWorkflowNode({
      node,
      payload: context.payload,
      settings: context.settings,
      depth: context.depth,
      scope: context.scope,
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.cancelId ? { cancelId: context.cancelId } : {}),
      ...(context.statusWorkflowId ? { statusWorkflowId: context.statusWorkflowId } : {}),
      ...(context.runRef ? { runId: context.runRef.runId } : {}),
      runGraph: (workflow, triggerNodeId, payload, nestedContext) =>
        this.runGraph(workflow, triggerNodeId, payload, nestedContext)
    })
  }

  private executeHttpNode(node: WorkflowNodeV1, context: NodeExecutionContext): Promise<NodeOutcome> {
    if (node.type !== 'http-request') {
      throw new Error(`HTTP workflow node adapter received unsupported kind: ${node.type}`)
    }
    return executeHttpWorkflowNode(node.config, context.payload, context.scope, context.signal)
  }

  private executeApprovalNode(node: WorkflowNodeV1, context: NodeExecutionContext): Promise<NodeOutcome> {
    if (node.type !== 'human-approval') {
      throw new Error(`Approval workflow node adapter received unsupported kind: ${node.type}`)
    }
    return executeApprovalWorkflowNode({
      node,
      payload: context.payload,
      settings: context.settings,
      scope: context.scope,
      runRef: context.runRef,
      awaitApproval: (entry, timeoutMs, onTimeout) =>
        this.runCoordinator.awaitApproval(entry, timeoutMs, onTimeout)
    })
  }

  private executeCustomNode(node: WorkflowNodeV1, context: NodeExecutionContext): Promise<NodeOutcome> {
    if (node.type !== 'custom') {
      throw new Error(`Custom workflow node adapter received unsupported kind: ${node.type}`)
    }
    return executeCustomWorkflowNode({
      node,
      payload: context.payload,
      modules: context.settings.workflow.modules,
      ...(context.signal ? { signal: context.signal } : {})
    })
  }

}
