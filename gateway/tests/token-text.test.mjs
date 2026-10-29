// Token / JSON 多格式文本解析测试（parseAuthTokenText / normalizeAuthJson 扩展 / exchangeRefreshToken）
// 覆盖：camelCase、personal_access_token、Sub2API 嵌套探测、裸 JWT、at-/sk- 令牌、
// refresh_token 联网换取（注入 fetch，不外联）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAuthJson, parseAuthTokenText, exchangeRefreshToken, looksLikeJwt } from '../auth-core.mjs'

// ---------- normalizeAuthJson 扩展形态 ----------

test('normalizeAuthJson：camelCase accessToken+refreshToken → snake_case tokens', () => {
  const r = normalizeAuthJson({ accessToken: 'at.a.b', refreshToken: 'rt-1', idToken: null })
  assert.equal(r.auth_mode, 'chatgpt')
  assert.equal(r.tokens.access_token, 'at.a.b')
  assert.equal(r.tokens.refresh_token, 'rt-1')
  assert.equal(r.OPENAI_API_KEY, null)
})

test('normalizeAuthJson：camelCase 仅 accessToken → refresh 为 null（导入宽松，提示由上层给）', () => {
  const r = normalizeAuthJson({ accessToken: 'at.a.b' })
  assert.equal(r.tokens.access_token, 'at.a.b')
  assert.equal(r.tokens.refresh_token, null)
})

test('normalizeAuthJson：personal_access_token → api_key 形态', () => {
  const r = normalizeAuthJson({ personal_access_token: 'at-xyz' })
  assert.equal(r.auth_mode, 'api_key')
  assert.equal(r.OPENAI_API_KEY, 'at-xyz')
  assert.equal(r.tokens, null)
})

test('normalizeAuthJson：Sub2API 嵌套（第一层对象里有 access_token）→ 递归命中', () => {
  const r = normalizeAuthJson({
    exported_at: '2026-10-29',
    account: { access_token: 'tok-1', refresh_token: 'rt-2' }
  })
  assert.equal(r.tokens.access_token, 'tok-1')
  assert.equal(r.tokens.refresh_token, 'rt-2')
})

test('normalizeAuthJson：嵌套 tokens 包裹（Sub2API 变体）→ 第一分支处理', () => {
  const r = normalizeAuthJson({
    source: 'sub2api',
    credentials: { tokens: { access_token: 'a1', refresh_token: 'r1' } }
  })
  assert.equal(r.tokens.access_token, 'a1')
  assert.equal(r.tokens.refresh_token, 'r1')
})

test('normalizeAuthJson：两层深的巧合字段不误伤（只探一层）', () => {
  assert.throws(() => normalizeAuthJson({ a: { b: { access_token: 'x' } } }), /无法识别/)
})

test('normalizeAuthJson：原有 snake_case 行为不回归（tokens 包裹 / 裸字段 / api_key）', () => {
  assert.equal(normalizeAuthJson({ tokens: { access_token: 'a', refresh_token: 'r' } }).tokens.refresh_token, 'r')
  assert.equal(normalizeAuthJson({ access_token: 'a' }).tokens.access_token, 'a')
  assert.equal(normalizeAuthJson({ OPENAI_API_KEY: 'sk-x' }).auth_mode, 'api_key')
})

// ---------- parseAuthTokenText ----------

test('parseAuthTokenText：空文本 → 明确报错', () => {
  assert.throws(() => parseAuthTokenText('   '), /请粘贴凭据内容/)
})

test('parseAuthTokenText：JSON 对象 → kind json', () => {
  const r = parseAuthTokenText('{"access_token":"a","refresh_token":"b"}')
  assert.equal(r.kind, 'json')
  assert.equal(r.data.tokens.refresh_token, 'b')
})

test('parseAuthTokenText：{ 开头但坏 JSON → 报错不误判为 refresh', () => {
  assert.throws(() => parseAuthTokenText('{"access_token": '), /JSON 解析失败/)
})

test('parseAuthTokenText：at- / sk- 令牌 → api_key', () => {
  assert.equal(parseAuthTokenText('at-abc123').data.auth_mode, 'api_key')
  assert.equal(parseAuthTokenText('sk-abc123').data.OPENAI_API_KEY, 'sk-abc123')
})

test('parseAuthTokenText：裸 JWT → json + 无续期能力警告', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig'
  const r = parseAuthTokenText(jwt)
  assert.equal(r.kind, 'json')
  assert.match(r.warning, /refresh_token/)
  assert.equal(r.data.tokens.access_token, jwt)
})

test('parseAuthTokenText：其余文本 → kind refresh_token', () => {
  const r = parseAuthTokenText('some-opaque-refresh-token-value')
  assert.equal(r.kind, 'refresh_token')
  assert.equal(r.refreshToken, 'some-opaque-refresh-token-value')
})

test('looksLikeJwt：JWT 三段式为真，两段/普通文本为假', () => {
  assert.equal(looksLikeJwt('eyJh.eyJz.c2ln'), true)
  assert.equal(looksLikeJwt('eyJh.eyJz'), false)
  assert.equal(looksLikeJwt('hello world'), false)
})

// ---------- exchangeRefreshToken（注入 fetch） ----------

test('exchangeRefreshToken：成功 → tokens 完整；响应未带新 refresh 时保留原值', async () => {
  const calls = []
  const fakeFetch = async (url, opts) => {
    calls.push({ url, body: String(opts.body) })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: 'new-at', id_token: 'idt' })
    }
  }
  const r = await exchangeRefreshToken('rt-orig', { fetchImpl: fakeFetch })
  assert.equal(r.tokens.access_token, 'new-at')
  assert.equal(r.tokens.refresh_token, 'rt-orig')
  assert.equal(calls.length, 1)
  assert.ok(calls[0].url.includes('auth.openai.com/oauth/token'))
  assert.ok(calls[0].body.includes('grant_type=refresh_token'))
})

test('exchangeRefreshToken：HTTP 400 + error_description → 透出原因', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'token expired' })
  })
  await assert.rejects(exchangeRefreshToken('bad', { fetchImpl: fakeFetch }), /token expired/)
})

test('exchangeRefreshToken：非 JSON 响应 → 报 HTTP 状态', async () => {
  const fakeFetch = async () => ({ ok: false, status: 502, text: async () => '<html>bad gateway</html>' })
  await assert.rejects(exchangeRefreshToken('x', { fetchImpl: fakeFetch }), /HTTP 502/)
})

test('exchangeRefreshToken：网络异常 → 带上下文的报错', async () => {
  const fakeFetch = async () => { throw new Error('ECONNREFUSED') }
  await assert.rejects(exchangeRefreshToken('x', { fetchImpl: fakeFetch }), /网络或出网代理/)
})

test('exchangeRefreshToken：空 refresh → 拒绝', async () => {
  await assert.rejects(exchangeRefreshToken('  ', { fetchImpl: async () => ({}) }), /缺少 refresh_token/)
})
