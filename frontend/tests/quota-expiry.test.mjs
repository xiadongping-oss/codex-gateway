// 订阅到期展示契约：登录凭据里的 chatgpt_subscription_active_until 只是
// 「订阅周期快照」，自动续费后不会及时更新。日期过了 ≠ 订阅失效，界面不许
// 据此打红字「订阅已过期」。真实事故见 gateway/tests/quota.test.mjs 末尾注释。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const card = fs.readFileSync(path.join(root, 'frontend/src/components/AccountQuotaCard.vue'), 'utf8')
const backend = fs.readFileSync(path.join(root, 'gateway/account-quota.mjs'), 'utf8')

test('界面不再出现「订阅已过期」这种由日期推断出来的强断言', () => {
  assert.doesNotMatch(card, /订阅已过期/)
  assert.doesNotMatch(card, /planUrgent === 'rose'/)
  assert.match(card, /到期日待核验/, '快照旧了要给中性提示，而不是沉默或红字')
  assert.match(card, /不代表订阅失效/, '提示里必须解释为什么这个日期不能当判据')
})

test('快照日期已过不进告警色，临期告警只对手动登记的日期生效', () => {
  assert.match(card, /if \(typeof d !== 'number' \|\| d < 0\) return ''/)
  assert.match(card, /expirySource !== 'manual'\) return ''/)
  assert.match(card, /expiryStale/)
  assert.match(card, /expire-chip\.neutral/, '中性提示要有独立样式，不能复用红色')
})

test('后端到期文案只说快照需要更新，不产出「已过期」', () => {
  const expr = backend.match(/expiresInText:[\s\S]{0,400}?\n\s*\},?\n/)?.[0] || ''
  assert.ok(expr, '必须能定位 expiresInText 分支')
  assert.doesNotMatch(expr, /已过期/)
  assert.match(expr, /快照日期已过/)
  assert.match(expr, /今天到期/)
})

test('后端：手动日期优先于凭据快照，到期日按日历日比较', () => {
  assert.match(backend, /const expiresAt = plan\.expiresAt \|\| accountPlan\.expiresAt \|\| null/)
  assert.match(backend, /new Date\(d\.getFullYear\(\), d\.getMonth\(\), d\.getDate\(\)\)/)
})
