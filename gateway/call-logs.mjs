// 真实调用日志：内存环形缓冲 + 磁盘持久化（网关重启后历史保留）
//
// 数据源：launcher.mjs / engine.js 的 /v1/* 反代层逐笔调用 recordCallLog；
// 读取：GET /__gw/call-logs → getCallLogs(100)。
// 存储：<数据根>/data/call-logs.json（内存 200 条，磁盘留 500 条，4s 节流刷盘）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDataRoot } from './data-root.mjs'
import { writeJsonAtomic } from './atomic-write.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORE_PATH = path.join(resolveDataRoot(process.env, __dirname), 'data', 'call-logs.json')
const MAX_MEM = 200
const MAX_DISK = 500
const FLUSH_MS = 4000

let seq = 0
let logs = []
let dirty = false
let flushTimer = null

function flush() {
  dirty = false
  try {
    // 原子写：写一半被杀（装机被 taskkill / 断电）不会留下截断的 JSON。
    // 上一次用的是裸 writeFileSync，损坏后 load() 的空 catch 会把整份历史静默丢掉。
    writeJsonAtomic(STORE_PATH, { seq, logs: logs.slice(0, MAX_DISK) })
  } catch {}
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
    if (Array.isArray(j.logs)) {
      // 磁盘按最新在前存 500 条，内存只保留最近 200 条；id 单调递增不回退
      logs = j.logs.slice(0, MAX_MEM)
      seq = Number(j.seq) || (logs[0] && logs[0].id) || 0
    }
  } catch {}
}
load()

export function recordCallLog(entry) {
  logs.unshift({ id: ++seq, at: Date.now(), ...entry })
  if (logs.length > MAX_MEM) logs.length = MAX_MEM
  dirty = true
  if (!flushTimer) {
    flushTimer = setInterval(() => {
      if (dirty) flush()
    }, FLUSH_MS)
    if (flushTimer.unref) flushTimer.unref()
  }
}

export function getCallLogs(limit = 100) {
  return logs.slice(0, limit)
}

export function flushCallLogs() {
  if (dirty) flush()
}
