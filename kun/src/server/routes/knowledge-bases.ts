import { ThreadKnowledgeBasesResponseSchema } from '../../contracts/threads.js'
import {
  KnowledgeBaseError,
  type KnowledgeBaseService
} from '../../knowledge/knowledge-base-service.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import { ERRORS } from './runtime-error.js'

export async function getThreadKnowledgeBases(
  service: KnowledgeBaseService | undefined,
  threadId: string
): Promise<JsonResponse> {
  if (!service) return ERRORS.unavailable('knowledge-base indexing is not available')
  try {
    return jsonResponse(ThreadKnowledgeBasesResponseSchema.parse(await service.listForThread(threadId)))
  } catch (error) {
    return knowledgeBaseErrorResponse(error)
  }
}

export async function reindexThreadKnowledgeBase(
  service: KnowledgeBaseService | undefined,
  threadId: string,
  knowledgeBaseId: string
): Promise<JsonResponse> {
  if (!service) return ERRORS.unavailable('knowledge-base indexing is not available')
  try {
    return jsonResponse(await service.reindex(threadId, knowledgeBaseId))
  } catch (error) {
    return knowledgeBaseErrorResponse(error)
  }
}

function knowledgeBaseErrorResponse(error: unknown): JsonResponse {
  if (error instanceof KnowledgeBaseError) {
    switch (error.code) {
      case 'not_found': return ERRORS.notFound(error.message)
      case 'busy': return ERRORS.conflict(error.message)
      case 'invalid': return ERRORS.validation(error.message)
      case 'unavailable': return ERRORS.unavailable(error.message)
    }
  }
  return ERRORS.internal(error instanceof Error ? error.message : String(error))
}
