import { createRoot, type Root } from 'react-dom/client'
import { useMemo, useState, type ReactElement } from 'react'
import type { GraphPlanNode, GraphRun } from '../../graph/graph-types'
import { graphElements, runProgress } from './graph-elements'
import { GraphRunView } from './GraphRunView'

let smokeRoot: Root | null = null
let smokeHost: HTMLDivElement | null = null

export function mountGraphWorkbenchSmokeFixture(width = 1040): void {
  unmountGraphWorkbenchSmokeFixture()
  smokeHost = document.createElement('div')
  smokeHost.dataset.graphSmokeHost = 'true'
  smokeHost.className = 'ds-drag'
  Object.assign(smokeHost.style, {
    position: 'fixed',
    inset: '24px',
    width: `${width}px`,
    maxWidth: 'calc(100vw - 48px)',
    height: 'calc(100vh - 48px)',
    zIndex: '2147483646',
    overflow: 'hidden',
    borderRadius: '18px',
    boxShadow: '0 24px 80px rgb(15 23 42 / 0.24)'
  })
  document.body.append(smokeHost)
  smokeRoot = createRoot(smokeHost)
  smokeRoot.render(<GraphWorkbenchSmokeView />)
}

export function setGraphWorkbenchSmokeWidth(width: number): void {
  if (!smokeHost) throw new Error('Graph workbench smoke fixture is not mounted')
  smokeHost.style.width = `${Math.max(320, width)}px`
}

export function unmountGraphWorkbenchSmokeFixture(): void {
  smokeRoot?.unmount()
  smokeRoot = null
  smokeHost?.remove()
  smokeHost = null
}

function GraphWorkbenchSmokeView(): ReactElement {
  const run = useMemo(() => smokeRun(), [])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>('research')
  const [steering, setSteering] = useState('')
  const selectedNode = selectedNodeId ? run.nodes[selectedNodeId] : undefined
  const elements = graphElements(run, true, selectedNodeId)
  return (
    <section className="graph-mode-panel ds-no-drag flex h-full min-h-0 flex-col overflow-hidden border border-ds-border-muted bg-ds-sidebar">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-ds-border-muted px-4">
        <div>
          <div className="text-[13px] font-semibold text-ds-ink">Graph workbench interaction fixture</div>
          <div className="text-[9px] text-ds-faint">Electron pointer sequence verification</div>
        </div>
        <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-[9px] font-semibold text-emerald-700">
          live fixture
        </span>
      </header>
      <GraphRunView
        run={run}
        runs={[run]}
        elements={elements}
        progress={runProgress(run)}
        selectedNode={selectedNode}
        selectedNodeId={selectedNodeId}
        steering={steering}
        onSteeringChange={setSteering}
        onSendSteering={() => setSteering('')}
        onSelectRun={() => undefined}
        onSelectNode={setSelectedNodeId}
        onRefresh={() => undefined}
        onCommand={() => undefined}
        onCancel={() => undefined}
        onRetry={() => undefined}
        onReview={() => undefined}
        onPatch={async () => undefined}
        onRebind={() => undefined}
        onOpenChild={() => undefined}
        artifactPage={null}
        artifactContent=""
        artifactLoading={false}
        onOpenArtifact={() => undefined}
        onNextArtifactPage={() => undefined}
        onCloseArtifact={() => undefined}
      />
    </section>
  )
}

function planNode(
  id: string,
  phaseId: string,
  title: string,
  kind: GraphPlanNode['kind'],
  assignment: string
): GraphPlanNode {
  return {
    id,
    phaseId,
    kind,
    title,
    objective: `${title} with evidence-backed output and a bounded handoff.`,
    priority: 1,
    required: true,
    riskClass: 'low',
    assignment: {
      kind: 'existing',
      profileId: assignment,
      profileVersion: 1
    },
    completion: {
      requiredResultFields: ['summary', 'evidence'],
      acceptanceCriteria: ['Return a verified result', 'Preserve the declared write scope'],
      review: {
        kinds: ['lead'],
        requireAll: true,
        deterministicChecks: []
      }
    },
    timeoutMs: 600_000,
    maxAttempts: 2,
    readScopes: ['src'],
    writeScopes: []
  }
}

function smokeRun(): GraphRun {
  const nodes = [
    planNode('research', 'phase_discovery', 'Map current behavior', 'work', 'explore'),
    planNode('design', 'phase_discovery', 'Define interaction contract', 'review', 'product-design'),
    planNode('implementation', 'phase_build', 'Implement canvas controls', 'work', 'frontend'),
    planNode('verification', 'phase_verify', 'Verify pointer interactions', 'review', 'code-review')
  ]
  const now = new Date().toISOString()
  return {
    version: 1,
    id: 'graph_run_smoke',
    projectId: 'project_smoke',
    threadId: 'thread_smoke',
    sourceTurnId: 'turn_smoke',
    status: 'running',
    currentRevision: 2,
    plans: [{
      version: 1,
      revision: 2,
      title: 'Graph canvas usability verification',
      goal: 'Prove the canvas can pan, zoom, select, drag, resize, and inspect nodes.',
      workspaceRoot: '/smoke',
      phases: [
        { id: 'phase_discovery', title: 'Discover', order: 1 },
        { id: 'phase_build', title: 'Build', order: 2 },
        { id: 'phase_verify', title: 'Verify', order: 3 }
      ],
      nodes,
      edges: [
        { id: 'edge_1', kind: 'control', from: 'research', to: 'implementation' },
        { id: 'edge_2', kind: 'control', from: 'design', to: 'implementation' },
        { id: 'edge_3', kind: 'control', from: 'implementation', to: 'verification' }
      ],
      completionNodeIds: ['verification'],
      createdAt: now
    }],
    nodes: {
      research: { node: nodes[0]!, status: 'ready', attempts: [], loopIteration: 0 },
      design: { node: nodes[1]!, status: 'accepted', attempts: [], loopIteration: 0 },
      implementation: { node: nodes[2]!, status: 'running', attempts: [], loopIteration: 0 },
      verification: { node: nodes[3]!, status: 'blocked', attempts: [], loopIteration: 0 }
    },
    reviews: [],
    messages: [],
    artifacts: [],
    cleanup: [],
    steering: [],
    budget: {
      limits: {
        maxWallTimeMs: 2_700_000,
        maxAttemptsPerNode: 3
      },
      attempts: 1,
      revisions: 1,
      loopIterations: 0,
      elapsedMs: 312_000,
      totalTokens: 18_400,
      messages: 2,
      artifactBytes: 0,
      warningKinds: [],
      closed: false
    },
    lastEventSeq: 14,
    createdAt: now,
    updatedAt: now
  }
}
