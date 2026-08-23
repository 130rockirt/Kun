import type { DesktopStartupPhase } from '@shared/desktop-startup-state'

const STARTUP_PHASE_RANK: Record<DesktopStartupPhase, number> = {
  bootstrapping: 0,
  runtime_handoff: 1,
  runtime_starting: 2,
  ready: 3,
  recovery_required: 3
}

export function mergeStartupPhase(
  current: DesktopStartupPhase,
  next: DesktopStartupPhase
): DesktopStartupPhase {
  if (current === 'ready' || current === 'recovery_required') return current
  return STARTUP_PHASE_RANK[next] >= STARTUP_PHASE_RANK[current] ? next : current
}

export function startupPhaseLabel(phase: DesktopStartupPhase): string {
  switch (phase) {
    case 'runtime_handoff':
      return 'Updating the bundled Kun runtime...'
    case 'runtime_starting':
      return 'Starting Kun runtime...'
    case 'recovery_required':
      return 'Kun startup requires recovery.'
    case 'ready':
      return 'Kun is ready.'
    case 'bootstrapping':
      return 'Preparing Kun desktop...'
  }
}

export function startupShellAllowsWorkbench(phase: DesktopStartupPhase): boolean {
  return phase === 'ready'
}
