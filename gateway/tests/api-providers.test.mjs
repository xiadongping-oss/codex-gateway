// 已保存供应商（API Key 快选）单测：注入独立存储路径，不碰真实数据根
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// api-providers 的 STORE_PATH 在模块加载时定型 → 每个测试文件独立进程跑
// 一次注入即可；node --test 默认每文件独立进程，无串扰。
const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-prov-')), 'providers.json')
process.env.API_PROVIDERS_STORE_PATH = storePath

const { listSavedProviders, saveProvider, deleteProvider } = await import('../api-providers.mjs')

test('saveProvider：登记 + 同 baseUrl 去重更新 + 最近在前', () => {
  saveProvider({ name: '中转A', baseUrl: 'https://a.example.com/v1' })
  saveProvider({ name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' })
  saveProvider({ name: '中转A-改名', baseUrl: 'https://a.example.com/v1' })
  const saved = listSavedProviders()
  assert.equal(saved.length, 2)
  assert.equal(saved[0].name, '中转A-改名')
  assert.equal(saved[1].name, 'DeepSeek')
  // **绝不存 Key**：整个存储里不应出现 api key 字样的字段
  assert.deepEqual(Object.keys(saved[0]).sort(), ['baseUrl', 'id', 'name', 'updatedAt'])
})

test('saveProvider：缺字段拒绝', () => {
  assert.throws(() => saveProvider({ name: '', baseUrl: 'https://x' }), /必填/)
})

test('deleteProvider：删除命中返回 true，未命中 false', () => {
  const [first] = listSavedProviders()
  assert.equal(deleteProvider(first.id), true)
  assert.equal(deleteProvider('pv_nonexistent'), false)
  assert.equal(listSavedProviders().length, 1)
})
