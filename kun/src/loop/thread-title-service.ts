import { touchThread } from '../domain/thread.js'
import type { ModelClient } from '../ports/model-client.js'
import type { SessionStore } from '../ports/session-store.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import { withThreadStoreMutation } from '../services/thread-mutation-coordinator.js'
import type { RolesConfig } from '../config/kun-config.js'
import { canUpgradeThreadTitle } from './thread-title-policy.js'
import { generateThreadTitle, resolveRoleModel } from './title-generator.js'

export type ThreadTitleServiceDeps = {
  threadStore: ThreadStore
  sessionStore: Pick<SessionStore, 'loadItems'>
  model: ModelClient
  events: Pick<RuntimeEventRecorder, 'record'>
  nowIso: () => string
  getRoles: () => RolesConfig | undefined
}

/** Best-effort first-turn title generation with a mutation-time overwrite guard. */
export class ThreadTitleService {
  constructor(private readonly deps: ThreadTitleServiceDeps) {}

  async generateAfterTurn(
    threadId: string,
    turnId: string,
    signal?: AbortSignal
  ): Promise<void> {
    const thread = await this.deps.threadStore.get(threadId)
    if (!thread) return
    // Skip once any turn has already completed — title runs in parallel with
    // the first turn, so later turn starts must not re-title.
    if (thread.turns.some((turn) => turn.status === 'completed')) return
    if (!canUpgradeThreadTitle(thread)) return

    const items = await this.deps.sessionStore.loadItems(threadId)
    const userText = items.find((item) => item.kind === 'user_message')?.text ?? ''
    if (!userText.trim()) return
    const roles = this.deps.getRoles()
    const resolved = resolveRoleModel({
      roleModel: roles?.titleModel,
      roleProviderId: roles?.titleProviderId,
      roleAccountId: roles?.titleAccountId,
      roles,
      mainModel: thread.model || this.deps.model.model,
      mainProviderId: thread.providerId,
      mainAccountId: thread.accountId
    })
    if (!resolved) return

    const title = await generateThreadTitle({
      threadId,
      turnId,
      modelClient: this.deps.model,
      model: resolved.model,
      ...(resolved.providerId ? { providerId: resolved.providerId } : {}),
      ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
      userText,
      ...(roles?.titleReasoningEffort
        ? { reasoningEffort: roles.titleReasoningEffort }
        : {}),
      ...(signal ? { abortSignal: signal } : {})
    })
    if (!title) return

    const updated = await withThreadStoreMutation(this.deps.threadStore, threadId, async () => {
      const latest = await this.deps.threadStore.get(threadId)
      if (!latest || !canUpgradeThreadTitle(latest)) return null
      const next = touchThread({ ...latest, title, titleAuto: true }, this.deps.nowIso())
      await this.deps.threadStore.upsert(next)
      return next
    })
    if (!updated) return
    await this.deps.events.record({
      kind: 'thread_updated',
      threadId,
      title: updated.title,
      titleAuto: true,
      status: updated.status
    })
  }
}
