// Report elapsed waiting time, never an invented completion percentage.
function startMcpProgress(params, send, { intervalMs = 10000, heartbeat = () => {} } = {}) {
  const token = params?._meta?.progressToken
  const started = Date.now()
  const timer = setInterval(() => {
    if (typeof token === 'string' || typeof token === 'number') {
      send({ jsonrpc: '2.0', method: 'notifications/progress', params: {
        progressToken: token, progress: (Date.now() - started) / 1000,
        message: '图片仍在生成，请继续等待。'
      } })
    } else heartbeat()
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

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
import os from 'node:os'
import { fileURLToPath } from 'node:url'

// Shared image MCP mapping (kept inline so this client remains standalone).
// Keep the HTTP MCP and stdio MCP image entry points consistent.
const imageToolProperties = {
  edit_session_id: { type:'string', description:'素材页保存的标注编辑任务 ID；网关自动读取原图、标注和父版本，勿再传 image。' },
  edit_revision: { type:'integer', minimum:0, description:'与素材页复制的编辑任务版本一致。' },
  size: { type:'string', description:'auto、预设或符合约束的 WIDTHxHEIGHT；实际尺寸以返回图为准。' },
  quality: { type:'string', enum:['low','medium','high','xhigh','max','auto'], description:'默认 high；xhigh/max 需上游支持。' },
  background: { type:'string', enum:['transparent','opaque','auto'], description:'透明背景使用 PNG 或 WebP。' },
  image: { type:'string', description:'编辑原图：PNG data-URL 或网关 references 目录内路径；无蒙版编辑也可用 JPEG/WebP URL。' },
  mask: { type:'string', description:'与原图同尺寸 PNG 蒙版的 data-URL 或 references 内路径；透明区域可编辑。' },
  outpaint: { type:'object', additionalProperties:false, properties:Object.fromEntries(['left','right','top','bottom'].map(k=>[k,{type:'integer',minimum:0,maximum:2048}])), description:'自动扩图各边增加的像素数；须同时提供 PNG image，不与 mask 同用。' },
  output_format: { type:'string', enum:['png','jpeg','webp'] },
  output_compression: { type:'integer', minimum:0, maximum:100, description:'仅用于 JPEG/WebP。' },
  input_fidelity: { type:'string', enum:['high','low'], description:'仅部分上游接受；不保证人脸与细节完全一致。' },
}
function imageToolRequest(args) {
  const prompt = String(args?.prompt || '').trim()
  if (!prompt) throw new Error('prompt 不能为空')
  const body = { prompt, size:args?.size || 'auto', quality:args?.quality || 'high', response_format:'b64_json' }
  for (const field of ['background','image','mask','outpaint','output_format','output_compression','input_fidelity','edit_session_id','edit_revision']) if (args?.[field] !== undefined) body[field] = args[field]
  if (args?.reference_paths !== undefined) {
    if (!Array.isArray(args.reference_paths) || args.reference_paths.length > 8 || args.reference_paths.some(p=>typeof p !== 'string')) throw new Error('reference_paths 最多接受 8 个图片路径或 URL。')
    if (args.reference_paths.length) body.reference_images = args.reference_paths
  }
  if ((body.mask || body.outpaint) && !body.image) throw new Error('蒙版编辑和扩图必须提供 image。')
  if (body.mask && body.outpaint) throw new Error('mask 和 outpaint 不能同时使用。')
  if (body.image && body.reference_images) throw new Error('image 与 reference_paths 请只使用其中一种。')
  return { endpoint:body.image || body.edit_session_id ? '/v1/images/edits' : '/v1/images/generations', body }
}

function imagePresentation(base, item) {
  const gallery = new URL('/gallery', base)
  const filename = String(item.download_url || item.url || '').split('?')[0].split('/').pop()
  if (/^[A-Za-z0-9_-]+\.(png|jpeg|webp)$/.test(filename)) gallery.searchParams.set('image',filename)
  gallery.searchParams.set('refresh',Date.now().toString(36) + Math.random().toString(36).slice(2,8))
  const gallery_url = gallery.href
  const instruction = `每次出图成功后，请用可用的浏览器/预览工具打开或激活素材页：${gallery_url}。优先复用侧边浏览器并刷新到本次图片；若没有浏览器工具，给用户可点击链接并说明需要手动打开。首次访问使用与 MCP 相同的 API Key；不要把 Key 放入 URL。`
  return { gallery_url, instruction }
}

function imageToolResult(result) {
  const content = [{type:'text',text:result.text}]
  if (result.gallery_url) content.push({type:'resource_link',uri:result.gallery_url,name:'GPT 图片生成 · 素材页',mimeType:'text/html',description:'每次出图后打开或刷新，查看本次图片并管理个人素材。'})
  return {content,...(result.gallery_url ? {structuredContent:{gallery_url:result.gallery_url,open_gallery:true}} : {})}
}

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
        ...imageToolProperties,
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
    description: '列出当前 API Key 的个人生成图库（新→旧），支持本机与局域网。未配置 Key 时仅允许网关主机读取全量图库。',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: '返回条数，默认 20' } } }
  }
]

async function generateImage(args) {
  let body, endpoint
  try { ({body,endpoint} = imageToolRequest(args)) } catch (error) { return {ok:false,error:error.message} }

  let res, j
  try {
    res = await fetch(CGW_BASE + endpoint, {
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
    const detail = j?.detail || j?.error?.message || j?.error?.reason || ('HTTP ' + res.status)
    return { ok: false, error: '生图失败：' + detail }
  }
  const item = j.data[0]
  if (item.download_url) item.url = item.download_url
  const lines = [
    '✓ 图片已生成',
    item.cgw_image_size?.message || '实际尺寸请以下载的原图为准。',
    item.cgw_warning || null,
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
  const presentation = imagePresentation(CGW_BASE,item)
  lines.push(presentation.instruction)
  return {ok:true,text:lines.join('\n'),localPath:item.local_path || null,url:item.url || null,gallery_url:presentation.gallery_url}
}

async function listImages(args) {
  // A configured user Key is the identity boundary even on the gateway host.
  // Never bypass per-Key authorization by reading the shared directory directly.
  if (CGW_API_KEY) {
    const limit = Math.max(1, Math.min(100, Number(args?.limit) || 20))
    try {
      const res = await fetch(CGW_BASE + '/v1/gen-images/list?limit=' + limit, {
        headers: { Authorization: 'Bearer ' + CGW_API_KEY }, signal: AbortSignal.timeout(15000)
      })
      const data = await res.json()
      if (!res.ok || !Array.isArray(data.images)) return { ok: false, error: '个人图库读取失败：HTTP ' + res.status }
      const rows = data.images.map(item => item.name + (item.download_url ? '  ' + item.download_url : ''))
      return { ok: true, text: rows.length ? `你的生成图库共 ${data.total} 张（前 ${rows.length}，下载需携带同一 API Key）：\n` + rows.join('\n') : '你的生成图库为空' }
    } catch (error) { return { ok: false, error: '个人图库读取失败：' + error.message } }
  }
  if (!IS_LOCAL) {
    return { ok: false, error: 'list_generated_images 仅在网关主机本机可用（图库在网关主机的 ~/.chatgpt-bridge/gen-images）。局域网客户端请直接使用 generate_image 返回的链接查看图片。' }
  }
  const dir = path.join(os.homedir(), '.chatgpt-bridge', 'gen-images')
  let out = []
  try {
    out = fs.readdirSync(dir)
      .filter((n) => /^[A-Za-z0-9_-]+\.(?:png|jpeg|webp)$/.test(n))
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
    if (name === 'generate_image') {
      const stopProgress = startMcpProgress(params, res)
      try { r = await generateImage(args) } finally { stopProgress() }
    }
    else if (name === 'list_generated_images') r = await listImages(args)
    else return res({ id, error: { code: -32602, message: 'unknown tool: ' + name } })
    if (!r.ok) return res({ id, result: { content: [{ type: 'text', text: '✗ ' + r.error }], isError: true } })
    return res({ id, result: imageToolResult(r) })
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
