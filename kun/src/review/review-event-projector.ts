import type { RuntimeEvent } from '../contracts/events.js'
import type { TurnItem } from '../contracts/items.js'
import type { TurnService } from '../services/turn-service.js'

type ReviewProjectionTarget = {
  threadId: string
  turnId: string
  reviewItemId: string
}

type AssistantItem = Extract<
  TurnItem,
  { kind: 'assistant_text' | 'assistant_reasoning' }
>

/**
 * Mirrors a reviewer's visible process into the parent review turn.
 *
 * Reasoning and read-only tools use the same durable items/events as a normal
 * turn, so live SSE and later hydration render identically. Assistant text is
 * buffered until the child asks for a tool: this keeps useful pre-tool
 * commentary while withholding the final strict-JSON review payload, which is
 * rendered by the dedicated review result card instead.
 */
export class ReviewEventProjector {
  private queue: Promise<void> = Promise.resolve()
  private failure: unknown
  private readonly accumulatedText = new Map<string, string>()
  private readonly pendingAssistantText = new Map<string, AssistantItem>()
  private readonly persistedItemIds = new Set<string>()
  private readonly flushedAssistantTextIds = new Set<string>()

  constructor(
    private readonly turns: TurnService,
    private readonly target: ReviewProjectionTarget
  ) {}

  enqueue(event: RuntimeEvent): void {
    this.queue = this.queue
      .then(() => this.project(event))
      .catch((error) => {
        this.failure ??= error
      })
  }

  async drain(): Promise<void> {
    await this.queue
    if (this.failure) throw this.failure
  }

  private async project(event: RuntimeEvent): Promise<void> {
    if (event.kind === 'tool_call_ready') {
      await this.flushPendingAssistantText()
      return
    }
    if (event.kind === 'assistant_reasoning_delta') {
      await this.projectAssistantDelta(event.item, event.deltaOffset)
      return
    }
    if (event.kind === 'assistant_text_delta') {
      await this.bufferAssistantDelta(event.item, event.deltaOffset)
      return
    }
    if (!('item' in event)) return

    if (event.item.kind === 'assistant_text') {
      await this.bufferAssistantSnapshot(event.item)
      return
    }
    if (!isVisibleReviewProcessItem(event.item)) return
    if (event.item.kind === 'tool_call') {
      await this.flushPendingAssistantText()
    }

    const projected = this.projectItem(event.item)
    await this.persistSnapshot(projected, event.kind === 'item_created')
  }

  private async projectAssistantDelta(
    item: TurnItem,
    deltaOffset: number | undefined
  ): Promise<void> {
    if (item.kind !== 'assistant_reasoning') return
    const delta = item.text
    if (!delta) return
    const { cumulative, offset } = this.accumulate(item.id, delta, deltaOffset)
    const projected = this.projectItem({ ...item, text: cumulative })
    if (projected.kind !== 'assistant_reasoning') return
    await this.turns.applyAssistantDelta(
      this.target.threadId,
      projected,
      delta,
      offset
    )
  }

  private async bufferAssistantDelta(
    item: TurnItem,
    deltaOffset: number | undefined
  ): Promise<void> {
    if (item.kind !== 'assistant_text' || !item.text) return
    const { cumulative, offset } = this.accumulate(item.id, item.text, deltaOffset)
    const projected = this.projectItem({ ...item, text: cumulative })
    if (projected.kind !== 'assistant_text') return
    if (this.flushedAssistantTextIds.has(item.id)) {
      await this.turns.applyAssistantDelta(
        this.target.threadId,
        projected,
        item.text,
        offset
      )
      return
    }
    this.pendingAssistantText.set(item.id, projected)
  }

  private async bufferAssistantSnapshot(item: AssistantItem): Promise<void> {
    if (item.kind !== 'assistant_text') return
    this.accumulatedText.set(item.id, item.text)
    const projected = this.projectItem(item)
    if (projected.kind !== 'assistant_text') return
    if (this.flushedAssistantTextIds.has(item.id)) {
      await this.persistSnapshot(projected, false)
      return
    }
    this.pendingAssistantText.set(item.id, projected)
  }

  private async flushPendingAssistantText(): Promise<void> {
    for (const [childItemId, item] of this.pendingAssistantText) {
      if (!item.text.trim()) continue
      await this.persistSnapshot(item, true)
      this.flushedAssistantTextIds.add(childItemId)
    }
    this.pendingAssistantText.clear()
  }

  private async persistSnapshot(item: TurnItem, preferCreate: boolean): Promise<void> {
    if (preferCreate && !this.persistedItemIds.has(item.id)) {
      await this.turns.applyItem(this.target.threadId, item)
      this.persistedItemIds.add(item.id)
      return
    }
    const updated = await this.turns.updateItem(this.target.threadId, item.id, item)
    if (updated) {
      this.persistedItemIds.add(item.id)
      return
    }
    await this.turns.applyItem(this.target.threadId, item)
    this.persistedItemIds.add(item.id)
  }

  private accumulate(
    childItemId: string,
    delta: string,
    requestedOffset: number | undefined
  ): { cumulative: string; offset: number } {
    const previous = this.accumulatedText.get(childItemId) ?? ''
    const offset = requestedOffset === undefined
      ? previous.length
      : Math.max(0, Math.min(requestedOffset, previous.length))
    const cumulative = `${previous.slice(0, offset)}${delta}`
    this.accumulatedText.set(childItemId, cumulative)
    return { cumulative, offset }
  }

  private projectItem(item: TurnItem): TurnItem {
    const projected = {
      ...item,
      id: this.projectedItemId(item.id),
      threadId: this.target.threadId,
      turnId: this.target.turnId,
      ...('callId' in item ? { callId: this.projectedCallId(item.callId) } : {}),
      ...(item.kind === 'compaction' && item.sourceItemIds
        ? { sourceItemIds: item.sourceItemIds.map((id) => this.projectedItemId(id)) }
        : {})
    }
    return projected as TurnItem
  }

  private projectedItemId(childItemId: string): string {
    return `${this.target.reviewItemId}:process:${childItemId}`
  }

  private projectedCallId(childCallId: string): string {
    return `${this.target.reviewItemId}:process:${childCallId}`
  }
}

function isVisibleReviewProcessItem(item: TurnItem): boolean {
  return item.kind === 'assistant_reasoning' ||
    item.kind === 'tool_call' ||
    item.kind === 'tool_result' ||
    item.kind === 'compaction'
}
