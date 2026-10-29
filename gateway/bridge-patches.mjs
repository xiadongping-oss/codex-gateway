// chatgpt-bridge vendored 补丁守护
//
// 背景：gateway/node_modules/chatgpt-bridge 是 vendored 零依赖包，其上叠加了 4 组手写补丁：
//   1) Upstream.call 捕获上游 x-codex-* / x-ratelimit-* 限流头，/health 透出 last_upstream_limits
//   2) translateChatMessages：assistant 消息 text/input_text → output_text（Codex 严格校验）
//   3) normalizeResponsesBody：sanitizeResponsesInput 对 /v1/responses 的 input 做同规则净化
//   4) /v1/responses 非流式：上游强制 stream:true → 本地强制流式并聚合为 Responses JSON
//   5) /v1/chat/completions 工具调用：调用方 tools/tool_choice/tool 历史转 Responses，
//      Responses function_call 事件回转 Chat Completions tool_calls（逻辑在 gateway/chat-tools.mjs）
// npm install / 升级该包会静默清掉全部补丁。本模块在网关启动时校验标记，缺失即从快照恢复。
//
// 快照位置：gateway/patches/{cli,index}.patched.js（由补丁改完后的 dist 文件复制而来）。
// 若将来再给 bridge 打新补丁：改完 dist 后务必同步刷新快照，否则会被旧快照覆盖。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 标记取最晚加入的补丁符号；存在即认为整套补丁在位
const MARKER = 'chatTools.convertChatToolsToResponses'
const FILES = ['cli.js', 'index.js']

export function ensureBridgePatched(log = () => {}) {
  const distDir = path.join(__dirname, 'node_modules', 'chatgpt-bridge', 'dist')
  const snapDir = path.join(__dirname, 'patches')
  const repaired = []
  for (const f of FILES) {
    const distPath = path.join(distDir, f)
    const snapPath = path.join(snapDir, f.replace(/\.js$/, '.patched.js'))
    if (!fs.existsSync(snapPath)) {
      log(`⚠ bridge 补丁快照缺失：patches/${f.replace(/\.js$/, '.patched.js')}，跳过恢复`)
      continue
    }
    let cur = null
    try { cur = fs.readFileSync(distPath, 'utf8') } catch {}
    if (cur && cur.includes(MARKER)) continue
    try {
      fs.copyFileSync(snapPath, distPath)
      repaired.push(f)
    } catch (e) {
      log(`✗ 恢复 bridge 补丁失败（${f}）：${e.message}`)
    }
  }
  if (repaired.length) log(`◆ 检测到 bridge 补丁丢失，已从快照恢复：${repaired.join(', ')}`)
  else log('· bridge 补丁校验通过')
  return { repaired }
}
