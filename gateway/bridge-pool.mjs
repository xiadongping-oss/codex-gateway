// 按账号的 bridge 实例池（F-03 二期）
//
// ---- 一期为什么不够 ----
// 一期（原 bridge-scheduler.mjs）把「切换次数」从请求量级压到账号量级，
// 但每一次切换本身仍是 kill + spawn + 等健康，秒级。只要账号多于一个、
// 且请求交替到来，就还是会在切换上排队。
//
// ---- 为什么不走「转发层换 Authorization 头」 ----
// vendored chatgpt-bridge 的 `Auth.load()` 在启动时读一次 auth 文件，把
// accessToken / refreshToken 缓存在实例字段里，之后所有转发都从该缓存取
// （dist/cli.js 的 Auth 类）。转发层**没有 per-request 凭据入口**。
// 想按请求换头，等于重写它的鉴权核心；而这个包上还叠着 4 组手写补丁
// （bridge-patches.mjs），一升级就冲突。风险远大于收益。
//
// ---- 采用的方案：一个账号一个 bridge 进程 ----
// 切换 = 选端口。冷启动只在某账号第一次被用到时发生一次，之后：
//   · 任意账号的请求直接打到自己那个端口，**零重启、零等待**；
//   · 不同账号的请求真正并行，不存在「谁在等谁」；
//   · 顺带修掉一个隐患：token 过期时 bridge 会 writeAuthFile 回写 auth 文件，
//     单进程来回切换时存在「A 的刷新结果写进 B 的文件」的可能；一账号一进程
//     后各自只写自己的文件，物理隔离。
//
// ---- 代价与兜底 ----
//   · 每个常驻实例约占 60–90MB（Node 进程基线）；
//   · 非 pinned（当前激活账号）的实例空闲 idleTimeoutMs 后回收；
//   · 实例总数上限 maxInstances，超出时按 LRU 淘汰空闲实例；
//     全都在忙则**明确报错**，不做「假装成功」的静默降级。
//
// 刻意不做：自动 failover / 换账号重发。沿用 model-gateway 的不变量
// 「只提交一次 / 结果未知不重发」——网关擅自换账号重发会让调用方无法对账。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const DEFAULTS = {
  basePort: 10531,
  maxInstances: 6,
  idleTimeoutMs: 15 * 60_000,
  startTimeoutMs: 20_000,
  probeIntervalMs: 100,
  reapIntervalMs: 30_000
}

function once(fn) {
  let used = false
  return (...args) => {
    if (used) return
    used = true
    return fn(...args)
  }
}

/**
 * @param {object} options
 * @param {(key:string, port:number)=>import('node:child_process').ChildProcess} options.spawn
 *        真正拉起一个 bridge 子进程。必须同步返回 child。
 * @param {(port:number)=>Promise<{listening:boolean,status?:number}>} options.probe
 *        探测端口是否已开始接受 HTTP 连接。**任意 HTTP 响应都算 listening**——
 *        bridge 在未登录时 /health 返回 503，用 200 判定会永远等不到。
 * @param {(key:string)=>boolean} [options.isPinned] 不参与空闲回收的实例（通常是当前激活账号）
 */
export function createBridgePool(options = {}) {
  if (typeof options.spawn !== 'function') throw new Error('createBridgePool 需要 spawn')
  if (typeof options.probe !== 'function') throw new Error('createBridgePool 需要 probe')

  const basePort = options.basePort ?? DEFAULTS.basePort
  const maxInstances = Math.max(1, options.maxInstances ?? DEFAULTS.maxInstances)
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULTS.startTimeoutMs
  const probeIntervalMs = options.probeIntervalMs ?? DEFAULTS.probeIntervalMs
  const reapIntervalMs = options.reapIntervalMs ?? DEFAULTS.reapIntervalMs

  const spawnFn = options.spawn
  const probe = options.probe
  const log = options.log || (() => {})
  const now = options.now || (() => Date.now())
  const labelOf = options.label || ((key) => key)
  const isPinned = options.isPinned || (() => false)

  const liveChildren = new Set()
  let draining = false
  const instances = new Map() // key -> inst
  let seq = 0
  const stats = {
    starts: 0, // 真正拉起进程的次数
    stops: 0, // 主动停止次数（含回收/淘汰）
    reaps: 0, // 空闲回收次数
    evictions: 0, // 池满淘汰次数
    acquires: 0, // 受理请求数
    failures: 0, // 启动失败次数
    totalWaitMs: 0, // 请求拿到端口前的累计等待（冷启动会显著拉高）
    portConflicts: 0 // 端口被外部占用的次数
  }

  // 槽位 → 端口是稳定映射：basePort + slot。同一账号短期内复用同一端口，
  // 排查时看日志里的端口就能对应上账号，不必反查内部映射。
  function freeSlot() {
    const used = new Set()
    for (const inst of instances.values()) used.add(inst.slot)
    for (let s = 0; s < maxInstances; s++) if (!used.has(s)) return s
    return -1
  }

  function pickVictim(exceptKey) {
    let best = null
    for (const inst of instances.values()) {
      if (inst.key === exceptKey) continue
      if (inst.state !== 'ready') continue
      if (inst.inflight > 0) continue
      if (isPinned(inst.key)) continue
      if (!best || inst.lastUsed < best.lastUsed) best = inst
    }
    return best
  }

  function killInstance(inst, reason) {
    if (!inst) return false
    const wasLive = inst.state === 'ready' || inst.state === 'starting'
    inst.state = 'stopped'
    if (instances.get(inst.key)?.id === inst.id) instances.delete(inst.key)
    const c = inst.child
    if (c && c.exitCode == null) {
      try { c.kill('SIGTERM') } catch {}
      // 给子进程体面退出的机会，但不让调用方 hang 住
      const t = setTimeout(() => {
        try { if (c.exitCode == null) c.kill('SIGKILL') } catch {}
      }, 1200)
      if (t.unref) t.unref()
    }
    if (wasLive) {
      stats.stops++
      log(`· 停止 bridge[${labelOf(inst.key)}]（端口 ${inst.port}，${reason}）`)
    }
    return true
  }

  async function waitListening(inst) {
    const deadline = now() + startTimeoutMs
    let last = null
    while (now() < deadline) {
      if (inst.state === 'stopped') return { listening: false, reason: 'stopped' }
      try {
        const r = await probe(inst.port)
        last = r
        if (r && r.listening) return { listening: true, status: r.status }
      } catch {
        // 端口还没起来时 connect 会被拒，属正常，继续等
      }
      await sleep(probeIntervalMs)
    }
    return { listening: false, reason: 'timeout', last }
  }

  function startInstance(key) {
    if (draining) return Promise.reject(new Error('gateway_shutting_down'))
    const existing = instances.get(key)
    // 并发 acquire 必须共用同一次启动，否则会同时拉起两个进程抢同一端口
    if (existing && existing.state === 'starting') return existing.startPromise

    let slot = freeSlot()
    if (slot < 0) {
      const victim = pickVictim(key)
      if (!victim) {
        return Promise.reject(
          new Error(
            `bridge 实例池已满（上限 ${maxInstances}），且没有空闲实例可淘汰。` +
              '调大 CGW_BRIDGE_POOL_MAX，或减少同时使用的账号数。'
          )
        )
      }
      stats.evictions++
      log(`· 实例池已满，淘汰最久未用的 bridge[${labelOf(victim.key)}]（端口 ${victim.port}）`)
      killInstance(victim, 'evict')
      slot = freeSlot()
      if (slot < 0) return Promise.reject(new Error('实例池淘汰后仍无可用槽位'))
    }

    const port = basePort + slot
    const inst = {
      id: ++seq,
      key,
      slot,
      port,
      child: null,
      state: 'starting',
      startedAt: null,
      lastUsed: now(),
      inflight: 0,
      lastStatus: null,
      startPromise: null
    }
    instances.set(key, inst)
    stats.starts++

    inst.startPromise = (async () => {
      let child
      try {
        child = spawnFn(key, port)
      } catch (e) {
        killInstance(inst, 'spawn-failed')
        stats.failures++
        throw new Error(`bridge 启动失败（端口 ${port}）：${e.message}`)
      }
      inst.child = child
      if (child && typeof child.on === 'function') {
        liveChildren.add(child)
        child.on('exit', () => liveChildren.delete(child))
        child.on('error', () => { if (!child.pid) liveChildren.delete(child) })
        child.on('exit', (code, sig) => {
          // 只有「还是当前这个实例」时才清理，避免旧实例的退出事件
          // 把刚重启起来的新实例从池里误删
          if (instances.get(key)?.id !== inst.id) return
          inst.exitCode = code ?? null
          inst.exitSignal = sig ?? null
          log(`■ bridge[${labelOf(key)}] 退出 code=${code ?? ''} sig=${sig ?? ''}`)
          // 进程已经没了，还在等监听就是白等：把状态推到 stopped，
          // waitListening 下一轮立刻返回，不必耗满 startTimeoutMs（20s）才报错。
          // 否则「二进制缺失 / 端口被占 / 配置错误」这类秒级失败会被放大成 20 秒无响应。
          if (inst.state === 'starting') inst.state = 'stopped'
          instances.delete(key)
        })
        child.on('error', (e) => log(`[spawn error] bridge[${labelOf(key)}]: ${e.message}`))
      }

      const r = await waitListening(inst)
      if (inst.state === 'stopped') {
        const exitNote = inst.exitCode != null
          ? `（进程已退出 code=${inst.exitCode}${inst.exitSignal ? ' sig=' + inst.exitSignal : ''}，多见于二进制缺失或端口被占用）`
          : ''
        throw new Error('启动过程中被停止' + exitNote)
      }
      if (!r.listening) {
        killInstance(inst, 'not-listening')
        stats.failures++
        if (r.reason === 'timeout') stats.portConflicts++
        throw new Error(
          `bridge 未能在 ${startTimeoutMs}ms 内监听端口 ${port}` +
            '（端口可能被其它程序占用，可用 CGW_BRIDGE_BASE_PORT 换一段端口）'
        )
      }
      inst.state = 'ready'
      inst.startedAt = now()
      inst.lastUsed = now()
      inst.lastStatus = r.status ?? null
      // 已监听但 /health 非 200：多为未登录或凭据失效。不当失败处理——
      // 登录流程本身要靠这个实例把登录态写回去。
      if (r.status && r.status !== 200) {
        log(`⚠ bridge[${labelOf(key)}] 已监听但 /health 返回 ${r.status}（多为未登录或凭据失效）`)
      }
      log(`● bridge[${labelOf(key)}] 就绪，端口 ${port}`)
      return inst
    })()

    // 失败即从池里摘掉，避免下一次 acquire 拿到半死的实例
    inst.startPromise.catch(() => {
      if (instances.get(key)?.id === inst.id) instances.delete(key)
    })
    return inst.startPromise
  }

  async function ensure(key) {
    const inst = instances.get(key)
    if (inst && inst.state === 'ready') {
      // 子进程可能已死但 exit 尚未派发；exitCode 非空即视为已死
      if (!inst.child || inst.child.exitCode == null) return inst
      instances.delete(key)
    }
    return startInstance(key)
  }

  const reapTimer = setInterval(() => {
    if (!idleTimeoutMs) return
    for (const inst of [...instances.values()]) {
      if (inst.state !== 'ready') continue
      if (inst.inflight > 0) continue
      if (isPinned(inst.key)) continue
      if (now() - inst.lastUsed < idleTimeoutMs) continue
      stats.reaps++
      log(`· 回收空闲 bridge[${labelOf(inst.key)}]（空闲 ${Math.round((now() - inst.lastUsed) / 1000)}s）`)
      killInstance(inst, 'idle')
    }
  }, reapIntervalMs)
  if (reapTimer.unref) reapTimer.unref()

  return {
    /**
     * 取一个可用实例。冷启动会等到端口开始监听为止。
     * @returns {Promise<{key:string, port:number, release:Function}>}
     *          release 幂等，转发结束后必须调用（用于空闲判定）
     */
    async acquire(key) {
      if (!key) throw new Error('acquire 需要账号标识')
      stats.acquires++
      const t0 = now()
      const inst = await ensure(key)
      inst.inflight++
      inst.lastUsed = now()
      stats.totalWaitMs += now() - t0
      return {
        key,
        port: inst.port,
        release: once(() => {
          inst.inflight = Math.max(0, inst.inflight - 1)
          inst.lastUsed = now()
        })
      }
    },

    // 预热：只启动不占名额，供「切激活账号」时后台提前拉起
    async warm(key) {
      await ensure(key)
      return this.instance(key)
    },

    start(key) {
      return ensure(key).then(
        (inst) => ({ ok: true, port: inst.port }),
        (e) => ({ ok: false, msg: e.message })
      )
    },

    stop(key) {
      const inst = instances.get(key)
      if (!inst) return { ok: false, msg: '未运行' }
      killInstance(inst, 'stop')
      return { ok: true }
    },

    stopAll() {
      const n = instances.size
      for (const key of [...instances.keys()]) killInstance(instances.get(key), 'stop-all')
      return n
    },

    instance(key) {
      const inst = instances.get(key)
      if (!inst) return null
      return {
        key: inst.key,
        port: inst.port,
        state: inst.state,
        pid: inst.child?.pid ?? null,
        startedAt: inst.startedAt,
        lastUsed: inst.lastUsed,
        inflight: inst.inflight,
        healthStatus: inst.lastStatus
      }
    },

    port(key) {
      return instances.get(key)?.port ?? null
    },

    has(key) {
      return instances.get(key)?.state === 'ready'
    },

    list() {
      return [...instances.values()].map((inst) => ({
        key: inst.key,
        label: labelOf(inst.key),
        port: inst.port,
        state: inst.state,
        pid: inst.child?.pid ?? null,
        startedAt: inst.startedAt,
        lastUsed: inst.lastUsed,
        idleSec: inst.startedAt ? Math.round((now() - inst.lastUsed) / 1000) : 0,
        inflight: inst.inflight,
        healthStatus: inst.lastStatus
      }))
    },

    stats() {
      return { ...stats, instances: instances.size, maxInstances, basePort, idleTimeoutMs }
    },

    drain() {
      draining = true
      clearInterval(reapTimer)
    },

    childCount() { return liveChildren.size },

    async stopAndWait(timeoutMs = 5000) {
      this.drain()
      this.stopAll()
      // Includes previously evicted/stopped children, even after their map entry was removed.
      for (const child of liveChildren) { try { child.kill('SIGTERM') } catch {} }
      const start = performance.now()
      while (liveChildren.size && performance.now() - start < timeoutMs) {
        if (performance.now() - start >= Math.min(1200, timeoutMs / 2)) {
          for (const child of liveChildren) { try { child.kill('SIGKILL') } catch {} }
        }
        await sleep(20)
      }
      return liveChildren.size === 0
    },

    // 进程退出前调用：清定时器 + 停所有子进程，避免留下孤儿占着端口
    dispose() {
      this.drain()
      return this.stopAll()
    }
  }
}
