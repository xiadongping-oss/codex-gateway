// 账号额度：上游限流头解析 + 按账号隔离的缓存 + 空态语义
//
// 这几条守着三个曾经真实发生过的误导：
//   1) 池化后仍读死端口 10531 → 切账号后数字不变；
//   2) 单个扁平 _realtime 缓存 → B 账号看到 A 账号的余量；
//   3) 自动生成「示例数据」当真实额度展示 → 用户以为周用量真的只用了 31%。
//
// 依赖注入点：CGW_QUOTA_FILE 必须在 import 前设好（QUOTA_FILE 是模块级常量）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-quota-'))
const QUOTA_FILE = path.join(TMP, 'account-quota.json')
// 数据根也一并隔离：loadAccounts() 读 DATA_ROOT/accounts.json，
// 不隔离的话测试会吃到开发机残留的激活账号（本机过、干净机器挂）。
process.env.CGW_QUOTA_FILE = QUOTA_FILE
process.env.CGW_DATA_DIR = path.join(TMP, 'data-root')

const q = await import('../account-quota.mjs')

const readFile = () => JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8'))
const writeFile = (obj) => fs.writeFileSync(QUOTA_FILE, JSON.stringify(obj, null, 2))
const reset = () => { try { fs.unlinkSync(QUOTA_FILE) } catch {} }

const nowSec = () => Math.floor(Date.now() / 1000)

// ---------- 上游限流头解析 ----------

test('primary 头映射为周窗口，secondary / bengalfox 映射为模型级窗口', () => {
  const headers = {
    'x-codex-primary-used-percent': '42',
    'x-codex-primary-window-minutes': '10080',
    'x-codex-primary-reset-at': String(nowSec() + 3600),
    'x-codex-secondary-used-percent': '12',
    'x-codex-secondary-window-minutes': '300',
    'x-codex-bengalfox-primary-used-percent': '80',
    'x-codex-bengalfox-primary-window-minutes': '300',
    'x-codex-bengalfox-secondary-used-percent': '55',
    'x-codex-plan-type': 'pro'
  }
  const rt = q.realtimeQuotaFrom(headers, Date.now())
  assert.equal(rt.weekly.label, 'Weekly', '10080 分钟应识别为周窗口')
  assert.equal(rt.weekly.usedPercent, 42)
  assert.ok(rt.weekly.resetsAt, 'reset-at 秒级时间戳应转成 ISO')
  assert.equal(rt.plan.name, 'PRO')
  const ids = rt.models.map((m) => m.id)
  assert.deepEqual(ids, ['codex-secondary', 'spark-5h', 'spark-weekly'])
  assert.equal(rt.models[0].label, 'Codex 5h 窗口')
})

test('非周窗口按实际小时数命名，缺 primary 直接返回 null', () => {
  const rt = q.realtimeQuotaFrom({ 'x-codex-primary-used-percent': '10', 'x-codex-primary-window-minutes': '300' }, Date.now())
  assert.equal(rt.weekly.label, '5h 窗口')
  assert.equal(q.realtimeQuotaFrom({ 'x-codex-secondary-used-percent': '50' }, Date.now()), null, '没有 primary 视为无数据')
  assert.equal(q.realtimeQuotaFrom({}, Date.now()), null)
})

test('百分比越界被夹到 0–100，脏值不当成 0 静默展示', () => {
  const hi = q.realtimeQuotaFrom({ 'x-codex-primary-used-percent': '140' }, Date.now())
  assert.equal(hi.weekly.usedPercent, 100)
  const lo = q.realtimeQuotaFrom({ 'x-codex-primary-used-percent': '-8' }, Date.now())
  assert.equal(lo.weekly.usedPercent, 0)
  const junk = q.realtimeQuotaFrom({ 'x-codex-primary-used-percent': 'n/a' }, Date.now())
  assert.equal(junk, null, '非数字应视为无数据，而不是当成 0%')
})

// ---------- 按账号隔离的缓存 ----------

const snap = (pct, at = Date.now()) => ({
  weekly: { label: 'Weekly', usedPercent: pct },
  models: [],
  syncedAt: new Date(at).toISOString()
})

test('两个账号的快照互不可见，第三个账号不会看到别人的数字', () => {
  reset()
  q.persistRealtimeSnapshot('acct-a', snap(20))
  q.persistRealtimeSnapshot('acct-b', snap(70))
  assert.equal(q.readCachedRealtime('acct-a').weekly.usedPercent, 20)
  assert.equal(q.readCachedRealtime('acct-b').weekly.usedPercent, 70)
  assert.equal(q.readCachedRealtime('acct-c'), null, '没有观测过的账号必须返回 null，不能回落到别人的快照')
  assert.equal(readFile()._realtime.version, 2)
})

test('旧版扁平 _realtime 迁移到当前账号名下，之后不再跨账号复用', () => {
  reset()
  writeFile({ _realtime: snap(33), shared: {} })
  const migrated = q.migrateLegacyRealtime('acct-a')
  assert.equal(migrated.weekly.usedPercent, 33)
  assert.equal(readFile()._realtime.byAccount['acct-a'].weekly.usedPercent, 33)
  assert.equal(q.readCachedRealtime('acct-b'), null)
  assert.equal(q.migrateLegacyRealtime('acct-b'), null, '已升级过的结构不再迁移')
})

test('超过 24h 的快照作废，落盘时顺带清理过期条目', () => {
  reset()
  const old = Date.now() - 25 * 3600 * 1000
  writeFile({ _realtime: { version: 2, byAccount: { stale: snap(90, old) } } })
  assert.equal(q.readCachedRealtime('stale'), null)
  q.persistRealtimeSnapshot('fresh', snap(5))
  const by = readFile()._realtime.byAccount
  assert.equal(by.stale, undefined, '过期条目应在下一次落盘时被清掉')
  assert.ok(by.fresh)
})

test('同一份快照重复落盘不重写文件（30s 轮询不做无谓 IO）', () => {
  reset()
  const s = snap(11)
  q.persistRealtimeSnapshot('a', s)
  const mtime1 = fs.statSync(QUOTA_FILE).mtimeMs
  q.persistRealtimeSnapshot('a', s)
  assert.equal(fs.statSync(QUOTA_FILE).mtimeMs, mtime1)
})

// ---------- 配置作用域与空态 ----------

test('账号专属配置优先于 shared，旧扁平结构整份视为 shared', () => {
  const cfg = {
    shared: { weekly: { usedPercent: 10 } },
    accounts: { 'acct-a': { weekly: { usedPercent: 80 } } }
  }
  assert.equal(q.resolveScope(cfg, 'acct-a').scope, 'account')
  assert.equal(q.resolveScope(cfg, 'acct-a').config.weekly.usedPercent, 80)
  assert.equal(q.resolveScope(cfg, 'acct-b').scope, 'shared')
  assert.equal(q.resolveScope(cfg, 'acct-b').config.weekly.usedPercent, 10)

  const legacy = { plan: { name: 'PRO' }, weekly: { usedPercent: 42 } }
  const r = q.resolveScope(legacy, 'acct-a')
  assert.equal(r.scope, 'shared')
  assert.equal(r.config.weekly.usedPercent, 42, '老配置不能因为结构调整而丢')
})

test('完全没有数据时返回空态，而不是编一个 100% 剩余', async () => {
  reset()
  // 端口 1 必然拒绝连接：确保不会读到本机真实 bridge 的限流头
  const r = await q.getAccountQuota({ bridgePort: 1 })
  assert.equal(r.source, 'none')
  assert.equal(r.demo, true)
  assert.equal(r.weekly, null, '没有数据就不能给百分比')
  assert.deepEqual(r.models, [])
  assert.equal(r.stale, false)
  assert.equal(fs.existsSync(QUOTA_FILE), false, '读接口不应再自动生成示例数据文件')
})

test('拿不到实时数据时按手填的显示，没有手填就空着——两种情况都不编数字', async () => {
  reset()
  const none = await q.getAccountQuota({ bridgePort: 1 })
  assert.equal(none.source, 'none')
  assert.equal(none.weekly, null)

  writeFile({ shared: { weekly: { label: 'Weekly', usedPercent: 64 }, accountType: '团队' } })
  const manual = await q.getAccountQuota({ bridgePort: 1 })
  assert.equal(manual.source, 'manual')
  assert.equal(manual.weekly.remainingPercent, 36)
  assert.equal(manual.accountType, '团队')
})

// 起一个假 bridge：只回 /health，带上游限流头
async function fakeBridge(headers, at = Date.now()) {
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, last_upstream_limits: { at, headers } }))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { srv, port: srv.address().port }
}

test('有实时数据时模型窗口只取上游那份，不把手填的贴到「实时」标签下', async () => {
  reset()
  writeFile({ shared: { weekly: { usedPercent: 10 }, models: [{ id: 'manual', label: '手填模型', usedPercent: 90 }] } })
  const { srv, port } = await fakeBridge({
    'x-codex-primary-used-percent': '40',
    'x-codex-primary-window-minutes': '10080'
  })
  try {
    const r = await q.getAccountQuota({ bridgePort: port })
    assert.equal(r.source, 'realtime')
    assert.equal(r.weekly.usedPercent, 40, '周窗口应被上游值覆盖')
    assert.deepEqual(r.models, [], '上游没给模型级窗口就该空着，不能回填手填值')
    assert.equal(r.stale, false)
  } finally {
    srv.close()
  }
})

test('超过 24h 的上游快照不再算实时（重启后昨天数字不会冒充今天）', async () => {
  reset()
  const { srv, port } = await fakeBridge({ 'x-codex-primary-used-percent': '88' }, Date.now() - 25 * 3600 * 1000)
  try {
    const r = await q.getAccountQuota({ bridgePort: port })
    assert.notEqual(r.source, 'realtime')
    assert.equal(r.weekly, null)
  } finally {
    srv.close()
  }
})

test('实时快照会按账号落盘，下次换端口读缓存也拿得回同一份', async () => {
  reset()
  const { srv, port } = await fakeBridge({ 'x-codex-primary-used-percent': '55' })
  try {
    await q.getAccountQuota({ bridgePort: port })
  } finally {
    srv.close()
  }
  const cache = readFile()._realtime
  assert.equal(cache.version, 2)
  const keys = Object.keys(cache.byAccount)
  assert.equal(keys.length, 1, '没有激活账号时应落在 __shared 这一个键上')
  assert.equal(cache.byAccount[keys[0]].weekly.usedPercent, 55)
  // 端口关掉后仍能从缓存读到（≤24h）
  const again = await q.getAccountQuota({ bridgePort: 1 })
  assert.equal(again.weekly.usedPercent, 55)
  assert.equal(again.source, 'realtime')
})

test('readCachedRealtime：无激活账号时回退 __shared 键，与落盘键对称', () => {
  reset()
  writeFile({
    _realtime: {
      version: 2,
      byAccount: {
        __shared: { weekly: { usedPercent: 7 }, syncedAt: new Date().toISOString() }
      }
    }
  })
  const snap = q.readCachedRealtime(null)
  assert.ok(snap, '无激活账号时应读到 __shared 缓存而不是 null')
  assert.equal(snap.weekly.usedPercent, 7)
})


test('countdownText 对未来时刻给倒计时，对过去时刻给「已重置」', () => {
  assert.equal(q.countdownText(new Date(Date.now() - 1000).toISOString()), '已重置')
  assert.equal(q.countdownText('not-a-date'), null)
  assert.equal(q.countdownText(null), null)
  assert.match(q.countdownText(new Date(Date.now() + 1.5 * 86400 * 1000).toISOString()), /^1天 1[12]小时/)
})

// ---------- 主动探测 ----------
// 探测会真的发一次上游请求（消耗极小但非零额度），所以这几条守的是
// 「别多发、别把旧数据当新的、失败了别假装成功」。

// 会真的响应探测请求的假 bridge：
//   /health 回当前快照；/v1/chat/completions 记录请求体，并按需刷新快照
async function fakeProbeBridge({ refreshHeaders = null, replyStatus = 200, replyBody = null } = {}) {
  const state = { at: 0, headers: {}, probeCount: 0, probeBodies: [] }
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (String(req.url).startsWith('/health')) {
      return res.end(JSON.stringify({ ok: true, last_upstream_limits: { at: state.at, headers: state.headers } }))
    }
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      state.probeCount++
      try { state.probeBodies.push(JSON.parse(raw)) } catch { state.probeBodies.push(raw) }
      if (refreshHeaders) {
        state.at = Date.now()
        state.headers = refreshHeaders
      }
      res.writeHead(replyStatus)
      res.end(JSON.stringify(replyBody || (replyStatus === 200 ? { ok: true } : { error: 'rate_limited' })))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return {
    srv,
    port: srv.address().port,
    state,
    seed: (headers, at) => { state.headers = headers; state.at = at }
  }
}

const WEEKLY = { 'x-codex-primary-used-percent': '31', 'x-codex-primary-window-minutes': '10080' }

test('探测成功后把限流头落到该账号名下', async () => {
  const b = await fakeProbeBridge({ refreshHeaders: WEEKLY })
  try {
    const r = await q.probeQuotaViaBridge({ accountId: 'probe-ok', bridgePort: b.port, model: 'gpt-6.1-sol' })
    assert.equal(r.ok, true)
    assert.equal(r.source, 'realtime')
    const cached = q.readCachedRealtime('probe-ok')
    assert.ok(cached, '应写入该账号名下')
    assert.equal(cached.weekly.usedPercent, 31)
  } finally { b.srv.close() }
})

test('探测不把 bridge 里的旧头当成本次结果', async () => {
  const b = await fakeProbeBridge({ refreshHeaders: null }) // 探测不会产生新头
  // bridge 里还留着 1 小时前那次真实调用的头（24h 内都算「有效」）
  b.seed(WEEKLY, Date.now() - 3600 * 1000)
  try {
    const r = await q.probeQuotaViaBridge({ accountId: 'probe-stale', bridgePort: b.port })
    assert.equal(r.ok, false, '没拿到新头就不能报成功')
    assert.equal(r.reason, 'no_limit_headers')
    assert.equal(b.state.probeCount, 1, '请求确实发出去了')
    assert.equal(q.readCachedRealtime('probe-stale'), null, '更不许把旧头写进缓存')
  } finally { b.srv.close() }
})

test('探测请求是最小请求：max_tokens=1，不偷偷跑一次完整对话', async () => {
  const b = await fakeProbeBridge({ refreshHeaders: WEEKLY })
  try {
    await q.probeQuotaViaBridge({ accountId: 'probe-min', bridgePort: b.port, model: 'gpt-6.1-sol' })
    const body = b.state.probeBodies[0]
    assert.equal(body.max_tokens, 1)
    assert.equal(body.stream, false)
    assert.equal(body.model, 'gpt-6.1-sol')
    assert.ok(body.messages.length > 0)
  } finally { b.srv.close() }
})

test('探测遇到 429 也照样取头——「已经用满」正是最该展示的信息', async () => {
  const b = await fakeProbeBridge({
    refreshHeaders: { 'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '10080' },
    replyStatus: 429
  })
  try {
    const r = await q.probeQuotaViaBridge({ accountId: 'probe-429', bridgePort: b.port })
    assert.equal(r.ok, true)
    assert.equal(r.status, 429, '状态码如实带上，但数据是有效的')
    assert.equal(q.readCachedRealtime('probe-429').weekly.usedPercent, 100)
  } finally { b.srv.close() }
})

test('同账号 60 秒内不重复探测（冷却期内不发请求）', async () => {
  const b = await fakeProbeBridge({ refreshHeaders: WEEKLY })
  try {
    const first = await q.probeQuotaViaBridge({ accountId: 'probe-cd', bridgePort: b.port })
    assert.equal(first.ok, true)
    const second = await q.probeQuotaViaBridge({ accountId: 'probe-cd', bridgePort: b.port })
    assert.equal(second.ok, false)
    assert.equal(second.reason, 'cooldown')
    assert.ok(second.retryAfterSec > 0 && second.retryAfterSec <= 60)
    assert.equal(b.state.probeCount, 1, '冷却期内绝不能再发一次')
  } finally { b.srv.close() }
})

test('没有端口 / 连不上时如实返回原因，不假装成功也不抛异常', async () => {
  const noPort = await q.probeQuotaViaBridge({ accountId: 'probe-noport', bridgePort: null })
  assert.equal(noPort.ok, false)
  assert.equal(noPort.reason, 'no_bridge_port')

  const b = await fakeProbeBridge()
  const deadPort = b.port
  b.srv.close()
  const dead = await q.probeQuotaViaBridge({ accountId: 'probe-dead', bridgePort: deadPort, timeoutMs: 1500 })
  assert.equal(dead.ok, false)
  assert.equal(dead.reason, 'bridge_unreachable')
})

for (const [name, status, body, reason] of [
  ['地区限制', 503, { error: 'Token refresh failed (HTTP 403). unsupported_country_region_territory' }, 'region_restricted'],
  ['授权失效', 401, { error: 'invalid_grant' }, 'auth_required'],
  ['上游故障', 502, { error: 'bad_gateway' }, 'upstream_error'],
  ['刷新令牌失效', 503, { error: 'Token refresh failed (HTTP 401). invalid_refresh_token' }, 'auth_required']
]) test(`额度探测如实区分${name}，不误报缺少限流头`, async () => {
  const b = await fakeProbeBridge({ replyStatus: status, replyBody: body })
  try {
    const result = await q.probeQuotaViaBridge({ accountId: `probe-error-${name}`, bridgePort: b.port })
    assert.equal(result.ok, false)
    assert.equal(result.reason, reason)
    assert.equal(result.status, status)
  } finally { b.srv.close() }
})


test('订阅日期只读取明确的订阅有效期，不使用令牌过期时间', () => {
 const date='2030-03-12T10:00:00+00:00'
 const plan=q.subscriptionPlanFromClaims({exp:123,'https://api.openai.com/auth':{chatgpt_plan_type:'pro',chatgpt_subscription_active_until:date}})
 assert.equal(plan.name,'PRO');assert.equal(plan.expiresAt,'2030-03-12T10:00:00.000Z')
 assert.equal(q.subscriptionPlanFromClaims({exp:2000000000}).expiresAt,null)
 assert.equal(q.subscriptionPlanFromClaims({'https://api.openai.com/auth':{chatgpt_subscription_active_until:'invalid'}}).expiresAt,null)
})
test('实时套餐名称不能清掉手动记录的订阅日期', async () => {
 reset();const expiry=new Date(Date.now()+7*86400000).toISOString()
 writeFile({shared:{plan:{name:'Manual',expiresAt:expiry}}})
 const b=await fakeBridge({'x-codex-primary-used-percent':'32','x-codex-plan-type':'pro'})
 try {const result=await q.getAccountQuota({bridgePort:b.port});assert.equal(result.plan.name,'PRO');assert.equal(result.plan.expiresAt,expiry);assert.equal(result.plan.expirySource,'manual');assert.ok(result.plan.expiresInDays>0)} finally {b.srv.close()}
})
test('从当前账号凭据获取订阅有效期，实时额度保留该日期', async () => {
 reset();const root=process.env.CGW_DATA_DIR,expiry=new Date(Date.now()+3*86400000).toISOString()
 fs.mkdirSync(path.join(root,'accounts'),{recursive:true})
 fs.writeFileSync(path.join(root,'accounts.json'),JSON.stringify({activeId:'sub-fixture',accounts:[{id:'sub-fixture',name:'Fixture'}]}))
 const claims={'https://api.openai.com/auth':{chatgpt_plan_type:'pro',chatgpt_subscription_active_until:expiry}}
 fs.writeFileSync(path.join(root,'accounts/sub-fixture.json'),JSON.stringify({tokens:{id_token:'e30.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.fixture'}}))
 const b=await fakeBridge({'x-codex-primary-used-percent':'32','x-codex-plan-type':'pro'})
 try {const result=await q.getAccountQuota({bridgePort:b.port});assert.equal(result.plan.expiresAt,expiry);assert.equal(result.plan.expirySource,'account');assert.match(result.plan.expiresInText,/剩余/)} finally {b.srv.close();fs.unlinkSync(path.join(root,'accounts.json'));fs.unlinkSync(path.join(root,'accounts/sub-fixture.json'))}
})

// ---------- 订阅到期：凭据里的只是周期快照，不是订阅状态 ----------
// 真实事故：2026-11-07 刚签发（iat 09:35）的 id_token 里仍写着 11-05 的旧周期日，
// 同一分钟上游限流头正常返回 PROLITE / 已用 58%，界面却红字「订阅已过期」。

function withAccountClaims(id, activeUntil) {
  const root = process.env.CGW_DATA_DIR
  const regPath = path.join(root, 'accounts.json')
  const authPath = path.join(root, 'accounts', id + '.json')
  fs.mkdirSync(path.join(root, 'accounts'), { recursive: true })
  fs.writeFileSync(regPath, JSON.stringify({ activeId: id, accounts: [{ id, name: 'Fixture' }] }))
  const claims = { 'https://api.openai.com/auth': { chatgpt_plan_type: 'prolite', chatgpt_subscription_active_until: activeUntil } }
  fs.writeFileSync(authPath, JSON.stringify({ tokens: { id_token: 'e30.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.fixture' } }))
  const cleanup = () => { try { fs.unlinkSync(authPath) } catch {}; try { fs.unlinkSync(regPath) } catch {} }
  return { cleanup }
}

test('快照日期已过但上游实时正常时，不得判定订阅过期', async () => {
  reset()
  const stale = new Date(Date.now() - 2 * 86400000).toISOString()
  const { cleanup } = withAccountClaims('expiry-stale', stale)
  const b = await fakeBridge({ 'x-codex-primary-used-percent': '58', 'x-codex-plan-type': 'prolite' })
  try {
    const r = await q.getAccountQuota({ bridgePort: b.port })
    assert.equal(r.source, 'realtime', '上游刚回过限流头，这就是账号可用的事实')
    assert.equal(r.weekly.usedPercent, 58)
    assert.equal(r.plan.expirySource, 'account')
    assert.ok(r.plan.expiresInDays < 0)
    assert.doesNotMatch(r.plan.expiresInText, /过期/, '快照旧了不等于订阅失效')
    assert.match(r.plan.expiresInText, /快照/)
  } finally { b.srv.close(); cleanup() }
})

test('手动登记的到期日优先于凭据快照', async () => {
  reset()
  const stale = new Date(Date.now() - 2 * 86400000).toISOString()
  const manual = new Date(Date.now() + 10 * 86400000).toISOString()
  writeFile({ shared: { plan: { expiresAt: manual } } })
  const { cleanup } = withAccountClaims('expiry-manual', stale)
  const b = await fakeBridge({ 'x-codex-primary-used-percent': '10' })
  try {
    const r = await q.getAccountQuota({ bridgePort: b.port })
    assert.equal(r.plan.expiresAt, manual, '用户在编辑里改的日期必须能生效')
    assert.equal(r.plan.expirySource, 'manual')
    assert.ok(r.plan.expiresInDays > 0)
  } finally { b.srv.close(); cleanup() }
})

test('到期日按日历日比较，当天不算过期', async () => {
  reset()
  const now = new Date()
  const todayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  writeFile({ shared: { plan: { expiresAt: todayLocal } } })
  const b = await fakeBridge({ 'x-codex-primary-used-percent': '10' })
  try {
    const r = await q.getAccountQuota({ bridgePort: b.port })
    assert.equal(r.plan.expiresInDays, 0, '本机 00:00 的到期日当天不能被 24h 整除算成 -1')
    assert.match(r.plan.expiresInText, /今天到期/)
  } finally { b.srv.close() }
})
