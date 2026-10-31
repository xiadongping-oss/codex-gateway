// codex-gateway 生图 MCP Server（stdio，零依赖）
//
// 把网关的 /v1/images/generations 暴露为 MCP 工具，供 WorkBuddy 内任意模型
// （Claude / GLM / Gemini …）在生图任务时调用——模型只需支持 function calling。
//
// 配置（~/.workbuddy/mcp.json）：
//   "codex-gateway": {
//     "command": "<node 绝对路径>",
//     "args": ["<本文件绝对路径>"],
//     "env": { "CGW_API_KEY": "cgw-..." }
//   }
//
// 协议：MCP stdio = 按行分隔的 JSON-RPC 2.0。仅实现本场景所需子集：
//   initialize / notifications/*（忽略）/ tools/list / tools/call / ping
import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import { resolveStoragePaths } from './storage-paths.mjs'
import { validateStorageReader } from './storage-init.mjs'
import { fileURLToPath } from 'node:url'

// 版本号以仓库根 package.json 为准，不在这里硬编码——历史上这里写死 1.1.0，
// 落后了三个版本，客户端 initialize 拿到的版本号是错的。
// 只认 name = codex-gateway 的那份（gateway/package.json 是 0.1.0，读了会报错版本），
// 读不到就如实报 unknown。
const SERVER_VERSION = (() => {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'))
      if (pkg.name === 'codex-gateway' && pkg.version) return pkg.version
    } catch { /* 试下一个候选 */ }
  }
  return 'unknown'
})()

const CGW_BASE = (process.env.CGW_BASE || 'http://127.0.0.1:4173').replace(/\/+$/, '')
const CGW_API_KEY = process.env.CGW_API_KEY || ''
// 局域网模式：CGW_BASE 指向网关主机时，返回的 local_path 在主机磁盘上（本机不可读），
// 图库也在主机本机。以下按模式调整提示文案与工具可用性。
const IS_LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(CGW_BASE)

const STORAGE = IS_LOCAL ? resolveStoragePaths() : null
validateStorageReader(STORAGE)

const TOOLS = [
  {
    name: 'generate_image',
    description:
      '用本地 Codex 网关生成图片（OpenAI 图像模型，gpt-image 系）。' +
      '适用于用户要求「画/生成/绘制图片」的任务。返回图片的 http url 与网关主机侧路径 local_path：' +
      '本机模式下可用 Read 工具查看 local_path 做视觉理解；局域网模式下请携带 Key 下载，或在素材站输入 Key 查看，local_path 在网关主机上不可读。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '图像描述（建议具体：主体/风格/构图/色调）' },
        size: { type: 'string', enum: ['1024x1024', '1024x1536', '1536x1024', 'auto'], description: '请求尺寸，缺省 auto（由上游选择）。实际像素尺寸可能与请求不同，以返回原图及结果说明为准；网关不会自动缩放。' },
        quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'], description: '质量，缺省 high（网关最高质量策略）' },
        reference_paths: {
          type: 'array', items: { type: 'string' },
          description: '可选：参考图（最多 8 张），生成风格/构图与之协调的新图。可传 http(s) URL 或 data-URL；若传本地路径，必须位于网关的参考图目录内（相对路径按该目录解析），越界会被拒绝。注意：本地路径以「网关主机」磁盘视角解析——局域网模式传客户端本机路径无效'
        }
      },
      required: ['prompt']
    }
  },
  {
    name: 'list_generated_images',
    description: '列出网关生成图库（与网关配置的数据目录一致）中已有的图片（新→旧）。仅网关主机本机可用；局域网客户端请直接使用 generate_image 返回的链接。',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: '返回条数，默认 20' } } }
  }
]

async function generateImage(args) {
  const prompt = String(args?.prompt || '').trim()
  if (!prompt) return { ok: false, error: 'prompt 不能为空' }

  const body = { prompt, size: args?.size || 'auto', quality: args?.quality || 'high', response_format: 'b64_json' }
  if (Array.isArray(args?.reference_paths) && args.reference_paths.length) {
    // bridge AttachmentSpec 支持 { path }（网关本机路径，由 bridge 自行读盘）
    body.reference_images = args.reference_paths.slice(0, 8).map((p) => ({ path: String(p) }))
  }

  let res, j
  try {
    res = await fetch(CGW_BASE + '/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(CGW_API_KEY ? { Authorization: 'Bearer ' + CGW_API_KEY } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000)
    })
    j = await res.json().catch(() => null)
  } catch (e) {
    return { ok: false, error: '网关请求失败：' + e.message }
  }
  if (!res.ok || !j?.data?.[0]?.b64_json) {
    const detail = j?.error?.message || j?.error?.reason || ('HTTP ' + res.status)
    return { ok: false, error: '生图失败：' + detail }
  }
  const item = j.data[0]
  if (item.download_url) item.url = item.download_url
  const lines = [
    '✓ 图片已生成',
    item.cgw_image_size?.message || '实际尺寸请以下载的原图为准。',
    item.url ? `下载：${item.url}（${item.download_url ? '请求需携带当前 API Key 的 Bearer 请求头；也可在素材站输入 Key 查看' : '访问权限取决于网关配置，本机可在控制台查看'}）` : null,
    IS_LOCAL
      ? (item.local_path ? `文件：${item.local_path}（用 Read 工具查看可做视觉理解）` : null)
      : (item.url ? `链接：${item.url}（按上述权限说明下载后可做视觉理解）` : null),
    !IS_LOCAL && item.local_path ? `主机路径：${item.local_path}（仅网关主机可读）` : null,
    !IS_LOCAL && Array.isArray(args?.reference_paths) && args.reference_paths.length
      ? '⚠️ 参考图按「网关主机」磁盘路径解析：你传的客户端本机路径主机读不到，参考图效果可能未生效。' : null,
    item.revised_prompt ? `优化后的提示词：${item.revised_prompt}` : null,
    '该图片已自动进入网关控制台「图片素材 → 生成图库」。'
  ].filter(Boolean)
  return { ok: true, text: lines.join('\n'), localPath: item.local_path || null, url: item.url || null }
}

function listImages(args) {
  if (!IS_LOCAL) {
    return { ok: false, error: 'list_generated_images 仅在网关主机本机可用。局域网客户端请直接使用 generate_image 返回的链接查看图片。' }
  }
  const dir = STORAGE.generated
  let out = []
  try {
    out = fs.readdirSync(dir)
      .filter((n) => /^[A-Za-z0-9_-]+\.png$/.test(n))
      .map((n) => {
        const st = fs.statSync(path.join(dir, n))
        return { name: n, size: st.size, mtime: st.mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch {}
  const limit = Math.max(1, Math.min(100, Number(args?.limit) || 20))
  const rows = out.slice(0, limit).map((i) => {
    const kb = i.size >= 1024 * 1024 ? (i.size / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(i.size / 1024)) + ' KB'
    const d = new Date(i.mtime)
    const p = (x) => String(x).padStart(2, '0')
    return `${i.name}  ${kb}  ${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  })
  return { ok: true, text: rows.length ? `生成图库共 ${out.length} 张（前 ${rows.length}）：\n` + rows.join('\n') : '生成图库为空' }
}

function toolResult(text) {
  return { content: [{ type: 'text', text }] }
}

async function dispatch(id, method, params, res) {
  if (method === 'initialize') {
    return res({
      id, result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'codex-gateway-image', version: SERVER_VERSION }
      }
    })
  }
  if (method === 'tools/list') {
    return res({ id, result: { tools: TOOLS } })
  }
  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments || {}
    let r
    if (name === 'generate_image') r = await generateImage(args)
    else if (name === 'list_generated_images') r = listImages(args)
    else return res({ id, error: { code: -32602, message: 'unknown tool: ' + name } })
    if (!r.ok) return res({ id, result: { content: [{ type: 'text', text: '✗ ' + r.error }], isError: true } })
    return res({ id, result: toolResult(r.text) })
  }
  if (method === 'ping') return res({ id, result: {} })
  if (id !== undefined && id !== null) {
    return res({ id, error: { code: -32601, message: 'method not found: ' + method } })
  }
  // 无 id 的 notification（initialized 等）——忽略
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  const send = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n')
  rl.on('line', (line) => {
    const s = line.trim()
    if (!s) return
    let msg
    try { msg = JSON.parse(s) } catch { return }
    dispatch(msg.id, msg.method, msg.params, send).catch((e) => {
      if (msg.id !== undefined && msg.id !== null) {
        send({ id: msg.id, error: { code: -32603, message: String(e && e.message || e) } })
      }
    })
  })
  rl.on('close', () => process.exit(0))
  process.on('SIGINT', () => process.exit(0))
  process.stderr.write(`codex-gateway MCP ready (base=${CGW_BASE}${CGW_API_KEY ? ', key=***' + CGW_API_KEY.slice(-4) : ', key=<unset>'})\n`)
}

main()
