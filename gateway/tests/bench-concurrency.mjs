#!/usr/bin/env node
// F-03 修复前后对比：bridge 账号切换的并发开销
//
//   运行：node gateway/tests/bench-concurrency.mjs
//
// bridge 子进程起不来也可以跑 —— 这里量的是**调度开销**，不是真实网络。
// doSwitch 用固定 50ms 模拟一次 kill+spawn+健康检查（真实机器上是秒级）。

import { createBridgeScheduler } from '../bridge-scheduler.mjs'

const SWITCH_MS = 50 // 一次切换的固定模拟成本
const HOLD_MS = 5 // 每个请求占用 bridge 的时长（模拟转发）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 旧实现：一根 promise 链把所有请求串起来 ----------
function createLegacySwitcher() {
  let chain = Promise.resolve()
  let loaded = null
  let switches = 0
  let lastSwitchEnd = 0
  const startTimes = []

  function acquire(target) {
    const arrived = Date.now()
    const task = chain.then(async () => {
      startTimes.push(Date.now() - arrived) // 排队 + 切换后才开始服务
      if (loaded === target) return
      loaded = target
      switches++
      await sleep(SWITCH_MS)
      lastSwitchEnd = Date.now()
      return
    })
    chain = task.then(() => {}, () => {})
    return task
  }
  return {
    acquire,
    stats: () => ({ switches, parallel: '串行=1', maxQueueWaitMs: Math.max(...startTimes, 0) })
  }
}

// ---------- 新实现：多读者 / 单写者 ----------
function createNewSwitcher() {
  const sched = createBridgeScheduler({})
  let loadedAt = null
  const startTimes = []
  return {
    acquire: async (target) => {
      if (loadedAt === null) { sched.setLoaded(target); loadedAt = target }
      const arrived = Date.now()
      const slot = await sched.acquire(target, async (t) => {
        await sleep(SWITCH_MS)
        sched.setLoaded(t)
      })
      startTimes.push(Date.now() - arrived)
      return slot
    },
    stats: () => ({
      switches: sched.stats().switches,
      parallel: sched.stats().parallelPeak,
      maxQueueWaitMs: Math.max(...startTimes, 0)
    })
  }
}

async function scenario(name, targets, factory) {
  const sw = factory()
  const arrived = Date.now()
  await Promise.all(
    targets.map(async (t) => {
      const slot = await sw.acquire(t)
      await sleep(HOLD_MS) // 占用一段时间，模拟真实转发占用
      if (slot && slot.release) slot.release()
    })
  )
  const totalMs = Date.now() - arrived
  const s = sw.stats()
  return { name, totalMs, switches: s.switches, parallel: s.parallel, maxWaitMs: s.maxQueueWaitMs }
}

const pad = (s, n) => String(s).padEnd(n, ' ')
const repeat = (t, n) => Array.from({ length: n }, () => t)

const cases = [
  ['① 12 个并发 · 全部同一账号（你当前的真实形态）', repeat('A', 12)],
  ['② 12 个并发 · 两账号交替到达', Array.from({ length: 6 }, () => ['A', 'B']).flat()],
  ['③ 20 个并发 · 单账号突发', repeat('A', 20)]
]

console.log('\n bridge 账号调度 · 修复前后对比（切换模拟成本 ' + SWITCH_MS + 'ms，转发占用 ' + HOLD_MS + 'ms）\n')
console.log('  ' + pad('场景', 44) + pad('方案', 8) + pad('总耗时', 10) + pad('切换次数', 10) + pad('并行峰值', 10) + '最长排队')
console.log('  ' + '─'.repeat(92))

for (const [name, targets] of cases) {
  const before = await scenario(name, targets, createLegacySwitcher)
  const after = await scenario(name, targets, createNewSwitcher)
  console.log(
    `  ${pad(name, 44)}${pad('修复前', 8)}${pad(before.totalMs + 'ms', 10)}${pad(before.switches, 10)}${pad(1, 10)}${before.maxWaitMs}ms`
  )
  console.log(
    `  ${pad('', 44)}${pad('修复后', 8)}${pad(after.totalMs + 'ms', 10)}${pad(after.switches, 10)}${pad(after.parallel, 10)}${after.maxWaitMs}ms`
  )
  const better = before.totalMs / after.totalMs
  console.log(`  ${pad('', 44)}  → 吞吐提升 ${better.toFixed(1)}×   ${'─'.repeat(40)}\n`)
}

console.log('  说明：')
console.log('  · 「并行峰值」= 同时在转发、互不阻塞的请求数。修复前恒为 1（被 promise 链串死）。')
console.log('  · 「切换次数」= bridge 进程重启次数。这是真正昂贵的操作，真实机器上每次都是秒级。')
console.log('  · 场景①是重点：单账号本不该有任何等待，修复前却仍要逐个穿过串行链。\n')
