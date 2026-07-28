import { lazy, Suspense, type ReactElement } from 'react'
import type { PlanBuildOrchestration } from '../../plan/plan-build'

const PlanPanel = lazy(() =>
  import('../plan/PlanPanel').then((module) => ({ default: module.PlanPanel }))
)

export type WorkbenchPlanPanelProps = {
  workspaceRoot: string
  activeThreadId: string | null
  runtimeReady: boolean
  graphEnabled: boolean
  busy: boolean
  className: string
  onCollapse: () => void
  onBuildPlan: (orchestration: PlanBuildOrchestration) => void
  onVerifyPlan: () => void
  onReplanChanged: (ids: string[]) => void
}

export function WorkbenchPlanPanel(props: WorkbenchPlanPanelProps): ReactElement {
  return <PlanPanel {...props} />
}

export function WorkbenchPlanPanelOverlay({
  open,
  title,
  cancelLabel,
  panelProps,
  onClose
}: {
  open: boolean
  title: string
  cancelLabel: string
  panelProps: WorkbenchPlanPanelProps
  onClose: () => void
}): ReactElement | null {
  if (!open) return null
  return (
    <div
      className="ds-plan-panel-overlay ds-no-drag"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <button
        type="button"
        className="ds-plan-panel-overlay-backdrop"
        aria-label={cancelLabel}
        onClick={onClose}
      />
      <div className="ds-plan-panel-overlay-card">
        <Suspense fallback={<div className="h-full w-full bg-ds-sidebar" />}>
          <WorkbenchPlanPanel {...panelProps} />
        </Suspense>
      </div>
    </div>
  )
}
