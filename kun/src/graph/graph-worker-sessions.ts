export type GraphWorkerSessionBinding = {
  runId: string
  nodeId: string
  attemptId: string
}

export class GraphWorkerSessionRegistry {
  private readonly bindings = new Map<string, GraphWorkerSessionBinding>()

  bind(childThreadId: string, binding: GraphWorkerSessionBinding): void {
    this.bindings.set(childThreadId, binding)
  }

  get(childThreadId: string): GraphWorkerSessionBinding | undefined {
    return this.bindings.get(childThreadId)
  }

  has(childThreadId: string): boolean {
    return this.bindings.has(childThreadId)
  }

  release(childThreadId: string): void {
    this.bindings.delete(childThreadId)
  }

  clearRun(runId: string): void {
    for (const [childThreadId, binding] of this.bindings) {
      if (binding.runId === runId) this.bindings.delete(childThreadId)
    }
  }
}
