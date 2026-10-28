import test from 'node:test'
import assert from 'node:assert/strict'
import { createFailoverPolicy, isFailoverStatus, DEFAULT_DEGRADE_MS } from '../failover.mjs'

const acct = (id, hasAuth = true) => ({ id, hasAuth })

function fixedClock(t0 = 1_000_000) {
  let t = t0
  return { now: () => t, advance: (ms) => { t += ms } }
}

test('只有 429 / 401 可降级，其余错误换账号也没用', () => {
  assert.equal(isFailoverStatus(429), true)
  assert.equal(isFailoverStatus(401), true)
  assert.equal(isFailoverStatus(400), false) // 请求本身有问题，换谁都一样
  assert.equal(isFailoverStatus(500), false) // 上游故障，不是账号问题
  assert.equal(isFailoverStatus(502), false)
  assert.equal(isFailoverStatus(200), false)
  assert.equal(isFailoverStatus(undefined), false)
})

test('canRetry：四个条件缺一不可', () => {
  const p = createFailoverPolicy()
  const ok = { status: 429, attempt: 0, canReplay: true, accountId: 'a' }
  assert.equal(p.canRetry(ok), true)

  assert.equal(p.canRetry({ ...ok, status: 400 }), false)
  assert.equal(p.canRetry({ ...ok, canReplay: false }), false, '请求体没留住就不能重放')
  assert.equal(p.canRetry({ ...ok, accountId: null }), false, '没有账号归属就不知道该降级谁')
  assert.equal(p.canRetry({ ...ok, attempt: 2 }), false, '到上限')
})

test('canRetry：上限可配置，边界是「小于」不是「小于等于」', () => {
  const p = createFailoverPolicy({ maxAttempts: 1 })
  assert.equal(p.canRetry({ status: 429, attempt: 0, canReplay: true, accountId: 'a' }), true)
  assert.equal(p.canRetry({ status: 429, attempt: 1, canReplay: true, accountId: 'a' }), false)
})

test('标记降级后立刻生效', () => {
  const p = createFailoverPolicy()
  assert.equal(p.isDegraded('a'), false)
  assert.equal(p.markDegraded('a', 429), true)
  assert.equal(p.isDegraded('a'), true)
  assert.equal(p.isDegraded('b'), false, '别的账号不受影响')
})

test('冷却按状态码分开：429 是 5 分钟，401 是 15 分钟', () => {
  const c = fixedClock()
  const p = createFailoverPolicy({ now: c.now })
  p.markDegraded('rate', 429)
  p.markDegraded('auth', 401)

  c.advance(DEFAULT_DEGRADE_MS[429] + 1)
  assert.equal(p.isDegraded('rate'), false, '429 冷却较短：可能只是某个模型打满，别整段拉黑')
  assert.equal(p.isDegraded('auth'), true, '401 冷却较长：重新授权前不会自己好')

  c.advance(DEFAULT_DEGRADE_MS[401] - DEFAULT_DEGRADE_MS[429])
  assert.equal(p.isDegraded('auth'), false, '到期必须自动解除，用户重新登录后要能立刻复活')
})

test('未知状态码不产生降级标记', () => {
  const p = createFailoverPolicy()
  assert.equal(p.markDegraded('a', 500), false)
  assert.equal(p.isDegraded('a'), false)
})

test('空账号 id 一律不处理，也不会在冷却表里留下垃圾键', () => {
  // 这三处各自都有  !accountId  判断，少一处就会让 null 变成 Map 的一个键
  const p = createFailoverPolicy()
  assert.equal(p.markDegraded(null, 429), false)
  assert.equal(p.markDegraded('', 429), false)
  assert.equal(p.isDegraded(null), false)
  assert.equal(p.isDegraded(''), false)
  assert.deepEqual(p.snapshot().degraded, [])
})

test('pickNext 从当前账号的下一位开始，而不是永远从第一个找', () => {
  const p = createFailoverPolicy()
  // A、B 一起坏的时候，如果每次都从第一个找起，请求会永远在 A→B→A 打转，C 轮不到
  assert.equal(p.pickNext([acct('a'), acct('b'), acct('c')], 'b'), 'c')
  assert.equal(p.pickNext([acct('a'), acct('b'), acct('c')], 'c'), 'a', '到头要环形回绕')
  assert.equal(p.pickNext([acct('a'), acct('b'), acct('c')], 'a'), 'b')
})

test('pickNext 跳过已降级的账号', () => {
  const p = createFailoverPolicy()
  p.markDegraded('b', 429)
  assert.equal(p.pickNext([acct('a'), acct('b'), acct('c')], 'a'), 'c', 'b 在冷却期，直接跳到 c')
})

test('pickNext 跳过没有 auth 文件的账号', () => {
  const p = createFailoverPolicy()
  const r = p.pickNext([acct('a'), acct('b', false), acct('c')], 'a')
  assert.equal(r, 'c', '没登录的账号切过去只会拿到 401')
  assert.equal(p.snapshot().stats.skippedNoAuth, 1)
})

test('pickNext 只有一个账号时返回 null（不降级）', () => {
  const p = createFailoverPolicy()
  assert.equal(p.pickNext([acct('a')], 'a'), null)
  assert.equal(p.pickNext([], 'a'), null)
  assert.equal(p.pickNext([], null), null)
})

test('pickNext 全部账号都在冷却时返回 null 并记 exhausted', () => {
  const p = createFailoverPolicy()
  p.markDegraded('b', 429)
  p.markDegraded('c', 429)
  assert.equal(p.pickNext([acct('a'), acct('b'), acct('c')], 'a'), null)
  assert.equal(p.snapshot().stats.exhausted, 1)
})

test('pickNext 不把调用方传进来的数组改坏', () => {
  const p = createFailoverPolicy()
  const list = [acct('a'), acct('b'), acct('c')]
  p.pickNext(list, 'b')
  assert.deepEqual(list.map((x) => x.id), ['a', 'b', 'c'])
})

test('snapshot 汇报冷却剩余秒数，且不泄露过期项', () => {
  const c = fixedClock()
  const p = createFailoverPolicy({ now: c.now })
  p.markDegraded('a', 429)
  c.advance(60_000)
  const s = p.snapshot()
  assert.equal(s.degraded.length, 1)
  assert.equal(s.degraded[0].accountId, 'a')
  assert.equal(s.degraded[0].remainSec, DEFAULT_DEGRADE_MS[429] / 1000 - 60)
  assert.equal(s.maxAttempts, 2)
})

test('reset 清空冷却与计数', () => {
  const p = createFailoverPolicy()
  p.markDegraded('a', 429)
  p.pickNext([acct('a'), acct('b', false)], 'a')
  p.reset()
  assert.equal(p.isDegraded('a'), false)
  assert.equal(p.snapshot().stats.skippedNoAuth, 0)
})
