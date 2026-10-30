// Shared shutdown state machine. Injected operations make failure/deadline tests deterministic.
export function createShutdownManager({ runtime, emit = () => {}, finish, drainMs = 30_000, cleanupMs = 5000, now = () => performance.now() }) {
  let state = 'ready', phase = null, waiting = false, forced = false, busy = false
  let deadline = 0, overallDeadline = null, lastProgress = -Infinity, timer
  let waitingReason = null, requestedCode = 0
  const counts = () => runtime.counts()
  function status() { return { state, phase, waiting, ...counts() } }
  function wait(reason) {
    waiting = true
    waitingReason = reason
    emit('shutdown.waiting', { state, ...counts(), reason })
  }
  async function tick() {
    if (busy || state === 'stopped') return
    busy = true
    try {
      if (now() - lastProgress >= 1000) {
        lastProgress = now()
        emit('shutdown.progress', { state, phase, ...counts(), remainingMs: Math.max(0, Math.ceil(deadline - now())) })
      }
      if (overallDeadline !== null && now() >= overallDeadline - Math.min(1500, cleanupMs / 2)) forced = true
      const { activeRequests, backgroundTasks } = counts()
      if (!forced && activeRequests + backgroundTasks > 0) {
        if (!waiting && now() >= deadline) wait('DRAIN_TIMEOUT')
        return
      }
      if (waitingReason === 'FLUSH_FAILED' && !forced) return
      if (forced) runtime.cancel()
      const cleanupEnd = overallDeadline ?? now() + cleanupMs
      phase = 'flush'
      let persisted = false
      try { await runtime.flush(); persisted = true } catch {
        if (!forced) { wait('FLUSH_FAILED'); return }
      }
      waiting = false
      state = 'stopping'
      phase = 'stop-children'
      const end = cleanupEnd
      const remaining = () => Math.max(0, end - now())
      let childrenExited = false, httpClosed = false, released = false
      try { childrenExited = await runtime.stopChildren(remaining()) } catch {}
      phase = 'close-http'
      try { httpClosed = await runtime.closeHttp(remaining()) } catch {}
      // Socket close callbacks can precede aborted-body handlers and their finally
      // blocks. Give tracked cancellations the remaining cleanup budget to settle.
      while (remaining() > 0) {
        const pending = counts()
        if (!pending.activeRequests && !pending.backgroundTasks) break
        await new Promise(resolve => setTimeout(resolve, Math.min(10, remaining())))
      }
      // Forced cancellations may settle and record final usage during child/socket cleanup.
      try { await runtime.flush() } catch { persisted = false }
      const pending = counts()
      if (pending.activeRequests + pending.backgroundTasks) persisted = false
      if (childrenExited && httpClosed && !pending.activeRequests && !pending.backgroundTasks) {
        try { released = runtime.release() !== false } catch {}
      }
      const success = persisted && childrenExited && httpClosed && released
      const exitCode = requestedCode || (!success ? 1 : forced ? 4 : 0)
      state = 'stopped'
      clearInterval(timer)
      const result = { state, outcome: !success || requestedCode ? 'failed' : forced ? 'forced' : 'graceful', persisted, childrenExited, exitCode }
      emit('stopped', result)
      await finish(result)
    } finally { busy = false }
  }
  return {
    status,
    begin({ urgent = false, exitCode = 0 } = {}) {
      requestedCode ||= exitCode
      if (state === 'stopped') return
      if (urgent && overallDeadline === null) overallDeadline = now() + cleanupMs
      if (state !== 'ready') return
      state = 'draining'; phase = 'drain'; deadline = now() + drainMs
      runtime.drain()
      timer = setInterval(() => { void tick() }, 25)
    },
    continue() {
      if (!waiting || state !== 'draining') return false
      waiting = false; waitingReason = null; deadline = now() + drainMs
      return true
    },
    force() {
      if (!waiting || state !== 'draining') return false
      forced = true; waiting = false; waitingReason = null
      return true
    }
  }
}
