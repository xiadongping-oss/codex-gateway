// Codex Gateway · 账号降级（failover）判定
//
// 【只对 429 / 401 降级，这不是「重试未知」】
//   请求已经发出去、响应也完整收到了，说明这条通道**明确不可用**，而不是「结果未知」。
//   上游根本没受理，换一个账号重放不会重复计费、也不会重复产生副作用。
//   超时、连接中断、响应读到一半断掉都属于结果未知，一律不重发——那才是会出事的重试。
//
// 【为什么按状态码分开冷却】
//   429 是额度窗口耗尽。5 小时窗口内通常不会自己恢复，但**别的模型可能还有量**，
//   所以冷却只给 5 分钟：宁可多试一次，也别把一个只是某个模型打满的账号整段拉黑。
//   401 是 token 失效，重新授权前都不会好，给 15 分钟；但也不能永久拉黑，
//   用户重新登录之后必须能立刻复活，所以是「到期自动解除」而不是标记删除。

export const FAILOVER_STATUSES = new Set([429, 401])

// 429：额度窗口；401：凭据失效。两者恢复速度差一个量级，冷却时间也就不同。
export const DEFAULT_DEGRADE_MS = { 429: 5 * 60_000, 401: 15 * 60_000 }

// 单次请求最多换几个账号。超过这个数说明整组账号都不健康，
// 继续换只是把用户等待时间拉长，不如把真实状态码尽快返回。
export const DEFAULT_MAX_ATTEMPTS = 2

export function isFailoverStatus(status) {
  const n = Number(status)
  return FAILOVER_STATUSES.has(n)
}

export function createFailoverPolicy({ maxAttempts = DEFAULT_MAX_ATTEMPTS, degradeMs = DEFAULT_DEGRADE_MS, now = () => Date.now() } = {}) {
  const degradedUntil = new Map()
  const stats = { attempts: 0, succeeded: 0, exhausted: 0, skippedNoAuth: 0, skippedDegraded: 0 }

  function isDegraded(accountId) {
    if (!accountId) return false
    const until = degradedUntil.get(accountId)
    if (!until) return false
    if (now() >= until) {
      degradedUntil.delete(accountId)
      return false
    }
    return true
  }

  function markDegraded(accountId, status) {
    if (!accountId) return false
    const ttl = degradeMs[Number(status)]
    if (!ttl) return false
    degradedUntil.set(accountId, now() + ttl)
    return true
  }

  // 判定这一次响应值不值得换账号重放。四个条件缺一不可：
  //   1) 状态码是 429/401——别的错误换账号也没用（400 是请求本身的问题，5xx 是上游故障）
  //   2) 请求体还留着——流式转发过的请求没法重放，硬重放会发出一个空 body
  //   3) 这个请求有确定的账号归属——没有归属就不知道该把谁标记为「不可用」
  //   4) 还没到重试上限
  function canRetry({ status, attempt, canReplay, accountId } = {}) {
    if (!isFailoverStatus(status)) return false
    if (!canReplay) return false
    if (!accountId) return false
    return Number(attempt || 0) < maxAttempts
  }

  // 选下一个目标账号。
  // 从「当前账号的下一位」开始环形遍历，而不是每次都从第一个找起：
  // 否则 A、B 一起坏的时候，请求会永远在 A→B→A 之间打转，C 永远轮不到。
  //
  // accounts 需要由调用方预先补好 hasAuth（这个模块不碰文件系统，纯逻辑好测）。
  function pickNext(accounts, currentId) {
    const list = Array.isArray(accounts) ? accounts : []
    const idx = list.findIndex((a) => a && a.id === currentId)
    const ordered = idx >= 0 ? [...list.slice(idx + 1), ...list.slice(0, idx + 1)] : list
    for (const a of ordered) {
      if (!a || !a.id || a.id === currentId) continue
      if (isDegraded(a.id)) {
        stats.skippedDegraded++
        continue
      }
      if (!a.hasAuth) {
        stats.skippedNoAuth++
        continue
      }
      return a.id
    }
    stats.exhausted++
    return null
  }

  function snapshot() {
    const t = now()
    const degraded = [...degradedUntil.entries()]
      .filter(([, until]) => until > t)
      .map(([accountId, until]) => ({ accountId, remainSec: Math.max(0, Math.round((until - t) / 1000)) }))
    return { degraded, stats: { ...stats }, maxAttempts }
  }

  function reset() {
    degradedUntil.clear()
    for (const k of Object.keys(stats)) stats[k] = 0
  }

  return { isDegraded, markDegraded, canRetry, pickNext, snapshot, reset, maxAttempts }
}
