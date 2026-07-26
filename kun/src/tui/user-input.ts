import type { UserInputQuestionSchema } from '../contracts/items.js'
import type { UserInputAnswer } from './client.js'
import type { PendingUserInput } from './state.js'
import type { z } from 'zod'

export type UserInputQuestion = z.infer<typeof UserInputQuestionSchema>

export type UserInputSession = {
  requestId: string
  prompt: string
  questions: UserInputQuestion[]
  questionIndex: number
  optionIndex: number
  answers: Record<string, UserInputAnswer>
}

export function createUserInputSession(request: PendingUserInput): UserInputSession {
  const questions = request.questions.length > 0
    ? request.questions
    : [{ header: 'Input', id: 'answer', question: request.prompt, options: [] }]
  return {
    requestId: request.inputId,
    prompt: request.prompt,
    questions,
    questionIndex: 0,
    optionIndex: 0,
    answers: {}
  }
}

export function currentUserInputQuestion(session: UserInputSession): UserInputQuestion {
  return session.questions[session.questionIndex]
}

export function moveUserInputOption(session: UserInputSession, delta: number): UserInputSession {
  const question = currentUserInputQuestion(session)
  const max = Math.max(0, question.options.length - 1)
  return { ...session, optionIndex: Math.max(0, Math.min(max, session.optionIndex + delta)) }
}

export function toggleCurrentUserInputOption(session: UserInputSession): UserInputSession {
  const question = currentUserInputQuestion(session)
  const option = question.options[session.optionIndex]
  if (!option) return session
  if (question.selectionMode !== 'multiple') {
    return advanceAfterAnswer(session, optionAnswer(question, option.label))
  }
  const previous = session.answers[question.id]
  const selected = new Set(previous?.labels ?? (previous?.label ? [previous.label] : []))
  if (selected.has(option.label)) selected.delete(option.label)
  else selected.add(option.label)
  const labels = question.options.map((entry) => entry.label).filter((label) => selected.has(label))
  const answers = { ...session.answers }
  if (labels.length === 0) delete answers[question.id]
  else {
    const value = labels.join(', ')
    answers[question.id] = { id: question.id, label: value, value, labels, values: labels }
  }
  return { ...session, answers }
}

export function answerCurrentUserInputWithText(
  session: UserInputSession,
  text: string
): UserInputSession {
  const trimmed = text.trim()
  if (!trimmed) return session
  const question = currentUserInputQuestion(session)
  const matching = question.options.find((option) => option.label.trim().toLowerCase() === trimmed.toLowerCase())
  const answer: UserInputAnswer = matching
    ? optionAnswer(question, matching.label)
    : {
        id: question.id,
        label: question.options.length > 0 ? 'Other' : 'Answer',
        value: trimmed
      }
  return advanceAfterAnswer(session, answer)
}

export function confirmCurrentUserInput(session: UserInputSession): UserInputSession {
  const question = currentUserInputQuestion(session)
  if (question.selectionMode === 'multiple') {
    if (!isUserInputQuestionAnswered(question, session.answers[question.id])) return session
    return advanceQuestion(session)
  }
  const option = question.options[session.optionIndex]
  return option ? advanceAfterAnswer(session, optionAnswer(question, option.label)) : session
}

export function isUserInputSessionComplete(session: UserInputSession): boolean {
  return session.questions.every((question) => isUserInputQuestionAnswered(question, session.answers[question.id]))
}

export function orderedUserInputAnswers(session: UserInputSession): UserInputAnswer[] {
  return session.questions.flatMap((question) => {
    const answer = session.answers[question.id]
    return answer ? [answer] : []
  })
}

export function selectedUserInputLabels(session: UserInputSession): Set<string> {
  const question = currentUserInputQuestion(session)
  const answer = session.answers[question.id]
  return new Set(answer?.labels ?? (answer?.label && answer.label !== 'Other' ? [answer.label] : []))
}

function advanceAfterAnswer(session: UserInputSession, answer: UserInputAnswer): UserInputSession {
  return advanceQuestion({
    ...session,
    answers: { ...session.answers, [answer.id]: answer }
  })
}

function advanceQuestion(session: UserInputSession): UserInputSession {
  if (isUserInputSessionComplete(session)) return session
  for (let offset = 1; offset <= session.questions.length; offset += 1) {
    const index = (session.questionIndex + offset) % session.questions.length
    const question = session.questions[index]
    if (!isUserInputQuestionAnswered(question, session.answers[question.id])) {
      return { ...session, questionIndex: index, optionIndex: 0 }
    }
  }
  return session
}

function optionAnswer(question: UserInputQuestion, label: string): UserInputAnswer {
  return { id: question.id, label, value: label }
}

function isUserInputQuestionAnswered(
  question: UserInputQuestion,
  answer: UserInputAnswer | undefined
): boolean {
  if (!answer) return false
  if (question.options.length === 0 || answer.label === 'Other') return Boolean(answer.value.trim())
  if (question.selectionMode !== 'multiple') return true
  const count = answer.labels?.length ?? 0
  const minimum = question.minSelections ?? 1
  const maximum = question.maxSelections ?? question.options.length
  return count >= minimum && count <= maximum
}
