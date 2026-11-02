<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import * as api from '../api/gateway'
import { BASE, copyText } from '../api/client'

const models = ref([])
const caps = ref({ text: false, image: false, vision: false })
const loading = ref(false)
const loadErr = ref('')
const upstreamOk = ref(true)
const upstreamErr = ref('')
// 被网关精简掉的上游旧世代条数（目录只留主力，旧世代不再下发）
const hiddenCount = ref(0)

const accounts = ref([])
const activeId = ref(null)
const apikeys = ref([])
const suggest = ref({ text: 'gpt-6.1-sol', image: 'gpt-image-2.5-sunburst' })

// 实际生图模型：ChatGPT 订阅通道没有独立图片模型，
// 生图一律由「某个对话模型 + image_generation 工具」渲染。
// 该值来自 /__gw/status.imageModel，与网关注入 bridge 的完全一致。
const imageModel = ref('')
const imageModelVia = ref('')

const baseUrl = (typeof window !== 'undefined' ? window.location.origin : '') || BASE || 'http://127.0.0.1:4173'

const selectedModel = ref('')
const selectedKeyId = ref('')    // '' = 不填 key（仅本机 + 无密码模式，不推荐远程用）
const manualKey = ref('')
const useManual = ref(false)
// 【按需取明文】列表接口不再返回明文，复制时才向 /__gw/apikeys/reveal 单条取
const selectedKeyToken = ref('')
watch(selectedKeyId, () => { selectedKeyToken.value = '' })

async function ensureKeyToken() {
  if (useManual.value) return manualKey.value || ''
  const k = selectedKey.value
  if (!k) return ''
  if (selectedKeyToken.value) return selectedKeyToken.value
  const rv = await api.revealApiKey(k.id)
  if (rv && rv.token) selectedKeyToken.value = rv.token
  return selectedKeyToken.value
}

const compats = [
  '/v1/responses （Codex 入口）',
  '/v1/chat/completions',
  '/v1/images/generations （占位名 gpt-image-2.5-sunburst / -flare）',
  '/v1/models',
  '/health'
]
const kindTag = (k) => (k === 'image' ? '图片' : '文本')

const activeAccount = computed(() => accounts.value.find((a) => a.id === activeId.value) || null)
const selectedKey = computed(() => apikeys.value.find((k) => k.id === selectedKeyId.value) || null)

// 视觉理解：从真实模型列表推断支持视觉的模型（自原「视觉理解」页并入）
const visionModels = computed(() => models.value.filter((m) => m.vision))
const visionExample = computed(() => JSON.stringify({
  model: visionModels.value[0]?.id || selectedModel.value || 'gpt-6.1-sol',
  input: [{
    role: 'user',
    content: [
      { type: 'input_text', text: '描述这张图片' },
      { type: 'input_image', image_url: 'https://example.com/image.png 或 data:image/png;base64,...' }
    ]
  }]
}, null, 2))

const configObj = computed(() => ({
  baseUrl: baseUrl + '/v1',
  apiKey: useManual.value ? (manualKey.value || '<your-cgw-key>') : (selectedKeyToken.value || '<your-cgw-key>'),
  model: selectedModel.value || suggest.value.text
}))
const configText = computed(() => JSON.stringify(configObj.value, null, 2))
const envText = computed(
  () => `OPENAI_BASE_URL=${baseUrl}/v1\n` +
        `OPENAI_API_KEY=${useManual.value ? (manualKey.value || '<your-cgw-key>') : (selectedKeyToken.value || '<your-cgw-key>')}\n` +
        `OPENAI_MODEL=${selectedModel.value || suggest.value.text}`
)

const copiedText = ref('')
const copiedEnv = ref('')
const copyMsg = ref('')
async function copyOne(target, label, setRef) {
  const t = target || ''
  if (!t) {
    setRef.value = '✕ 没有内容'
    setTimeout(() => (setRef.value = ''), 1500)
    return
  }
  try {
    // 复制前先把所选 Key 的明文取回来（列表接口不再携带明文）
    await ensureKeyToken()
    await copyText(t)
    setRef.value = '✓ 已复制'
    copyMsg.value = `已复制：${label}`
    setTimeout(() => { setRef.value = ''; copyMsg.value = '' }, 1800)
  } catch (e) {
    setRef.value = '✕ 复制失败'
    copyMsg.value = (e?.message || '复制失败')
    setTimeout(() => { setRef.value = ''; copyMsg.value = '' }, 3000)
  }
}

async function refreshAll(force = false) {
  loading.value = true
  loadErr.value = ''
  try {
    const [m, a, ks, st] = await Promise.all([
      api.getModels({ refresh: force }),
      api.getAccounts(),
      api.listApiKeys(),
      api.getGatewayStatus()
    ])
    models.value = m || []
    apikeys.value = ks || []
    accounts.value = (a && a.accounts) || []
    activeId.value = (a && a.activeId) || null
    // 实际生图模型（与网关注入 bridge 的同一个值）
    imageModel.value = (st && st.imageModel) || ''
    imageModelVia.value = (st && st.imageModelVia) || ''
    // 能力就地派生：不为此再打一次 /__gw/models
    caps.value = api.deriveCapabilities(models.value)
    // /v1/models 现在返回目录兜底：上游挂了也有模型可选，这里只提示降级
    upstreamOk.value = m ? m.modelsOk !== false : false
    upstreamErr.value = (m && m.upstreamError) || ''
    hiddenCount.value = (m && Number(m.hiddenCount)) || 0
    if (m && m.defaultModel) suggest.value.text = m.defaultModel
    if (!selectedModel.value) {
      const texts = (m || []).filter((x) => x.kind === 'text')
      selectedModel.value = (m && m.defaultModel) || (texts.find((x) => x.core) || texts[0])?.id || 'gpt-6.1-sol'
    }
  } catch (e) {
    loadErr.value = e?.message || '拉取失败'
  } finally {
    loading.value = false
  }
}

onMounted(refreshAll)
watch(() => models.value.length, () => {
  if (!selectedModel.value && models.value.length) selectedModel.value = models.value[0].id
})
</script>

<template>
  <div class="content">
    <div class="card">
      <div class="card-title-row">
        <div class="card-title">可用模型</div>
        <span class="card-meta">{{ models.length }} 个</span>
        <button class="btn-ghost sm" @click="refreshAll(true)" :disabled="loading">{{ loading ? '刷新中…' : '刷新' }}</button>
      </div>
<div class="card-sub" style="margin-bottom: 12px">
        来自 <code>GET /v1/models</code>＝上游真实列表 ∪ 本地主力模型目录（上游不可达时仍可配置）。
        列表只下发<b>当前主力</b>：文本 3 个（<code>gpt-6.1-sol</code> / <code>gpt-6-astra</code> / <code>gpt-6.1-terra</code>）
        + 图片 2 档（<code>gpt-image-2.5-sunburst</code> / <code>gpt-image-2.5-flare</code>）。
        -wm 工作变体已移除（上游 ChatGPT 登录态不支持）；旧世代一律不列出（仍可直接按 ID 调用，不会被改写）。
        标记 <span class="inline-core">主力</span> 的模型恒在列表内，且支持简写别名（<code>sol</code> / <code>gpt-6</code> / <code>astra</code> / <code>terra</code>）。
        <template v-if="hiddenCount">
          <br />已隐藏 {{ hiddenCount }} 个旧世代 / 下线模型。
        </template>
      </div>
      <div v-if="!upstreamOk" class="degraded">
        <span class="warn-dot">!</span>
        上游模型列表暂不可用（{{ upstreamErr || '未知原因' }}），当前展示本地目录兜底模型。
        重新授权后会自动并回上游真实列表。
      </div>
      <div class="grid" v-if="models.length">
        <button
          v-for="m in models"
          :key="m.id"
          class="model-chip"
          :class="{ selected: selectedModel === m.id }"
          @click="selectedModel = m.id"
          :title="m.id"
        >
          <code class="mid">{{ m.id }}</code>
          <span class="tag" :class="m.kind">{{ kindTag(m.kind) }}</span>
          <span class="tier" v-if="m.tier">{{ m.tier }}</span>
          <span class="core" v-if="m.core">主力</span>
          <span class="vision" v-if="m.vision">视觉</span>
        </button>
      </div>
      <div v-else-if="loading" class="empty">加载中…</div>
      <div v-else class="empty err">
        {{ loadErr || '暂无可用模型。请确认 bridge 已启动且授权有效。' }}
      </div>

<div class="image-note" v-if="imageModel">
        <div class="image-note-title">图片模型说明</div>
        <div class="image-note-body">
          ChatGPT 订阅通道<b>没有独立的图片模型</b>。列表里的
          <code>gpt-image-2.5-sunburst</code>（标准）/ <code>gpt-image-2.5-flare</code>（高清）
          是 OpenAI 官方 API 命名的<b>占位条目</b>，用于让客户端能填出合法的 model 字段；
          <code>size</code> / <code>quality</code> 按请求参数正常生效，
          但<b>实际渲染的模型</b>一律由
          <code class="hl">{{ imageModelVia || (imageModel + ' + image_generation 工具') }}</code>
          完成 —— 请求里的 model 字段不会改变实际渲染模型。
          <br />
          网关会在响应中回写真实模型（<code>model</code> 字段与 <code>x-cgw-image-model</code> 响应头），并把调用方填写的占位名记在 <code>cgw_requested_model</code> 里，便于核对。
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title-row">
        <div class="card-title">复制接入配置</div>
        <span class="card-meta">{{ apikeys.length }} 个 Key · 已选 {{ selectedKey ? selectedKey.name : '未选择' }}</span>
      </div>
      <div class="card-sub" style="margin-bottom: 14px">
        选模型 + 选 API Key，一键复制 OpenAI 兼容配置即可粘到 WorkBuddy 等客户端。
      </div>

      <div class="cfg">
        <label class="cfg-row">
          <span class="lbl">基础地址 (baseUrl)</span>
          <div class="val mono readonly">{{ baseUrl }}/v1</div>
        </label>

        <label class="cfg-row">
          <span class="lbl">模型</span>
          <select v-model="selectedModel" class="cfg-input">
            <optgroup v-if="models.filter((m) => m.kind === 'text').length" label="文本模型">
              <option v-for="m in models.filter((m) => m.kind === 'text')" :key="m.id" :value="m.id">{{ m.id }}</option>
            </optgroup>
            <optgroup v-if="models.filter((m) => m.kind === 'image').length" label="图片模型">
              <option v-for="m in models.filter((m) => m.kind === 'image')" :key="m.id" :value="m.id">{{ m.id }}</option>
            </optgroup>
          </select>
        </label>

        <div class="cfg-row">
          <span class="lbl">绑定账号</span>
          <div class="val mono">{{ activeAccount ? activeAccount.name + '（' + activeAccount.id + '）' : '未激活' }}</div>
        </div>

        <div class="cfg-row">
          <span class="lbl">API Key</span>
          <div class="key-area">
            <label class="toggle">
              <input type="checkbox" v-model="useManual" />
              <span>手动粘贴</span>
            </label>
            <select v-if="!useManual" v-model="selectedKeyId" class="cfg-input">
              <option value="">— 选择一个已创建的 Key —</option>
              <option v-for="k in apikeys" :key="k.id" :value="k.id">
                {{ k.name }}{{ k.accountId ? '（绑 ' + (accounts.find((a) => a.id === k.accountId)?.name || k.accountId) + '）' : '（跟随激活）' }} · {{ k.mask }}
              </option>
            </select>
            <input v-else v-model="manualKey" type="password" class="cfg-input mono" placeholder="cgw-..." />
            <a href="#/apikeys" class="link" @click.prevent="$emit('navigate', 'apikeys')">管理 Key →</a>
          </div>
        </div>

        <div class="cfg-actions">
          <button class="btn-primary sm" :disabled="!configText" @click="copyOne(configText, 'JSON 配置', copiedText)">
            {{ copiedText || '复制为 JSON' }}
          </button>
          <button class="btn-primary sm alt" :disabled="!envText" @click="copyOne(envText, '.env 配置', copiedEnv)">
            {{ copiedEnv || '复制为 .env' }}
          </button>
        </div>

        <pre class="code-block">{{ configText }}</pre>

        <!-- WorkBuddy 添加模型对照：用户实测每次都要想怎么勾，直接给出结论 -->
<div class="wb-guide">
          <div class="wb-guide-title">填到 WorkBuddy「添加模型」：</div>
          <div class="wb-guide-body">
            <b>基础三项：</b>接口地址 <code>{{ baseUrl }}/v1</code> · API Key 上面选的 cgw- 密钥 · 模型名称 <code>{{ configObj.model }}</code>
            <br /><b>高级配置勾选：</b>工具调用 ✓（已验证：Read / Write / Bash 等本地工具可正常调用）· 图片输入 ✓ · 思考模式 ✓ · 仅思考模式 ✗ · 允许关闭思考 ✓
            <br /><b>思考强度：</b>默认「自动」；支持「低 / 中 / 高 / 超高 / 极致」（上游不支持的强度会被网关忽略并回落默认值，不会报错）
            <br /><b>输入 / 输出：</b>留空用提供商默认值
            <br /><b>自定义协议：不要勾</b>——勾了 WorkBuddy 不再自动补全 <code>/chat/completions</code> 路径，请求会打到网关没有的路由上直接 404
          </div>
        </div>

        <p class="hint" v-if="!useManual && !selectedKeyId">
          <span class="warn-dot">!</span>
          还没选 API Key：去 <a href="#/apikeys" @click.prevent="$emit('navigate', 'apikeys')">「API Key 管理」</a>
          创建一个（绑「{{ activeAccount ? activeAccount.name : '当前激活' }}」账号），粘贴进来即可用于 WorkBuddy。
        </p>
      </div>
    </div>

    <div class="card">
      <div class="card-title-row">
        <div class="card-title">视觉理解（多模态输入）</div>
        <span class="card-meta">{{ visionModels.length ? visionModels.length + ' 个视觉模型' : '未检测到视觉模型' }}</span>
      </div>
      <div class="card-sub" style="margin-bottom: 12px">
        向 <code>POST /v1/responses</code> 发送 <code>input_image</code> 即可让支持视觉的模型看图；
        浏览器场景可传 base64 data URL，bridge 以当前激活账号的 OAuth 登录态透传 ChatGPT 多模态接口。
      </div>
      <div class="vision-models" v-if="visionModels.length">
        <span class="vision-chip" v-for="m in visionModels" :key="m.id" :title="m.id">
          <code>{{ m.id }}</code>
          <span class="vision">视觉</span>
        </span>
      </div>
      <div class="empty" v-else>上游模型列表中暂未识别到视觉模型；GPT-4/5/6 系列通常支持图像输入。</div>
      <pre class="code-block" style="margin-top: 12px">{{ visionExample }}</pre>
    </div>

    <div class="card">
      <div class="card-title">能力概览</div>
      <div class="caps" style="margin-top: 12px">
        <span class="cap" :class="{ on: caps.text }">文本 ✅</span>
        <span class="cap" :class="{ on: caps.image }">图片 ✅</span>
        <span class="cap" :class="{ on: caps.vision }">视觉 ✅</span>
      </div>
      <div class="card-sub" style="margin-top: 10px">
        能力由上游 ChatGPT / Codex 决定，通常为只读。
        <template v-if="imageModel">图片能力实际由 <code class="hl">{{ imageModel }}</code> + image_generation 工具提供。</template>
      </div>
    </div>

    <div class="card">
      <div class="card-title">OpenAI 兼容接口</div>
      <div class="card-sub" style="margin-bottom: 12px">gateway 对外暴露的端点（同服务根）</div>
      <div class="compats">
        <code v-for="c in compats" :key="c">{{ c }}</code>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grid { display: flex; flex-wrap: wrap; gap: 10px; }
.model-chip {
  display: inline-flex; align-items: center; gap: 8px;
  background: var(--card-2); border: 1px solid var(--border); border-radius: 9px;
  padding: 8px 11px; cursor: pointer; transition: all 0.12s ease;
  font: inherit; color: inherit;
}
.model-chip:hover { border-color: rgba(139,107,214, 0.4); }
.model-chip.selected { border-color: var(--emerald); background: var(--emerald-dim); }
.mid { font-family: var(--mono); font-size: 12.5px; color: var(--text); }
.tag { font-size: 11px; padding: 2px 8px; border-radius: 6px; }
.tag.image { background: var(--emerald-dim); color: var(--emerald-light); }
.tag.text { background: rgba(255, 255, 255, 0.06); color: var(--text-3); }
.vision { font-size: 10.5px; padding: 2px 6px; border-radius: 6px; background: rgba(96,165,250,0.14); color: #93c5fd; }
.tier { font-size: 10.5px; padding: 2px 7px; border-radius: 6px; background: rgba(255,255,255,0.06); color: var(--text-2); }
.core {
  font-size: 10.5px; font-weight: 600; padding: 2px 7px; border-radius: 6px;
  background: rgba(139,107,214,0.16); color: var(--emerald-light); border: 1px solid rgba(139,107,214,0.35);
}
.inline-core {
  font-size: 10.5px; font-weight: 600; padding: 1px 6px; border-radius: 5px;
  background: rgba(139,107,214,0.16); color: var(--emerald-light); border: 1px solid rgba(139,107,214,0.35);
}
.degraded {
  display: flex; align-items: flex-start; gap: 7px; font-size: 12px; color: var(--amber);
  background: rgba(251,191,36,0.08); border: 1px solid rgba(251,191,36,0.25);
  border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; line-height: 1.6;
}
.degraded .warn-dot {
  display: inline-block; width: 16px; height: 16px; line-height: 16px; text-align: center;
  border-radius: 50%; background: rgba(251,191,36,0.18); color: var(--amber); font-weight: 700; flex: none;
}
.empty { padding: 14px 4px; color: var(--text-3); font-size: 12.5px; }
.empty.err { color: var(--rose); }

/* 图片模型语义说明：本通道没有独立图片模型，占位名 ≠ 实际渲染模型 */
.image-note {
  margin-top: 14px; padding: 12px 14px; border-radius: 12px;
  background: var(--card-2); border: 1px solid var(--border);
}
.image-note-title {
  font-size: 12px; font-weight: 600; color: var(--text-2); margin-bottom: 7px;
  letter-spacing: 0.02em;
}
.image-note-body {
  font-size: 12.5px; line-height: 1.85; color: var(--text-3);
}
.image-note-body b { color: var(--text-2); }
.image-note-body code { font-family: var(--mono); font-size: 12px; }
.image-note-body code.hl {
  color: var(--emerald-light);
  background: var(--emerald-dim); padding: 1px 6px; border-radius: 5px;
}
code.hl {
  font-family: var(--mono); font-size: 12px;
  color: var(--emerald-light); background: var(--emerald-dim);
  padding: 1px 6px; border-radius: 5px;
}

.caps { display: flex; gap: 8px; }
.cap { font-size: 12px; padding: 5px 11px; border-radius: 8px; background: var(--card-2); color: var(--text-3); border: 1px solid var(--border); }
.cap.on { background: var(--emerald-dim); color: var(--emerald-light); border-color: transparent; }
.vision-models { display: flex; flex-wrap: wrap; gap: 8px; }
.vision-chip {
  display: inline-flex; align-items: center; gap: 7px;
  background: var(--card-2); border: 1px solid var(--border); border-radius: 9px; padding: 7px 10px;
}
.vision-chip code { font-family: var(--mono); font-size: 12px; color: var(--text); }
.vision-chip .vision { font-size: 10.5px; padding: 2px 6px; border-radius: 6px; background: rgba(96,165,250,0.14); color: #93c5fd; }
.compat { display: flex; flex-wrap: wrap; gap: 10px; }
.compats { display: flex; flex-wrap: wrap; gap: 10px; }
.compats code {
  font-family: var(--mono); font-size: 12px; background: var(--card-2);
  border: 1px solid var(--border); padding: 6px 10px; border-radius: 8px; color: var(--emerald-light);
}

/* 配置面板 */
.cfg { display: flex; flex-direction: column; gap: 12px; }
.cfg-row { display: flex; align-items: center; gap: 14px; }
.cfg-row .lbl { width: 90px; flex: none; font-size: 12.5px; color: var(--text-3); }
.cfg-row .val { flex: 1; font-size: 13px; color: var(--text); }
.cfg-input {
  flex: 1; background: var(--bg); border: 1px solid var(--border-strong);
  border-radius: 9px; padding: 9px 12px; color: var(--text); font-size: 13px; font-family: inherit;
  outline: none; transition: border-color 0.15s;
}
.cfg-input:focus { border-color: var(--emerald); }
.cfg-row > *, .key-area { min-width: 0; }
.cfg-input { max-width: 100%; }
@media (max-width: 680px) {
  .cfg-row { flex-direction: column; align-items: stretch; gap: 6px; }
  .cfg-row .lbl { width: auto; }
  .cfg-row .val { overflow-wrap: anywhere; }
  .key-area { flex-wrap: wrap; }
  .key-area .toggle { flex-basis: 100%; }
  .key-area .cfg-input { flex-basis: 100%; width: 100%; }
  .cfg-actions { flex-wrap: wrap; }
}
.readonly {
  border: 1px solid var(--border); border-radius: 9px; padding: 9px 12px;
  background: var(--bg); color: var(--text-2);
}
.key-area { display: flex; align-items: center; gap: 8px; flex: 1; }
.toggle {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--text-3); cursor: pointer;
}
.toggle input { accent-color: var(--emerald); }
.link { font-size: 12px; color: var(--emerald-light); text-decoration: none; padding: 0 6px; }
.link:hover { text-decoration: underline; }
.cfg-actions { display: flex; gap: 10px; margin-top: 4px; }
.btn-primary.sm {
  background: var(--emerald); color: var(--on-accent); border: none; border-radius: 8px;
  padding: 8px 14px; font-size: 12.5px; font-weight: 600; cursor: pointer;
}
.btn-primary.sm.alt { background: rgba(139,107,214,0.18); color: var(--emerald-light); border: 1px solid rgba(139,107,214,0.4); }
.btn-primary.sm:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-ghost.sm { padding: 6px 10px; font-size: 12px; background: var(--card-2); color: var(--text-2); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; }
.btn-ghost.sm:hover:not(:disabled) { color: var(--text); }
.code-block {
  font-family: var(--mono); font-size: 12px; background: var(--bg);
  border: 1px solid var(--border); border-radius: 10px; padding: 14px;
  color: var(--text-2); margin: 0; white-space: pre-wrap;
}
.hint { font-size: 12.5px; color: var(--text-3); margin: 0; display: flex; gap: 6px; align-items: flex-start; }
.hint a { color: var(--emerald-light); text-decoration: none; }
.hint a:hover { text-decoration: underline; }

/* WorkBuddy 添加模型对照说明 */
.wb-guide {
  margin-top: 12px; padding: 12px 14px; border-radius: 10px;
  border: 1px solid var(--border); background: rgba(59,130,246,0.06);
  font-size: 12.5px; line-height: 1.75; color: var(--text-2);
}
.wb-guide-title { font-weight: 600; color: var(--text); margin-bottom: 4px; }
.wb-guide code {
  font-family: var(--mono); font-size: 11.5px; padding: 1px 5px; border-radius: 5px;
  background: rgba(148,163,184,0.14); color: var(--text);
}
.wb-guide b { color: var(--text); font-weight: 600; }
.warn-dot { display: inline-block; width: 16px; height: 16px; line-height: 16px; text-align: center; border-radius: 50%; background: rgba(251,191,36,0.18); color: var(--amber); font-weight: 700; flex: none; }

.card-title-row { display: flex; align-items: center; gap: 12px; }
.card-meta { font-size: 11.5px; color: var(--text-3); margin-left: auto; }

</style>
