// 接入配置生成器：给外部 OpenAI 兼容客户端复制用的 BASE_URL + API_KEY
//
// 重要事实（与 launcher.mjs /v1 鉴权一致）：
//   - 启动器对 /v1/* 有 Bearer 就严格校验：非有效 cgw- key 一律 401 invalid_api_key；
//     完全不带 Authorization 头才放行。因此接入配置绝不能写 OPENAI_API_KEY=unused——
//     多数客户端会原样发送该值，会被网关 401 拒掉。
//   - launcher 模式下前端 BASE 为空（同源相对路径），外部客户端必须用绝对地址，
//     即 window.location.origin（= 启动器端口 4173），而不是 bridge 的 10531。
//
// 【明文按需获取】
//   此前 loadAccessConfig() 每 3 秒轮询一次 /__gw/apikeys，并把明文 token 一起取回、
//   渲染进 DOM。局域网开启后这份凭据会被多台机器上的客户端间接接触到，
//   等于把跨机密钥持续摊在内存 / DOM / 浏览器历史里。
//   现在：列表只取掩码；只有用户点「复制接入配置」时才单条 reveal 一次。
import { BASE, gwRequest } from './client'

// 只取地址与掩码信息，不含明文
export async function loadAccessConfig() {
  const base = BASE || window.location.origin
  return { baseUrl: base + '/v1', apiKey: null, keyId: null, keyMask: null, model: null }
}

// 默认模型兜底：/v1/models 拉不到时也保证复制出的配置可直接用
const FALLBACK_MODEL = 'gpt-6.1-sol'
const TEXT_MODELS = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra']

// 点「复制」时才取明文：返回 { baseUrl, apiKey, model }，apiKey 可能为 null（尚未创建 Key）
export async function loadAccessConfigWithKey() {
  const base = BASE || window.location.origin
  const cfg = { baseUrl: base + '/v1', apiKey: null, model: null }
  try {
    const r = await gwRequest('/__gw/apikeys')
    const ks = (r && Array.isArray(r.keys)) ? r.keys : []
    const k = ks.find((x) => !x.disabled)
    if (k) {
      const rv = await gwRequest('/__gw/apikeys/reveal?id=' + encodeURIComponent(k.id))
      if (rv && rv.ok && rv.token) cfg.apiKey = rv.token
    }
  } catch {}
  try {
    const m = await gwRequest('/__gw/models')
    if (m && m.defaultModel) cfg.model = m.defaultModel
  } catch {}
  return cfg
}

export function formatAccessConfig(baseUrl, apiKey, model) {
  const mdl = model || FALLBACK_MODEL
  const others = TEXT_MODELS.filter((x) => x !== mdl).join(' / ')
  return (
    `# OpenAI 兼容客户端接入（Codex Gateway）\n` +
    `OPENAI_BASE_URL=${baseUrl}\n` +
    (apiKey
      ? `OPENAI_API_KEY=${apiKey}\n`
      : `OPENAI_API_KEY=<在「API Key」页创建后填入>   # 网关校验 Authorization: Bearer\n`) +
    `OPENAI_MODEL=${mdl}\n` +
    `\n` +
    `# WorkBuddy「添加模型」填写对照：\n` +
    `#   接口地址 = ${baseUrl}\n` +
    `#   API Key  = 上面 OPENAI_API_KEY\n` +
    `#   模型名称 = ${mdl}${others ? `（也可填 ${others}）` : ''}\n` +
    `#   高级配置：工具调用 ✓  图片输入 ✓  思考模式 ✓  自定义协议 ✗（网关是标准 OpenAI 兼容服务，\n` +
    `#             会自动补全 /chat/completions；勾上反而 404）\n`
  )
}
