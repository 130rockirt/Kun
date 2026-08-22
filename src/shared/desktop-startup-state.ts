export type DesktopStartupPhase =
  | 'bootstrapping'
  | 'runtime_handoff'
  | 'runtime_starting'
  | 'ready'
  | 'recovery_required'
