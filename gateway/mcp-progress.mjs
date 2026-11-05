// Report elapsed waiting time, never an invented completion percentage.
export function startMcpProgress(params, send, { intervalMs = 10000, heartbeat = () => {} } = {}) {
  const token = params?._meta?.progressToken
  const started = Date.now()
  const timer = setInterval(() => {
    if (typeof token === 'string' || typeof token === 'number') {
      send({ jsonrpc: '2.0', method: 'notifications/progress', params: {
        progressToken: token, progress: (Date.now() - started) / 1000,
        message: '图片仍在生成，请继续等待。'
      } })
    } else heartbeat()
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
