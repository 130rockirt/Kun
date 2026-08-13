import { useEffect, useRef, useState } from 'react'
import type { SkillListItem } from '@shared/kun-gui-api'
import type { CoreRuntimeInfoJson, CoreRuntimeSkillJson } from '../../agent/kun-contract'
import { getProvider } from '../../agent/registry'

function mergeSkillCommands(
  runtimeSkills: CoreRuntimeSkillJson[],
  localSkills: SkillListItem[]
): CoreRuntimeSkillJson[] {
  const merged = new Map<string, CoreRuntimeSkillJson>()
  for (const skill of localSkills) {
    merged.set(skill.id, {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      root: skill.root,
      legacy: skill.legacy,
      scope: skill.scope
    })
  }
  for (const skill of runtimeSkills) {
    const existing = merged.get(skill.id)
    merged.set(skill.id, existing ? {
      ...skill,
      ...existing,
      triggers: skill.triggers ?? existing.triggers,
      allowedTools: skill.allowedTools ?? existing.allowedTools
    } : skill)
  }
  return [...merged.values()]
}

function skillMenuJustOpened(wasOpen: boolean, isOpen: boolean): boolean {
  return !wasOpen && isOpen
}

async function loadSkillCommands(
  runtimeReady: boolean,
  activeSkillWorkspace: string
): Promise<CoreRuntimeSkillJson[]> {
  const provider = getProvider()
  const localSkillsTask = typeof window !== 'undefined' && typeof window.kunGui?.listSkills === 'function'
    ? window.kunGui.listSkills(activeSkillWorkspace || undefined)
    : Promise.resolve({ ok: true as const, skills: [], validationErrors: [] })
  const [runtimeResult, localSkillsResult] = await Promise.allSettled([
    runtimeReady && provider.listSkills ? provider.listSkills() : Promise.resolve([]),
    localSkillsTask
  ])
  const runtimeSkillList = runtimeResult.status === 'fulfilled' ? runtimeResult.value : []
  const localSkillList =
    localSkillsResult.status === 'fulfilled' && localSkillsResult.value.ok
      ? localSkillsResult.value.skills
      : []
  return mergeSkillCommands(runtimeSkillList, localSkillList)
}

export function useWorkbenchRuntimeMetadata(input: {
  activeSkillWorkspace: string
  runtimeConnection: string
  skillMenuOpen: boolean
}): {
  runtimeInfo: CoreRuntimeInfoJson | null
  runtimeSkills: CoreRuntimeSkillJson[]
} {
  const [runtimeInfo, setRuntimeInfo] = useState<CoreRuntimeInfoJson | null>(null)
  const [runtimeSkills, setRuntimeSkills] = useState<CoreRuntimeSkillJson[]>([])
  const skillMenuOpenRef = useRef(input.skillMenuOpen)
  const runtimeInfoRequestSequenceRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    const runtimeReady = input.runtimeConnection === 'ready'
    const runtimeInfoRequestSequence = ++runtimeInfoRequestSequenceRef.current
    if (!runtimeReady) setRuntimeInfo(null)
    const provider = getProvider()
    void Promise.allSettled([
      runtimeReady && provider.getRuntimeInfo ? provider.getRuntimeInfo() : Promise.resolve(null),
      loadSkillCommands(runtimeReady, input.activeSkillWorkspace)
    ])
      .then(([runtimeResult, skillsResult]) => {
        if (cancelled) return
        if (runtimeInfoRequestSequence === runtimeInfoRequestSequenceRef.current) {
          setRuntimeInfo(runtimeResult.status === 'fulfilled' ? runtimeResult.value : null)
        }
        setRuntimeSkills(skillsResult.status === 'fulfilled' ? skillsResult.value : [])
      })
      .catch(() => {
        if (!cancelled) {
          if (
            !runtimeReady &&
            runtimeInfoRequestSequence === runtimeInfoRequestSequenceRef.current
          ) {
            setRuntimeInfo(null)
          }
          setRuntimeSkills([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [input.activeSkillWorkspace, input.runtimeConnection])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    let cancelled = false
    let latestGeneration = -1
    let refreshedTerminalGeneration = -1
    const reloadRuntimeInfo = async (): Promise<void> => {
      if (input.runtimeConnection !== 'ready') return
      const runtimeInfoRequestSequence = ++runtimeInfoRequestSequenceRef.current
      const provider = getProvider()
      try {
        const next = provider.getRuntimeInfo ? await provider.getRuntimeInfo() : null
        if (
          !cancelled &&
          runtimeInfoRequestSequence === runtimeInfoRequestSequenceRef.current
        ) {
          setRuntimeInfo(next)
        }
      } catch {
        if (
          !cancelled &&
          runtimeInfoRequestSequence === runtimeInfoRequestSequenceRef.current
        ) {
          setRuntimeInfo(null)
        }
      }
    }
    const handleStatus = (status: {
      state: string
      generation: number
    }): void => {
      if (cancelled || status.generation < latestGeneration) return
      if (status.generation > latestGeneration) latestGeneration = status.generation
      const terminal =
        status.state === 'synced' ||
        status.state === 'unavailable' ||
        status.state === 'failed'
      if (!terminal || refreshedTerminalGeneration === status.generation) return
      refreshedTerminalGeneration = status.generation
      void reloadRuntimeInfo()
    }
    const unsubscribe = typeof window.kunGui?.onRuntimeSettingsSyncStatus === 'function'
      ? window.kunGui.onRuntimeSettingsSyncStatus(handleStatus)
      : undefined
    if (typeof window.kunGui?.getRuntimeSettingsSyncStatus === 'function') {
      void window.kunGui.getRuntimeSettingsSyncStatus().then(handleStatus).catch(() => undefined)
    }
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [input.runtimeConnection])

  useEffect(() => {
    const opened = skillMenuJustOpened(skillMenuOpenRef.current, input.skillMenuOpen)
    skillMenuOpenRef.current = input.skillMenuOpen
    if (!opened) return
    let cancelled = false
    void loadSkillCommands(
      input.runtimeConnection === 'ready',
      input.activeSkillWorkspace
    ).then((skills) => {
      if (!cancelled) setRuntimeSkills(skills)
    }).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [input.activeSkillWorkspace, input.runtimeConnection, input.skillMenuOpen])

  return { runtimeInfo, runtimeSkills }
}
