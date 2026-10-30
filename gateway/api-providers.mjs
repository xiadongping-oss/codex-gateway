// ===================================================================
// 已保存供应商（API Key 标签页的快选列表）
//
// 语义对齐 cockpit-tools 的「已保存供应商」：用户在 API Key 标签页用某个
// baseUrl+Key 添加成功后，把 name+baseUrl 记下来供下次快选。**不存 Key**——
// 密钥只活在 .gw-config.json 的 openaiApiKey（收紧 ACL 的那份）里，
// 这份清单泄露也不会带出凭据。
//
// 预设供应商清单（OpenAI 官方 / DeepSeek / 智谱 / MiniMax 等公开服务）在前端
// providerPresets.js 维护，这里只持久化用户自己的使用记录。
// ===================================================================
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { writeJsonAtomic } from './atomic-write.mjs'
import { resolveDataRoot } from './data-root.mjs'

// 存储路径可用环境变量注入（测试隔离数据目录）；默认挂数据根。
// 第二参必须传 __dirname：绿色版下 process.cwd() 可能是桌面或任意启动目录，
// 漏传会让供应商清单落到不可预期的位置（其余模块全部传 __dirname）。
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORE_PATH = process.env.API_PROVIDERS_STORE_PATH || path.join(resolveDataRoot(process.env, __dirname), 'api-providers.json')
const MAX_SAVED = 30

function loadStore() {
  try {
    const j = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'))
    if (Array.isArray(j?.saved)) return j
  } catch { /* 首次使用或损坏：按空表处理（写流程用原子写，损坏概率极低） */ }
  return { saved: [] }
}

export function listSavedProviders() {
  return loadStore().saved
}

export function saveProvider({ name, baseUrl }) {
  const n = String(name || '').trim()
  const u = String(baseUrl || '').trim()
  if (!n || !u) throw new Error('name 与 baseUrl 必填')
  const store = loadStore()
  // 同 baseUrl 只保留一条（更新名字），最近使用排最前，超出上限裁掉最旧。
  // id 用 sha256 前 16 位：base64url 截断会让同前缀 URL（https://a…）撞 id。
  const rest = store.saved.filter((p) => p.baseUrl !== u)
  const entry = { id: 'pv_' + crypto.createHash('sha256').update(u).digest('hex').slice(0, 16), name: n, baseUrl: u, updatedAt: new Date().toISOString() }
  store.saved = [entry, ...rest].slice(0, MAX_SAVED)
  writeJsonAtomic(STORE_PATH, store)
  return entry
}

export function deleteProvider(id) {
  const store = loadStore()
  const before = store.saved.length
  store.saved = store.saved.filter((p) => p.id !== id)
  writeJsonAtomic(STORE_PATH, store)
  return store.saved.length < before
}
