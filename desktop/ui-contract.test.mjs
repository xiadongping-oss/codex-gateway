// 桌面版迁移界面有两份彼此独立的契约，任何一边改了另一边不会报错，只能等冒烟跑挂才知道：
//   1. desktop/ui/migration-ui.js 通过 id 操作 desktop/ui/index.html 里的元素
//   2. desktop/src-tauri/scripts/migration-check.js（原生冒烟注入）通过同一批 id 驱动界面
// 这里把两份契约静态钉住。它替代不了真跑一遍，但能挡住最常见的「改名 / 漏改」漂移。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const html = read('desktop/ui/index.html')
const css = read('desktop/ui/style.css')
const ui = read('desktop/ui/migration-ui.js')
const injected = read('desktop/src-tauri/scripts/migration-check.js')

const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]))
const htmlViews = new Set([...html.matchAll(/data-view="([^"]+)"/g)].map(m => m[1]))

// 收集一个脚本里引用的所有元素 id：el('x') 是 migration-ui 的简写，此外还有直写的 getElementById。
function referencedIds(source) {
  const found = new Set()
  for (const m of source.matchAll(/\bel\('([a-z-]+)'\)/g)) found.add('migration-' + m[1])
  for (const m of source.matchAll(/getElementById\('([^']+)'\)/g)) found.add(m[1])
  for (const m of source.matchAll(/\$\('([^']+)'\)/g)) found.add(m[1])
  return found
}

test('界面脚本引用的每个元素都真实存在', () => {
  const missing = [...referencedIds(ui)].filter(id => !htmlIds.has(id))
  assert.deepEqual(missing, [])
})

test('冒烟注入脚本引用的每个元素都真实存在', () => {
  const missing = [...referencedIds(injected)].filter(id => !htmlIds.has(id))
  assert.deepEqual(missing, [])
})

test('注入脚本切换的每个视图都在界面里定义', () => {
  const used = new Set([...injected.matchAll(/view\('([a-z]+)'\)/g)].map(m => m[1]))
  const missing = [...used].filter(name => !htmlViews.has(name))
  assert.deepEqual(missing, [])
})

test('界面里定义的视图都被状态机覆盖', () => {
  // 多出来的视图说明改版时留了死角：要么没人切过去，要么切过去了没有渲染分支。
  const declared = new Set()
  for (const m of ui.matchAll(/(?:setView|go)\('([a-z]+)'\)/g)) declared.add(m[1])
  for (const m of ui.matchAll(/state\.view = '([a-z]+)'/g)) declared.add(m[1])
  for (const m of ui.matchAll(/view === '([a-z]+)'/g)) declared.add(m[1])
  const unused = [...htmlViews].filter(name => !declared.has(name) && !injected.includes(`view('${name}')`))
  assert.deepEqual(unused, [])
})

// 这是踩过的坑：核对计划是一次网络往返，「摘要有字」在「正在核对…」阶段就成立了，
// 此时点迁移会因为拿不到指纹而被静默拒绝，界面看起来毫无反应、用户永远卡住。
// 等待条件必须盯住「计划算完了」这个显式信号。
test('注入脚本在点击迁移前等待计划算完，而不是只看摘要有字', () => {
  assert.ok(
    injected.includes("dataset.planning === 'false'"),
    '必须等 data-planning=false；只判断摘要文本长度会在计划还没算完时就放行'
  )
  const clicks = (injected.match(/confirm\(\); next\(\)/g) || []).length
  const waits = (injected.match(/await wait\(planned\)/g) || []).length
  assert.ok(waits >= clicks, `每次点迁移前都要先等计划就绪：等待 ${waits} 次，点击 ${clicks} 次`)
})

test('界面把「计划计算中」暴露成可观测状态', () => {
  assert.ok(/dataset\.planning = value \? 'true' : 'false'/.test(ui), 'data-planning 必须随计算状态翻转')
  assert.ok(/setPlanning\(true\)/.test(ui) && /setPlanning\(false\)/.test(ui), '计划开始与结束都要翻转状态')
})

test('迁移按钮缺前置条件时会说明原因，而不是静默不动', () => {
  // 静默 return 是最难查的一类失败：用户点了没反应，日志里也什么都没有。
  const apply = ui.slice(ui.indexOf('async function apply()'), ui.indexOf('async function finish'))
  assert.ok(!/if \(!state\.plan \|\| !el\('stopped'\)\.checked\) return/.test(apply), '不允许把两个前置条件合成一次静默 return')
  assert.ok(apply.includes('MIGRATION_PLAN_REQUIRED'), '缺计划时必须给出可行动的提示')
  assert.ok(apply.includes('MIGRATION_STOP_CONFIRMATION_REQUIRED'), '未勾选确认时必须给出提示')
})

test('用到的样式类都在样式表里定义', () => {
  const used = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap(m => m[1].split(/\s+/)))
  for (const m of ui.matchAll(/className = '([^']+)'/g)) m[1].split(/\s+/).forEach(c => used.add(c))
  for (const m of ui.matchAll(/className: '([^']+)'/g)) m[1].split(/\s+/).forEach(c => used.add(c))
  const missing = [...used].filter(name => name && !css.includes('.' + name))
  assert.deepEqual(missing, [])
})
