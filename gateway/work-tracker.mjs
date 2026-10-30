// Explicit ownership of asynchronous work; a disconnected response is not task completion.
export function createWorkTracker() {
  const work = new Set()
  let draining = false
  return {
    get draining() { return draining },
    drain() { draining = true },
    begin(kind = 'background', cancel = () => {}) {
      const item = { kind, cancel }
      work.add(item)
      return () => work.delete(item)
    },
    async track(promise, kind = 'background') {
      const end = this.begin(kind)
      try { return await promise } finally { end() }
    },
    cancel() { for (const item of work) { try { item.cancel() } catch {} } },
    counts() {
      return { activeRequests: [...work].filter(x => x.kind === 'request').length,
        backgroundTasks: [...work].filter(x => x.kind !== 'request').length }
    },
    get size() { return work.size }
  }
}

export const gatewayWork = createWorkTracker()
