import type { DesktopStartupPhase } from '@shared/desktop-startup-state'

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
