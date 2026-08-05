/**
 * Orders durable settings intent and the post-save artifact preparation that
 * must finish before Main reconciles that intent with the managed Runtime.
 */
export class RuntimeSettingsIntentSequencer {
  private generation = 0
  private persistenceTail: Promise<void> = Promise.resolve()

  get currentGeneration(): number {
    return this.generation
  }

  /** Reserve ownership immediately after a settings snapshot becomes durable. */
  reserve(): number {
    this.generation += 1
    return this.generation
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation
  }

  /** Serialize durable settings commits with guarded rollback commits. */
  serializePersistence<Value>(operation: () => Promise<Value>): Promise<Value> {
    const committed = this.persistenceTail.then(operation, operation)
    this.persistenceTail = committed.then(() => undefined, () => undefined)
    return committed
  }

}
