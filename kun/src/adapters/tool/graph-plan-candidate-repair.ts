/**
 * Some delegated tool transports have returned a corrected Graph plan with
 * task titles missing even though the model-side tool call contained them.
 * A repair draft already owns the previous durable candidate, so recover only
 * that stable display field by task key. Other fields remain as submitted.
 */
export function restoreMissingTaskTitles(candidate: unknown, previous: unknown): unknown {
  if (!isRecord(candidate) || !Array.isArray(candidate.tasks)) return candidate
  if (!isRecord(previous) || !Array.isArray(previous.tasks)) return candidate
  const previousTitles = new Map<string, string>()
  for (const task of previous.tasks) {
    if (!isRecord(task) || typeof task.key !== 'string') continue
    if (typeof task.title !== 'string' || !task.title.trim()) continue
    previousTitles.set(task.key, task.title)
  }
  if (previousTitles.size === 0) return candidate

  let changed = false
  const tasks = candidate.tasks.map((task) => {
    if (!isRecord(task) || typeof task.key !== 'string') return task
    if (typeof task.title === 'string' && task.title.trim()) return task
    const title = previousTitles.get(task.key)
    if (!title) return task
    changed = true
    return { ...task, title }
  })
  return changed ? { ...candidate, tasks } : candidate
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
