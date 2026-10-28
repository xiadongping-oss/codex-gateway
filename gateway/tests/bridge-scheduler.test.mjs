// bridge 调度器的并发语义测试（原 F-03）
//
//   运行：node --test gateway/tests/bridge-scheduler.test.mjs
//
// 这块逻辑的难点在于**时序**，而时序 bug 在集成测试里表现为偶发的串号，
// 很难复现。所以这里用可注入的 doSwitch + 手动控时的 release，
// 把「谁等谁」「切换时有没有人在用 bridge」变成确定性断言。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createBridgeScheduler } from '../bridge-scheduler.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 等到微任务队列排空，确保 drain 循环推进到下一个 await 点
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve() }

// 记录型 doSwitch：可控制耗时、可让它抛错
function makeSwitcher({ delayMs = 5, failFor = new Set() } = {}) {
  const calls = []
  return {
    calls,
    fn: async (target) => {
      calls.push(target)
      if (delayMs) await sleep(delayMs)
      if (failFor.has(target)) throw new Error('切换失败：' + target)
    }
  }
}

test('同账号的并发请求完全并行，且不发生任何切换', async () => {
  const sw = makeSwitcher()
  const sched = createBridgeScheduler({})
  sched.setLoaded('A')

  const N = 20
  const slots = await Promise.all(Array.from({ length: N }, () => sched.acquire('A', sw.fn)))

  assert.equal(slots.length, N)
  assert.equal(sched.readers(), N, `${N} 个同账号请求应当同时持有名额`)
  assert.equal(sw.calls.length, 0, '目标已加载时不应发生切换')
  assert.equal(sched.stats().switches, 0)
  assert.equal(sched.stats().parallelPeak, N)

  for (const s of slots) s.release()
  assert.equal(sched.readers(), 0)
})

test('跨账号切换前，必须等所有在途请求退场（TOCTOU 的根因）', async () => {
  let switchStartedWithReaders = -1
  const sw = makeSwitcher({ delayMs: 0 })
  const sched = createBridgeScheduler({})
  sched.setLoaded('A')

  // 先放一个长请求占住 A 且不释放
  const holder = await sched.acquire('A', sw.fn)
  assert.equal(sched.readers(), 1)

  let done = false
  sched
    .acquire('B', async (target) => {
      switchStartedWithReaders = sched.readers()
      await sw.fn(target)
    })
    .then(() => { done = true })

  await tick(12)
  assert.equal(done, false, '还有请求在用 A，写者不该开始切换')
  assert.equal(switchStartedWithReaders, -1, 'doSwitch 不应在读者退场前被调用')

  holder.release()
  await tick(12)
  await sleep(5)
  assert.equal(done, true, '读者释放后写者应继续')
  assert.equal(switchStartedWithReaders, 0, '执行切换时读者数必须为 0 —— 否则就是串号窗口')
  assert.deepEqual(sw.calls, ['B'])
})

test('多个同账号请求排队时会被整批放行，而不是一个一个串行', async () => {
  const sw = makeSwitcher({ delayMs: 5 })
  const sched = createBridgeScheduler({})
  sched.setLoaded('A')

  // 制造一次跨账号切换，让后续 B 请求排队
  const first = sched.acquire('B', sw.fn)
  await tick(12) // 让 drain 进入切换
  const queued = await Promise.all([first, sched.acquire('B', sw.fn), sched.acquire('B', sw.fn)])
  assert.equal(queued.length, 3)
  assert.equal(sw.calls.length, 1, '三个请求目标相同，只需切换一次')
  assert.equal(sched.readers(), 3, '切换完成后应整批放行')

  for (const s of queued) s.release()
})

test('切换失败时整批拒绝，且不会污染已加载状态', async () => {
  const sw = makeSwitcher({ failFor: new Set(['BAD']) })
  const sched = createBridgeScheduler({})
  sched.setLoaded('A')

  const results = await Promise.allSettled([
    sched.acquire('BAD', sw.fn),
    sched.acquire('BAD', sw.fn)
  ])
  assert.equal(results.every((r) => r.status === 'rejected'), true, '切换失败应当让调用方感知')
  assert.equal(sched.stats().switches, 0, '失败的切换不能计入成功次数')
  assert.equal(sched.readers(), 0)

  // 关键：loaded 没被改动，A 仍然可以直接用
  const s = await sched.acquire('A', sw.fn)
  assert.equal(sched.readers(), 1)
  s.release()
})

test('release 幂等：重复释放不会把读者计数打成负数', async () => {
  const sw = makeSwitcher()
  const sched = createBridgeScheduler({})
  sched.setLoaded('A')

  const s = await sched.acquire('A', sw.fn)
  assert.equal(sched.readers(), 1)
  s.release(); s.release(); s.release()
  assert.equal(sched.readers(), 0, '多挂几个结束信号（close/finish/error）也不能重复扣减')

  // 计数没坏 → 写者仍能正常判断空闲
  const b = await sched.acquire('B', sw.fn)
  assert.equal(sched.stats().switches, 1)
  b.release()
})

test('交替到达的跨账号请求：切换次数收敛到账号数级别，而非请求数级别', async () => {
  const sw = makeSwitcher({ delayMs: 1 })
  const sched = createBridgeScheduler({})
  sched.setLoaded('A')

  // 模拟真实请求模型：拿到名额 → 用一下 → 立刻释放。
  // （串行链时代这里会发生 ~11 次切换，即每个跨账号请求都要重启一次 bridge）
  const jobs = []
  for (let i = 0; i < 6; i++) {
    jobs.push((async () => { const s = await sched.acquire('A', sw.fn); await sleep(1); s.release() })())
    jobs.push((async () => { const s = await sched.acquire('B', sw.fn); await sleep(1); s.release() })())
  }
  await Promise.all(jobs)
  assert.equal(sched.readers(), 0, '所有请求结束后不应有名额泄漏')
  assert.ok(sw.calls.length <= 2, `切换次数应收敛到账号数级别，实际 ${sw.calls.length}：${sw.calls.join(',')}`)
})

test('读者一直不释放时，写者不会永久饿死（超时后强制让位）', async () => {
  // 这道保险很重要：若某个流式请求异常悬挂，写者不能陪着一起挂。
  const sw = makeSwitcher({ delayMs: 0 })
  const sched = createBridgeScheduler({ idleTimeoutMs: 120 })
  sched.setLoaded('A')

  const holder = await sched.acquire('A', sw.fn)
  const startedAt = Date.now()
  let settled = false
  sched.acquire('B', sw.fn).then((s) => { settled = true; s.release() })

  await new Promise((r) => setTimeout(r, 60))
  assert.equal(settled, false, '超时窗口内应当继续等待（不能提前切换，那会串号）')

  await new Promise((r) => setTimeout(r, 200))
  assert.equal(settled, true, '超时后必须让出队列，否则整个网关卡死')
  assert.equal(sched.stats().forcedDrains, 1, '应当记一次强制让位，供日志告警')
  assert.ok(Date.now() - startedAt >= 120, '强制让位不能早于配置的超时')
  holder.release()
})

test('bridge 进程被停止后 forget：下一个请求会重新触发切换', async () => {
  const sw = makeSwitcher()
  const sched = createBridgeScheduler({})
  sched.setLoaded('A')

  const s1 = await sched.acquire('A', sw.fn)
  s1.release()
  assert.equal(sw.calls.length, 0)

  sched.forget() // 模拟 bridge 被手动停止
  const s2 = await sched.acquire('A', sw.fn)
  assert.equal(sw.calls.length, 1, '状态失效后应重新加载，而不是沿用旧记录')
  s2.release()
})

test('等待队列为空时，后来的同账号请求不会被误判为需要排队', async () => {
  const sw = makeSwitcher()
  const sched = createBridgeScheduler({})
  sched.setLoaded('A')

  const s1 = await sched.acquire('A', sw.fn)
  const s2 = await sched.acquire('A', sw.fn)
  assert.equal(sched.readers(), 2, '队列空时应走快路径直接并行')
  assert.equal(sched.waiting(), 0)
  s1.release(); s2.release()
})
