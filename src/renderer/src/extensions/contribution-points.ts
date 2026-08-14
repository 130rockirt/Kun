export const WORKBENCH_CONTRIBUTION_POINTS = [
  'commands',
  'views.containers',
  'views.leftSidebar',
  'views.rightSidebar',
  'views.auxiliaryPanel',
  'views.editorTab',
  'views.fullPage',
  'actions.topBar',
  'actions.composer',
  'actions.message',
  'message.resultPreviews',
  'settings',
  'contextMenus',
  'notifications',
  'hostContentScripts'
] as const

export type WorkbenchContributionPoint = (typeof WORKBENCH_CONTRIBUTION_POINTS)[number]
