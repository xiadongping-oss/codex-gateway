// bridge 实例的多读者 / 单写者调度器
//
// 背景（原 F-03）：bridge 是**单一子进程**，`authFilePath` 是它的全局状态。
// 「切账号」= kill + spawn + 健康等待，一次就是秒级。原实现用一根 promise 链把
// **所有** /v1 请求串起来，带来两个后果：
//   1) 吞吐塌方：目标账号明明早就加载好了，请求还是要一个个排队穿过那根链；
//   2) TOCTOU 串号：`ensureBridgeForAccount` 返回后立刻转发，期间别人可能已经
//      把 bridge 切走 —— 请求按自己的 Key 算完归属，真正发出去却是别人的凭据。
//
// 新语义：把 bridge 视作一份「可被多个读者共享、偶尔被写者独占」的资源。
//   · 读者 = 目标账号与当前已加载账号一致的请求 → 完全并行，互不阻塞
//   · 写者 = 需要把 bridge 切到另一个账号的请求 → 必须等所有读者退场才动手
// 于是单账号场景零等待、零切换；多账号场景既保住并行度，也不会再串号。
//
// 参考：
//   · sub2api —— 粘性会话 + 单账号并发上限
//   · model-gateway sidecars/codex-local —— imageConcurrency（limit / maxQueue /
//     幂等 release / drain 出队）与 accountModelCooldown（瞬时故障递增冷却）
//
// 刻意不做的事：**不在这里自动重试或 failover**。model-gateway 的不变量里写着
// 「只提交一次 / 结果未知不重发」，网关擅自换账号重发会让调用方无法对账。
// 账号失效应该报错交给上层，而不是在这里悄悄换一个。

const DEFAULT_IDLE_TIMEOUT_MS = 60_000

export function createBridgeScheduler(options = {}) {
  const now = options.now || (() => Date.now())
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const onEvent = options.onEvent || (() => {})

  let loaded = null // 当前 bridge 已加载的账号标识；null = 未加载 / 已失效
  let readers = 0 // 依赖 loaded 且在途的请求数
  let pending = [] // FIFO 等待队列
  let draining = false // drain 循环是否在跑（防止重入）

  const idleWaiters = new Set()
  const stats = {
    switches: 0, // 实际发生的切换次数
    switchMs: 0, // 切换累计耗时
    waitMs: 0, // 所有请求累计等待
    requests: 0, // 受理请求数
    parallelPeak: 0, // 观测到的最大并行读者数
    forcedDrains: 0 // 等读者退场超时的次数（异常信号）
  }

  // release 必须幂等：转发链路上有多条结束路径（finish / close / 异常），
  // 重复扣减会把 readers 打成负数，进而让写者提前动手 —— 又回到 TOCTOU。
  function once(fn) {
    let used = false
    return (...args) => {
      if (used) return
      used = true
      return fn(...args)
    }
  }

  function notifyIdle() {
    if (readers > 0) return
    for (const w of [...idleWaiters]) {
      clearTimeout(w.timer)
      idleWaiters.delete(w)
      w.resolve(false)
    }
  }

  // 等所有读者退场。返回 true 表示等超时了。
  function waitIdle(timeoutMs) {
    if (readers === 0) return Promise.resolve(false)
    return new Promise((resolve) => {
      const w = { resolve }
      w.timer = setTimeout(() => {
        idleWaiters.delete(w)
        stats.forcedDrains++
        resolve(true)
      }, timeoutMs)
      idleWaiters.add(w)
    })
  }

  function grantReader(waiter) {
    readers++
    if (readers > stats.parallelPeak) stats.parallelPeak = readers
    stats.waitMs += now() - waiter.startedAt
    waiter.resolve({ release: once(releaseReader) })
  }

  function releaseReader() {
    readers = Math.max(0, readers - 1)
    notifyIdle()
  }

  // 把队列里前 target 相同的一批一次性放行 —— 这就是「同账号并行」的来源。
  function grantBatch(target, prefix = '') {
    const batch = pending.filter((w) => w.target === target)
    pending = pending.filter((w) => w.target !== target)
    for (const w of batch) grantReader(w)
    if (batch.length > 1) onEvent('info', `${prefix}放行 ${batch.length} 个并发请求到同一账号`)
    return batch.length
  }

  function rejectBatch(target, err) {
    const batch = pending.filter((w) => w.target === target)
    pending = pending.filter((w) => w.target !== target)
    for (const w of batch) w.reject(err)
    return batch.length
  }

  async function drain() {
    if (draining) return
    draining = true
    try {
      while (pending.length > 0) {
        const head = pending[0]

        // 目标已经生效 → 整批放行（哪怕队首是上一轮刚切完的目标）
        if (loaded !== null && loaded === head.target) {
          grantBatch(head.target)
          continue
        }

        // 需要独占：先让所有依赖当前 loaded 的读者退场。
        // 这一步是消除 TOCTOU 的关键 —— 切换期间不可能有人在转发。
        if (readers > 0) {
          const timedOut = await waitIdle(idleTimeoutMs)
          if (timedOut) {
            onEvent(
              'warn',
              `等待 ${readers} 个在途请求结束超时（${idleTimeoutMs}ms）后强制切换账号。` +
                '通常是超长流式请求未结束；这种情况下队列已被让出，新的串号风险需知悉。'
            )
          }
        }

        const t0 = now()
        try {
          await head.doSwitch(head.target)
        } catch (err) {
          // 切换失败：整批拒绝，loaded 保持不变（没有切换成功就不该改状态）
          rejectBatch(head.target, err)
          continue
        }
        stats.switches++
        stats.switchMs += now() - t0
        loaded = head.target
        // 下一轮循环会命中上面的「已生效」分支，把整批放出去
      }
    } finally {
      draining = false
      notifyIdle()
      // drain 期间可能有新请求入队且没人接手，补一次
      if (pending.length > 0) drain()
    }
  }

  return {
    /**
     * 获取一个使用 bridge 的名额。
     * @param target   目标账号标识（auth 文件路径）
     * @param doSwitch 真正执行切换的回调，仅在需要时被 await 一次
     * @returns {Promise<{release:Function}>} release 幂等，转发结束后必须调用
     */
    acquire(target, doSwitch) {
      stats.requests++
      const startedAt = now()

      // 快路径：目标已加载、且队列里没有更早的等待者（不能插队，否则长尾请求会饿死写者）
      if (loaded !== null && loaded === target && pending.length === 0 && !draining) {
        readers++
        if (readers > stats.parallelPeak) stats.parallelPeak = readers
        stats.waitMs += now() - startedAt
        return Promise.resolve({ release: once(releaseReader) })
      }

      return new Promise((resolve, reject) => {
        pending.push({ target, doSwitch, resolve, reject, startedAt })
        // 首位入队者开闸
        if (pending.length === 1) drain()
      })
    },

    // bridge 被外部启停/重启时同步状态，避免「以为还加载着其实已经死了」
    setLoaded(target) {
      loaded = target || null
    },
    forget() {
      loaded = null
    },
    loaded() {
      return loaded
    },
    waiting() {
      return pending.length
    },
    readers() {
      return readers
    },
    stats() {
      return { ...stats, waiting: pending.length, readers, loaded }
    }
  }
}
