const WORKBENCH_DIVIDER_CLASS =
  'ds-workbench-divider ds-no-drag relative z-20 shrink-0 cursor-col-resize'

export function workbenchDividerClassName(route: string): string {
  return route === 'write'
    ? `ds-workbench-divider--flush ${WORKBENCH_DIVIDER_CLASS}`
    : WORKBENCH_DIVIDER_CLASS
}
