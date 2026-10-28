// bridge 实例池的并发语义测试（F-03 二期）
//
//   运行：node --test gateway/tests/bridge-pool.test.mjs
//
// 这里测的不是「进程能不能起来」（那属于集成测试），而是三件容易在时序上出错的事：
//   1) 同一账号并发来请求，**只能 spawn 一个**桥；
//   2) 不同账号各用各的端口，互不阻塞；
//   3) 回收 / 淘汰 / 崩溃三条清理路径都不会把正在转发的实例拆掉。
//
// 所以 spawn 与 probe 全部注入假实现，时钟可偏移，避免依赖真实进程与真实等待。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createBridgePool } from '../bridge-pool.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fakeChild(pid) {
  const listeners = {}
  return {
    pid,
    exitCode: null,
    kill(sig) {
      if (this.exitCode != null) return
      this.exitCode = 0
      this.emit('exit', 0, sig)
    },
    on(ev, cb) {
      ;(listeners[ev] ||= []).push(cb)
      return this
    },
    emit(ev, ...args) {
      for (const cb of listeners[ev] || []) cb(...args)
    },
    // 模拟进程崩溃：先标 exitCode 再派发 exit 事件
    crash(code = 1) {
      this.exitCode = code
      this.emit('exit', code, null)
    }
  }
}

function makeRig(opts = {}) {
  const spawned = []
  const probes = []
  let skew = 0
  const clock = () => Date.now() + skew
  const deadPorts = new Set(opts.deadPorts || [])
  const refusedPorts = new Set(opts.refusedPorts || [])

  const pool = createBridgePool({
    basePort: 20000,
    maxInstances: opts.maxInstances ?? 4,
    idleTimeoutMs: opts.idleTimeoutMs ?? 0,
    startTimeoutMs: opts.startTimeoutMs ?? 400,
    probeIntervalMs: 5,
    reapIntervalMs: 15,
    isPinned: opts.isPinned || (() => false),
    log: opts.log || (() => {}),
    now: clock,
    spawn: (key, port) => {
      const child = fakeChild(1000 + spawned.length)
      spawned.push({ key, port, child })
      return child
    },
    probe: async (port) => {
      probes.push(port)
      if (deadPorts.has(port)) return { listening: false }
      if (refusedPorts.has(port)) throw new Error('ECONNREFUSED')
      return { listening: true, status: 200 }
    }
  })

  return {
    pool,
    spawned,
    probes,
    advanceIdle: (ms) => { skew += ms },
    stop: () => pool.dispose()
  }
}

test('同账号并发请求只拉起一个 bridge，且都拿到同一端口', async () => {
  const rig = makeRig()
  try {
    const N = 24
    const slots = await Promise.all(Array.from({ length: N }, () => rig.pool.acquire('A')))

    assert.equal(rig.spawned.length, 1, `${N} 个并发请求只能 spawn 一次，实际 ${rig.spawned.length} 次`)
    const ports = new Set(slots.map((s) => s.port))
    assert.equal(ports.size, 1, '同账号的请求应全部打向同一端口')
    assert.equal(rig.pool.instance('A').inflight, N, '在途计数应等于并发请求数')

    for (const s of slots) s.release()
    assert.equal(rig.pool.instance('A').inflight, 0)
  } finally {
    rig.stop()
  }
})

test('不同账号各有独立端口，先启动一个不影响另一个并发启动', async () => {
  const rig = makeRig()
  try {
    const [a, b] = await Promise.all([rig.pool.acquire('A'), rig.pool.acquire('B')])
    assert.notEqual(a.port, b.port, '不同账号必须落在不同端口')
    assert.equal(rig.spawned.length, 2)
    assert.deepEqual(rig.spawned.map((s) => s.key).sort(), ['A', 'B'])

    // 已就绪后再取，不应重复 spawn —— 这正是「切换不再重启」的证据
    const a2 = await rig.pool.acquire('A')
    assert.equal(a2.port, a.port)
    assert.equal(rig.spawned.length, 2, '已就绪账号再次请求不应重启 bridge')
  } finally {
    rig.stop()
  }
})

test('冷启动之后，交替访问两个账号零重启', async () => {
  const rig = makeRig({ maxInstances: 4 })
  try {
    for (let i = 0; i < 6; i++) {
      const s = await rig.pool.acquire(i % 2 === 0 ? 'A' : 'B')
      s.release()
    }
    assert.equal(rig.spawned.length, 2, '交替 6 次请求，总 spawn 数应恒为 2（一期方案是 6 次）')
    assert.equal(rig.pool.stats().starts, 2)
  } finally {
    rig.stop()
  }
})

test('release 幂等：重复调用不会把在途计数打成负数', async () => {
  const rig = makeRig()
  try {
    const s = await rig.pool.acquire('A')
    s.release()
    s.release()
    s.release()
    assert.equal(rig.pool.instance('A').inflight, 0)
    assert.ok(rig.pool.instance('A').inflight >= 0)
  } finally {
    rig.stop()
  }
})

test('空闲实例会被回收，但在途请求持有的实例不会被拆', async () => {
  const rig = makeRig({ idleTimeoutMs: 60_000, maxInstances: 4 })
  try {
    const held = await rig.pool.acquire('A') // 一直不 release
    const b = await rig.pool.acquire('B')
    b.release()

    rig.advanceIdle(61_000)
    await sleep(60) // 等一轮 reap（间隔 15ms）

    assert.equal(rig.pool.instance('A')?.state, 'ready', '有在途请求的实例不得被回收')
    assert.equal(rig.pool.instance('B'), null, '空闲实例应被回收')
    assert.equal(rig.spawned.find((s) => s.key === 'A').child.exitCode, null)

    held.release()
  } finally {
    rig.stop()
  }
})

test('pinned 实例不参与空闲回收', async () => {
  const rig = makeRig({ idleTimeoutMs: 60_000, maxInstances: 4, isPinned: (k) => k === 'A' })
  try {
    const a = await rig.pool.acquire('A')
    a.release()
    const b = await rig.pool.acquire('B')
    b.release()

    rig.advanceIdle(61_000)
    await sleep(60)

    assert.equal(rig.pool.instance('A')?.state, 'ready', 'pinned 实例应常驻')
    assert.equal(rig.pool.instance('B'), null)
  } finally {
    rig.stop()
  }
})

test('实例池满时淘汰最久未用的空闲实例，而不是报错', async () => {
  const rig = makeRig({ maxInstances: 2, idleTimeoutMs: 0 })
  try {
    const a = await rig.pool.acquire('A')
    a.release()
    rig.advanceIdle(5_000)
    const b = await rig.pool.acquire('B')
    b.release()
    rig.advanceIdle(5_000)

    const c = await rig.pool.acquire('C')
    assert.ok(c.port > 0)
    assert.equal(rig.pool.instance('A'), null, '最久未用的 A 应被淘汰')
    assert.equal(rig.pool.instance('B')?.state, 'ready')
    assert.equal(rig.pool.stats().evictions, 1)
    c.release()
  } finally {
    rig.stop()
  }
})

test('实例池满且实例都在用时报错，不静默降级', async () => {
  const rig = makeRig({ maxInstances: 1 })
  try {
    const a = await rig.pool.acquire('A') // 占住唯一的槽位
    await assert.rejects(() => rig.pool.acquire('B'), /实例池已满/)
    a.release()
  } finally {
    rig.stop()
  }
})

test('实例池满时优先淘汰非 pinned 的空闲实例（激活账号不被挤掉）', async () => {
  // 这一条专门守 pickVictim 里的 isPinned 判断：把 A 做成「最久未用」，
  // 若代码忘了跳过 pinned，被淘汰的就是当前激活账号，UI 上会表现为「网关老是重启」。
  const rig = makeRig({ maxInstances: 2, idleTimeoutMs: 0, isPinned: (k) => k === 'A' })
  try {
    const a = await rig.pool.acquire('A')
    a.release()
    rig.advanceIdle(5_000) // 让 A 成为 LRU（最该被淘汰的那个）
    const b = await rig.pool.acquire('B')
    b.release()
    rig.advanceIdle(5_000)

    const c = await rig.pool.acquire('C')
    assert.equal(rig.pool.instance('A')?.state, 'ready', 'pinned 的激活账号不得被淘汰')
    assert.equal(rig.pool.instance('B'), null, '应淘汰非 pinned 的那个空闲实例')
    assert.equal(rig.pool.stats().evictions, 1)
    c.release()
  } finally {
    rig.stop()
  }
})

test('端口始终不监听 → 启动失败并从池中移除，下次可重试', async () => {
  const rig = makeRig({ deadPorts: [20000], startTimeoutMs: 60 })
  try {
    await assert.rejects(() => rig.pool.acquire('A'), /未能在 \d+ms 内监听端口/)
    assert.equal(rig.pool.instance('A'), null, '失败的实例不应留在池里')
    assert.equal(rig.pool.stats().failures, 1)
  } finally {
    rig.stop()
  }
})

test('子进程崩溃后从池中移除，下次请求重新拉起', async () => {
  const rig = makeRig()
  try {
    const s1 = await rig.pool.acquire('A')
    s1.release()
    const child = rig.spawned[0].child
    child.crash()

    assert.equal(rig.pool.instance('A'), null, '崩溃的实例应立即从池中移除')

    const s2 = await rig.pool.acquire('A')
    assert.equal(rig.spawned.length, 2, '崩溃后再请求应重新拉起')
    assert.equal(s2.port, s1.port, '同一个槽位应复用同一端口')
    s2.release()
  } finally {
    rig.stop()
  }
})

test('/health 返回 503 也算就绪（未登录不应导致实例起不来）', async () => {
  const rig = makeRig()
  try {
    // 直接改 probe 语义：监听但未登录
    const pool = createBridgePool({
      basePort: 21000,
      maxInstances: 2,
      startTimeoutMs: 400,
      probeIntervalMs: 5,
      spawn: () => fakeChild(1),
      probe: async () => ({ listening: true, status: 503 }),
      log: () => {}
    })
    const inst = await pool.warm('X')
    assert.equal(inst.state, 'ready')
    assert.equal(inst.healthStatus, 503)
    pool.dispose()
  } finally {
    rig.stop()
  }
})

test('stopAll 会停掉所有实例并释放槽位', async () => {
  const rig = makeRig({ maxInstances: 2 })
  try {
    const a = await rig.pool.acquire('A')
    a.release()
    const b = await rig.pool.acquire('B')
    b.release()
    assert.equal(rig.pool.list().length, 2)

    assert.equal(rig.pool.stopAll(), 2)
    assert.equal(rig.pool.list().length, 0)
    assert.ok(rig.spawned.every((s) => s.child.exitCode != null), '子进程应被终止')

    // 槽位释放后可以重新使用
    const c = await rig.pool.acquire('C')
    assert.equal(c.port, 20000)
    c.release()
  } finally {
    rig.stop()
  }
})
