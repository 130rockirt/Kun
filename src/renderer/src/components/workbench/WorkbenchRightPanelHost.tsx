import type { PointerEventHandler, ReactElement } from 'react'
import { WorkbenchRightPanel, type WorkbenchRightPanelProps } from './WorkbenchRightPanel'
import type { WorkbenchRightPanelSharedProps } from './useWorkbenchRightPanelSharedProps'

type SharedKey = keyof WorkbenchRightPanelSharedProps

export type WorkbenchRightPanelHostProps = Pick<
  WorkbenchRightPanelProps,
  | 'visible'
  | 'width'
  | 'route'
  | 'rightPanelMode'
  | 'graphEnabled'
  | 'writeAssistantOpen'
  | 'changes'
  | 'browser'
  | 'planPanel'
  | 'canvas'
  | 'file'
  | 'mcpSkills'
  | 'extensionView'
  | 'code'
  | 'workspaceRoot'
  | 'onCollapse'
> & {
  onBeginResize: PointerEventHandler<HTMLDivElement>
  design: {
    panelMode: WorkbenchRightPanelProps['design']['panelMode']
    shared: WorkbenchRightPanelSharedProps
    implement: WorkbenchRightPanelProps['design']['implement']
    assistant: WorkbenchRightPanelProps['design']['assistant']
  }
  write: Omit<WorkbenchRightPanelProps['write'], SharedKey>
  sdd: Omit<WorkbenchRightPanelProps['sdd'], SharedKey>
}

export function WorkbenchRightPanelHost({
  visible,
  width,
  route,
  rightPanelMode,
  graphEnabled,
  onBeginResize,
  design,
  writeAssistantOpen,
  write,
  sdd,
  changes,
  browser,
  planPanel,
  canvas,
  file,
  mcpSkills,
  extensionView,
  code,
  workspaceRoot,
  onCollapse
}: WorkbenchRightPanelHostProps): ReactElement | null {
  return (
    <WorkbenchRightPanel
      visible={visible}
      width={width}
      route={route}
      rightPanelMode={rightPanelMode}
      graphEnabled={graphEnabled}
      onBeginResize={onBeginResize}
      design={design}
      writeAssistantOpen={writeAssistantOpen}
      write={{ ...design.shared, ...write }}
      sdd={{ ...design.shared, ...sdd }}
      changes={changes}
      browser={browser}
      planPanel={planPanel}
      canvas={canvas}
      file={file}
      mcpSkills={mcpSkills}
      extensionView={extensionView}
      code={code}
      workspaceRoot={workspaceRoot}
      onCollapse={onCollapse}
    />
  )
}
