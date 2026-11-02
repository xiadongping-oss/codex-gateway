import test from 'node:test'
import assert from 'node:assert/strict'
import { connectionStatus } from '../src/utils/connection-status.js'
const base = { mode: 'bridge', running: true, loggedIn: true }
test('地区限制给出单一可操作提示，不显示令牌响应原文', () => {
  const status = connectionStatus({ ...base, health: { ok: false, data: { error: 'Token refresh failed (HTTP 403). unsupported_country_region_territory secret' } } })
  assert.equal(status.action, 'settings')
  assert.equal(status.tone, 'error')
  assert.match(status.description, /403/)
  assert.doesNotMatch(JSON.stringify(status), /secret|Token refresh/)
})
test('凭据已保存不代表连接成功', () => {
  assert.equal(connectionStatus({ ...base, health: { ok: false } }).tone, 'error')
  assert.equal(connectionStatus({ ...base, health: { ok: true } }).tone, 'success')
  assert.equal(connectionStatus({ ...base, running: false }).tone, 'neutral')
})
test('授权失效与空账号提供不同处理方式', () => {
  assert.match(connectionStatus({ ...base, health: { error: 'HTTP 401 invalid_grant' } }).title, /授权/)
  assert.match(connectionStatus({ ...base, loggedIn: false }).title, /尚未配置/)
})
