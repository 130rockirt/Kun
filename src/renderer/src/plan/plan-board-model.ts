import type { ThreadTodoItem, ThreadTodoList, ThreadTodoStatus } from '../agent/types'

export type PlanBoardCard = {
  id: string
  todoId?: string
  title: string
  checkboxStatus: 'pending' | 'completed'
  status: ThreadTodoStatus
  sectionTitle: string | null
  ordinal: number
  lineIndex: number
  from: number
  to: number
}

type ParsedTask = {
  title: string
  checkboxStatus: 'pending' | 'completed'
}

const HEADING_RE = /^\s{0,3}(#{2,3})\s+(.+?)\s*#*\s*$/
const TASK_RE = /^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+/g, '/').replace(/^\.\//, '')
}

function parseTask(line: string): ParsedTask | null {
  const match = TASK_RE.exec(line)
  const title = match?.[2]?.replace(/\s+/g, ' ').trim() ?? ''
  if (!match || !title) return null
  return {
    title,
    checkboxStatus: match[1]?.toLowerCase() === 'x' ? 'completed' : 'pending'
  }
}

export function planHasBoardTasks(markdown: string): boolean {
  return buildPlanBoardCards({ markdown, planId: '', relativePath: '', todos: null }).length > 0
}

export function buildPlanBoardCards(input: {
  markdown: string
  planId: string
  relativePath: string
  todos: ThreadTodoList | null
}): PlanBoardCard[] {
  const cards: PlanBoardCard[] = []
  const lines = input.markdown.split(/\r?\n/)
  const lineEndingLength = input.markdown.includes('\r\n') ? 2 : 1
  const path = normalizePath(input.relativePath)
  const planTodos = (input.todos?.items ?? []).filter((item) =>
    item.source?.kind === 'plan' &&
    item.source.planId === input.planId &&
    normalizePath(item.source.relativePath) === path
  )
  const byOrdinal = new Map<number, ThreadTodoItem>()
  for (const item of planTodos) {
    if (item.source) byOrdinal.set(item.source.ordinal, item)
  }

  let sectionTitle: string | null = null
  let ordinal = 0
  let offset = 0
  let fence: string | null = null
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? ''
    const fenceMatch = FENCE_RE.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? ''
      if (!fence) fence = marker[0] ?? null
      else if (marker[0] === fence) fence = null
      offset += line.length + (lineIndex < lines.length - 1 ? lineEndingLength : 0)
      continue
    }
    if (!fence) {
      const heading = HEADING_RE.exec(line)
      if (heading) sectionTitle = heading[2]?.trim() || null
      const task = parseTask(line)
      if (task) {
        const todo = byOrdinal.get(ordinal)
        cards.push({
          id: todo?.id ?? `plan-card-${ordinal}`,
          ...(todo ? { todoId: todo.id } : {}),
          title: task.title,
          checkboxStatus: task.checkboxStatus,
          status: todo?.status ?? task.checkboxStatus,
          sectionTitle,
          ordinal,
          lineIndex,
          from: offset,
          to: offset + line.length
        })
        ordinal += 1
      }
    }
    offset += line.length + (lineIndex < lines.length - 1 ? lineEndingLength : 0)
  }
  return cards
}

export function replacePlanTaskTitle(markdown: string, card: PlanBoardCard, title: string): string {
  const line = markdown.slice(card.from, card.to)
  const match = /^(\s*[-*+]\s+\[[ xX]\]\s+)(.*?)(\s*)$/.exec(line)
  const normalized = title.replace(/\s+/g, ' ').trim()
  if (!match || !normalized) return markdown
  return `${markdown.slice(0, card.from)}${match[1]}${normalized}${match[3]}${markdown.slice(card.to)}`
}

export function deletePlanTask(markdown: string, card: PlanBoardCard): string {
  let to = card.to
  if (markdown.slice(to, to + 2) === '\r\n') to += 2
  else if (markdown[to] === '\n') to += 1
  return `${markdown.slice(0, card.from)}${markdown.slice(to)}`
}

export function appendPlanTask(
  markdown: string,
  title: string,
  completed = false
): string {
  const normalized = title.replace(/\s+/g, ' ').trim()
  if (!normalized) return markdown
  const suffix = `${markdown && !markdown.endsWith('\n') ? '\n' : ''}${markdown ? '\n' : ''}## Tasks\n\n- [${completed ? 'x' : ' '}] ${normalized}\n`
  const tasksHeading = /^## Tasks\s*$/im.exec(markdown)
  if (!tasksHeading) return markdown + suffix
  const headingEnd = tasksHeading.index + tasksHeading[0].length
  const nextHeading = /^##\s+/m.exec(markdown.slice(headingEnd))
  const insertAt = nextHeading ? headingEnd + nextHeading.index : markdown.length
  const prefix = markdown.slice(0, insertAt).replace(/\s*$/, '')
  const tail = markdown.slice(insertAt)
  return `${prefix}\n\n- [${completed ? 'x' : ' '}] ${normalized}\n${tail}`
}
