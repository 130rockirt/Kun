/**
 * Standalone Design is no longer an active workbench destination. Keep the
 * legacy route value readable, but project it through the Code shell.
 */
export function normalizeWorkbenchRoute(route: string): string {
  return route === 'design' ? 'chat' : route
}
