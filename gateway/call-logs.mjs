// 真实调用日志：内存环形缓冲 + 磁盘持久化（网关重启后历史保留）
//
// 数据源：launcher.mjs / engine.js 的 /v1/* 反代层逐笔调用 recordCallLog；
// 读取：GET /__gw/call-logs → getCallLogs(100)。
// 存储：<数据根>/data/call-logs.json（内存 200 条，磁盘留 500 条，4s 节流刷盘）。
import fs from 'node:fs'
import { currentCaller } from './request-context.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDataRoot } from './data-root.mjs'
import { writeJsonAtomic } from './atomic-write.mjs'
import { callLogKind, aggregateManagement } from './call-log-policy.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORE_PATH = path.join(resolveDataRoot(process.env, __dirname), 'data', 'call-logs.json')
const MAX_MEM = 200
const MAX_DISK = 500
const FLUSH_MS = 4000

let seq = 0
let logs = []
let management = []
let lanTokens = 0, trackingSince = Date.now()
const lanUsers = new Map()
let dirty = false
let flushTimer = null

function flush() {
  writeJsonAtomic(STORE_PATH, { seq, logs: logs.slice(0, MAX_DISK), management, lanUsage: { tokensTotal:lanTokens, trackingSince, users:[...lanUsers] } })
  dirty = false // Failed writes must remain retryable.
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
    if (Array.isArray(j.logs)) {
      // 磁盘按最新在前存 500 条，内存只保留最近 200 条；id 单调递增不回退
      seq = Number(j.seq) || (j.logs[0] && j.logs[0].id) || 0
      logs = j.logs.filter(entry => callLogKind(entry) === 'business').slice(0,MAX_MEM)
      management = Array.isArray(j.management) ? j.management.slice(0,100) : []
      for (const entry of j.logs.filter(entry => callLogKind(entry) === 'management').reverse()) aggregateManagement(management,entry)
      management.length = Math.min(management.length,100)
      if (j.lanUsage) {
        lanTokens = Number(j.lanUsage.tokensTotal) || 0
        trackingSince = Number(j.lanUsage.trackingSince) || Date.now()
        for (const [id,at] of j.lanUsage.users || []) if (at > Date.now()-300000) lanUsers.set(id,at)
      } else {
        trackingSince = Date.now()
        // Historic totals lack a complete source breakdown; start an explicit
        // new counter rather than presenting a retained log slice as all-time.
      }
    }
  } catch {}
}
load()

export function recordCallLog(entry) {
  const record = { id: ++seq, at: Date.now(), ...entry, caller: entry.caller || currentCaller() }
  if (callLogKind(record) === 'management') {
    aggregateManagement(management,record)
    management.length = Math.min(management.length,100)
  } else {
    logs.unshift(record)
    if (record.caller?.source === 'lan' && record.caller.keyId) {
      lanUsers.set(record.caller.keyId,record.at)
      const tokens = record.usage?.totalTokens ?? record.tokens
      if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0) lanTokens += tokens
    }
  }
  if (logs.length > MAX_MEM) logs.length = MAX_MEM
  dirty = true
  if (!flushTimer) {
    flushTimer = setInterval(() => {
      try { if (dirty) flush() } catch { /* keep dirty for shutdown/retry */ }
    }, FLUSH_MS)
    if (flushTimer.unref) flushTimer.unref()
  }
}

export function getCallLogs(limit = 100) {
  return logs.slice(0, limit)
}

export const getManagementLogs = (limit = 100) => management.slice(0,limit)
export function getLanUsage(now = Date.now()) {
  for (const [id,at] of lanUsers) if (at <= now-300000) lanUsers.delete(id)
  return {activeUsers:lanUsers.size,tokensTotal:lanTokens,trackingSince,activeWindowSec:300}
}

export function flushCallLogs() {
  clearInterval(flushTimer)
  flushTimer = null
  if (dirty) flush()
}
