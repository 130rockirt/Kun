import { getSlashQuery } from '../chat/floating-composer-commands'
import { useWorkbenchRuntimeMetadata } from './useWorkbenchRuntimeMetadata'
import { useWorkbenchTaskSurface } from './useWorkbenchTaskSurface'

type TaskSurfaceInput = Omit<
  Parameters<typeof useWorkbenchTaskSurface>[0],
  'imageGenerationEnabled'
>

type WorkbenchTaskRuntimeInput = TaskSurfaceInput & {
  composerInput: string
  runtimeConnection: string
}

/** Runtime capabilities plus the Code/Design task identity that consumes them. */
export function useWorkbenchTaskRuntime(input: WorkbenchTaskRuntimeInput) {
  const runtime = useWorkbenchRuntimeMetadata({
    activeSkillWorkspace: input.activeSkillWorkspace,
    runtimeConnection: input.runtimeConnection,
    skillMenuOpen: getSlashQuery(input.composerInput) !== null
  })
  const task = useWorkbenchTaskSurface({
    ...input,
    imageGenerationEnabled: runtime.runtimeInfo
      ? runtime.runtimeInfo.capabilities.imageGen?.enabled === true
      : undefined
  })
  return { ...runtime, ...task }
}
