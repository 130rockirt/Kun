import type { ScheduledTaskV1 } from '@shared/app-settings'

export type PlanScheduleCountdown =
  | { kind: 'due' }
  | { kind: 'remaining'; days: number; hours: number; minutes: number }

export function scheduledTaskTime(task: ScheduledTaskV1): string {
  const next = Date.parse(task.nextRunAt)
  if (Number.isFinite(next)) return task.nextRunAt
  return Number.isFinite(Date.parse(task.schedule.atTime)) ? task.schedule.atTime : ''
}

export function activePlanScheduledTask(
  tasks: readonly ScheduledTaskV1[],
  planId: string,
  nowMs = Date.now()
): ScheduledTaskV1 | null {
  return tasks
    .filter((task) => task.sourcePlanId === planId && task.enabled && task.schedule.kind === 'at')
    .filter((task) => {
      const time = scheduledTaskTime(task)
      return Boolean(time) && Date.parse(time) > nowMs
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
}

export function planScheduleCountdown(atTime: string, nowMs = Date.now()): PlanScheduleCountdown {
  const target = Date.parse(atTime)
  if (!Number.isFinite(target) || target <= nowMs) return { kind: 'due' }
  const totalMinutes = Math.ceil((target - nowMs) / 60_000)
  return {
    kind: 'remaining',
    days: Math.floor(totalMinutes / 1_440),
    hours: Math.floor((totalMinutes % 1_440) / 60),
    minutes: totalMinutes % 60
  }
}
