#!/usr/bin/env node
// F-03 修复前后对比：bridge 账号切换的并发开销
//
//   运行：node gateway/tests/bench-concurrency.mjs
//
// bridge 子进程起不来也能跑 —— 这里量的是**调度开销**，不是真实网络。
// 冷启动用固定 BOOT_MS 模拟一次 spawn + 等端口监听（真实机器上是秒级）。

import { createBridgePool } from '../bridge-pool.mjs'

const BOOT_MS = 50 // 一次冷启动的固定模拟成本（spawn + 等端口）
const HOLD_MS = 5 // 每个请求占用实例的时长（模拟转发）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 修复前：一根 promise 链把所有请求串起来 ----------
function createLegacySwitcher() {
  let chain = Promise.resolve()
  let loaded = null
  let switches = 0
  const startTimes = []

  function acquire(target) {
    const arrived = Date.now()
    const task = chain.then(async () => {
      if (loaded !== target) {
        loaded = target
        switches++
        await sleep(BOOT_MS)
      }
      // 与实例池口径对齐：记录「多久之后才能真正开始转发」
      startTimes.push(Date.now() - arrived)
    })
    chain = task.then(() => {}, () => {})
    return task
  }
  return {
    acquire,
    stats: () => ({ switches, maxQueueWaitMs: Math.max(...startTimes, 0) })
  }
}

// ---------- 修复后（二期）：一账号一实例，切换 = 选端口 ----------
function createPoolSwitcher() {
  const startTimes = []
  const pool = createBridgePool({
    basePort: 30000,
    maxInstances: 8,
    idleTimeoutMs: 0, // 基准里不回收，专测「热」路径
    startTimeoutMs: 5000,
    probeIntervalMs: 5,
    spawn: () => ({ pid: 1, exitCode: null, kill() { this.exitCode = 0 }, on() {} }),
    probe: async () => {
      await sleep(BOOT_MS)
      return { listening: true, status: 200 }
    },
    log: () => {}
  })
  return {
    acquire: async (target) => {
      const arrived = Date.now()
      const slot = await pool.acquire(target)
      startTimes.push(Date.now() - arrived)
      return slot
    },
    stats: () => ({ switches: pool.stats().starts, maxQueueWaitMs: Math.max(...startTimes, 0) })
  }
}

async function scenario(targets, factory) {
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
  return { totalMs, ...s }
}

const pad = (s, n) => String(s).padEnd(n, ' ')
const repeat = (t, n) => Array.from({ length: n }, () => t)

const cases = [
  ['① 12 并发 · 全部同一账号（你当前的真实形态）', repeat('A', 12)],
  ['② 12 并发 · 两账号交替到达', Array.from({ length: 6 }, () => ['A', 'B']).flat()],
  ['③ 20 并发 · 单账号突发', repeat('A', 20)],
  ['④ 24 请求 · 两账号严格交替（最坏形态）', Array.from({ length: 24 }, (_, i) => (i % 2 ? 'B' : 'A'))]
]

console.log(`\n bridge 账号调度 · 修复前后对比（冷启动 ${BOOT_MS}ms，转发占用 ${HOLD_MS}ms）\n`)
console.log(
  '  ' + pad('场景', 46) + pad('方案', 10) + pad('总耗时', 10) + pad('冷启动次数', 12) + pad('并行通道', 10) + '最长等待'
)
console.log('  ' + '─'.repeat(96))

for (const [name, targets] of cases) {
  const before = await scenario(targets, createLegacySwitcher)
  const after = await scenario(targets, createPoolSwitcher)
  const channels = new Set(targets).size
  console.log(
    `  ${pad(name, 46)}${pad('修复前', 10)}${pad(before.totalMs + 'ms', 10)}${pad(before.switches, 12)}${pad(1, 10)}${before.maxQueueWaitMs}ms`
  )
  console.log(
    `  ${pad('', 46)}${pad('修复后', 10)}${pad(after.totalMs + 'ms', 10)}${pad(after.switches, 12)}${pad(channels, 10)}${after.maxQueueWaitMs}ms`
  )
  const better = before.totalMs / after.totalMs
  console.log(`  ${pad('', 46)}  → 吞吐提升 ${better.toFixed(1)}×   ${'─'.repeat(38)}\n`)
}

console.log('  说明：')
console.log('  · 「冷启动次数」= 真正拉起 bridge 进程的次数。真实机器上每次秒级，是最贵的操作。')
console.log('  · 「并行通道」= 能同时转发的账号数。修复前恒为 1（被 promise 链串死）。')
console.log('  · 场景④最能说明问题：交替访问两个账号，修复前每次都要重启，修复后只在各自首次被用到时各起一次。')
console.log('  · 代价：每个常驻账号占一个 Node 进程（约 60–90MB）。非激活账号空闲 15 分钟后回收。\n')
