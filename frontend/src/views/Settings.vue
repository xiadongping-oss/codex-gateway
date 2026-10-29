<script setup>
import { ref, onMounted } from 'vue'
import { BASE, gwRequest, copyText } from '../api/client'
import { loadAccessConfig, loadAccessConfigWithKey, formatAccessConfig } from '../api/access-config'
import { getStrictAuth, setStrictAuth, getLanInfo } from '../api/gateway'

const baseUrl = BASE
const copied = ref(false)
const copyErr = ref('')

// ---- 局域网接入（摘要行；完整地址列表 / 接入三项 / 安全边界在「模型能力」页） ----
const lan = ref({ enabled: false, addresses: [], port: 4173 })
const lanCopied = ref('')
async function loadLan() {
  lan.value = await getLanInfo().catch(() => lan.value)
}
async function copyLanAddr(a) {
  copyErr.value = ''
  try {
    await copyText(`http://${a.address}:${lan.value.port}/v1`)
    lanCopied.value = a.address
    setTimeout(() => (lanCopied.value = ''), 1500)
  } catch (e) {
    copyErr.value = e?.message || '复制失败'
    setTimeout(() => (copyErr.value = ''), 3000)
  }
}

// ---- 严格鉴权 ----
const strict = ref(false)
const strictSaving = ref(false)
const strictMsg = ref(null)

async function loadStrict() {
  strict.value = await getStrictAuth()
}
async function toggleStrict() {
  strictSaving.value = true
  strictMsg.value = null
  try {
    const target = !strict.value
    const r = await setStrictAuth(target)
    if (r && r.ok) {
      strict.value = r.enabled
      strictMsg.value = { type: 'ok', text: r.enabled ? '已开启：/v1 现在要求有效 cgw- API Key' : '已关闭：未带 key 的 /v1 请求放行' }
    } else {
      strictMsg.value = { type: 'err', text: (r && (r.detail || r.error)) || '切换失败，请重试' }
    }
  } catch (e) {
    strictMsg.value = { type: 'err', text: '切换失败：' + (e?.message || e) }
  } finally {
    // 无论成功失败都必须复位，否则按钮永久卡在「切换中…」
    strictSaving.value = false
  }
}

// ---- 出网代理 ----
// OpenAI 会按出口 IP 判定地区；地区不受支持时授权与 token 刷新都会 403。
// 注意：Node 的 fetch 不读系统代理环境变量，必须在这里显式配置才能生效。
const proxyInput = ref('')
const proxyEnabled = ref(false)
const proxyAvailable = ref(true)
const saving = ref(false)
const testing = ref(false)
const proxyMsg = ref(null)
const testResult = ref(null)

// 常见代理端口快速填充（企业内网 / 本机 Clash 场景，免得每次手敲）
const proxyPresets = [
  { label: 'Clash Verge · 7897', url: 'http://127.0.0.1:7897' },
  { label: 'Clash for Windows · 7890', url: 'http://127.0.0.1:7890' }
]

async function loadProxy() {
  const r = await gwRequest('/__gw/proxy', 'GET', null, () => ({
    url: '', enabled: false, available: true, configured: ''
  }))
  if (!r) return
  proxyInput.value = r.configured || r.url || ''
  proxyEnabled.value = !!r.enabled
  proxyAvailable.value = r.available !== false
}

async function saveProxy() {
  saving.value = true
  proxyMsg.value = null
  try {
    const val = proxyInput.value.trim()
    const r = await gwRequest('/__gw/proxy', 'POST', { proxy: val }, () => ({
      ok: false, detail: '无法连接网关控制接口，未能保存'
    }))
    if (!r || !r.ok) {
      proxyMsg.value = { type: 'err', text: (r && (r.detail || r.error)) || '保存失败' }
      return
    }
    proxyEnabled.value = r.enabled
    proxyMsg.value = { type: 'ok', text: r.enabled ? `已启用：${r.url}` : '已关闭，当前直连' }
  } catch (e) {
    proxyMsg.value = { type: 'err', text: '保存失败：' + (e?.message || e) }
  } finally {
    saving.value = false
  }
}

async function testProxyConn() {
  testing.value = true
  testResult.value = null
  try {
    const r = await gwRequest(
      '/__gw/proxy/test', 'POST', { proxy: proxyInput.value.trim() },
      () => ({ ok: false, error: '无法连接网关控制接口' })
    )
    if (!r) {
      testResult.value = { ok: false, text: '无法连接网关控制接口' }
      return
    }
    testResult.value = r.ok
      ? { ok: true, text: `出口可用 · ${r.status} · ${r.ms}ms · 经 ${r.via}` }
      : { ok: false, text: r.error || '测试失败' }
  } catch (e) {
    testResult.value = { ok: false, text: '测试失败：' + (e?.message || e) }
  } finally {
    testing.value = false
  }
}

// 自动检测系统代理（环境变量 + Windows 注册表）：只填充输入框，是否应用由用户决定
const detecting = ref(false)
async function detectProxy() {
  detecting.value = true
  proxyMsg.value = null
  try {
    const r = await gwRequest('/__gw/proxy/detect', 'POST', null, () => null)
    const primary = r && r.primary
    if (primary) {
      proxyInput.value = primary
      proxyMsg.value = {
        type: 'ok',
        text: `检测到系统代理 ${primary}（${r.candidates[0]?.source === 'env' ? '来自环境变量' : '来自 Windows 系统代理'}），已填入。点「保存并应用」生效。`
      }
    } else {
      proxyMsg.value = { type: 'err', text: '未检测到系统代理或环境变量代理。若代理软件开着，可手动填写其混合端口。' }
    }
  } catch (e) {
    proxyMsg.value = { type: 'err', text: '检测失败：' + (e?.message || e) }
  } finally {
    detecting.value = false
  }
}

onMounted(() => {
  loadProxy()
  loadStrict()
  loadLan()
  refreshAccessCfg()
  loadAccessConfig().then((c) => {
    accessBase.value = c.baseUrl
    accessKey.value = c.apiKey
    refreshAccessCfg()
  })
})

// ---- 接入配置 ----
// /v1 有 Bearer 就严格校验（非 cgw- key 一律 401），所以不能写 unused；
// 不带 Authorization 才放行。此处展示首个可用 key 的明文（仅本机 UI 可见）。
const accessBase = ref('')
const accessKey = ref(null)
const accessCfgText = ref('载入中…')
function refreshAccessCfg() {
  accessCfgText.value = formatAccessConfig(
    accessBase.value || (BASE ? BASE + '/v1' : window.location.origin + '/v1'),
    accessKey.value
  )
}
// 复制时才去取明文：列表轮询不再携带密钥
async function copyConfig() {
  copyErr.value = ''
  try {
    const cfg = await loadAccessConfigWithKey()
    accessBase.value = cfg.baseUrl
    accessKey.value = cfg.apiKey
    refreshAccessCfg()
    await copyText(accessCfgText.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch (e) {
    copyErr.value = e?.message || '复制失败'
  }
}
</script>

<template>
  <div class="content">
    <!-- 接入配置：最高频动作，顶置 -->
    <div class="card">
      <div class="card-title">
        接入配置
        <span class="badge" :class="lan.enabled ? 'on' : 'off'">{{ lan.enabled ? '局域网已开启' : '仅本机' }}</span>
      </div>
      <div class="card-sub" style="margin-bottom: 12px">
        把下方配置填到任意 OpenAI 兼容客户端（WorkBuddy / Codex CLI / Claude Code / n8n 等）即可调用本网关。
      </div>
      <button class="btn-primary" @click="copyConfig">{{ copied ? '已复制 ✓' : '复制接入配置' }}</button>
      <pre class="code">{{ accessCfgText }}</pre>
      <div v-if="copyErr" class="msg err" style="margin-top: 10px">{{ copyErr }}</div>
      <div class="card-sub hint" style="margin-top: 10px">
        <template v-if="accessKey">API Key 即「API Key」页创建的 cgw- 密钥（仅本机可见）。严格鉴权开启后，客户端必须携带此 Key。</template>
        <template v-else>尚未创建 API Key：请到「API Key」页创建后填入客户端；严格鉴权开启时，无 Key 的调用会被 401 拒绝。</template>
      </div>

      <!-- 局域网已开启：把其他主机要用的地址直接给出，免得再去翻「模型能力」页 -->
      <div v-if="lan.enabled" class="lan-line">
        <div class="lan-line-title">局域网接入已开启 · 其他主机把地址换成本机局域网地址即可：</div>
        <div v-for="a in lan.addresses" :key="a.address" class="lan-line-row">
          <code>http://{{ a.address }}:{{ lan.port }}/v1</code>
          <span class="lan-iface">{{ a.name }}</span>
          <button class="btn-ghost sm" @click="copyLanAddr(a)">
            {{ lanCopied === a.address ? '✓ 已复制' : '复制' }}
          </button>
        </div>
        <div class="card-sub" style="margin-top: 8px">
          安全边界：控制面 /__gw/* 仅本机可访问；/v1/* 强制 cgw- Key 鉴权。完整说明见「模型能力」页的「局域网接入」。
        </div>
      </div>
      <div v-else class="card-sub hint" style="margin-top: 10px">
        当前仅本机可访问。想让局域网内其他电脑接入（如另一台机器上的 WorkBuddy），用 <code>GW_LAN=1</code> 启动网关——见「模型能力」页的「局域网接入」。
      </div>
    </div>

    <div class="card">
      <div class="card-title">
        出网代理
        <span class="badge" :class="proxyEnabled ? 'on' : 'off'">{{ proxyEnabled ? '已启用' : '直连' }}</span>
      </div>
      <div class="card-sub" style="margin-bottom: 12px">
        OpenAI 按出口 IP 判定地区。若授权时报「地区不受支持」，在此填写本地代理端口。
      </div>

      <input
        v-model="proxyInput"
        class="proxy-input mono"
        placeholder="http://127.0.0.1:7897"
        spellcheck="false"
        :disabled="!proxyAvailable"
        @keyup.enter="saveProxy"
      />

      <div class="presets">
        <span class="presets-lbl">快速填充：</span>
        <button
          v-for="p in proxyPresets"
          :key="p.url"
          class="preset"
          :disabled="!proxyAvailable"
          @click="proxyInput = p.url"
        >{{ p.label }}</button>
        <button class="preset" :disabled="!proxyAvailable || detecting" @click="detectProxy">
          {{ detecting ? '检测中…' : '自动检测系统代理' }}
        </button>
      </div>

      <div class="btn-row">
        <button class="btn-primary" :disabled="saving" @click="saveProxy">
          {{ saving ? '应用中…' : '保存并应用' }}
        </button>
        <button class="btn-ghost" :disabled="testing" @click="testProxyConn">
          {{ testing ? '测试中…' : '测试连通性' }}
        </button>
        <button class="btn-ghost" @click="proxyInput = ''">清空</button>
      </div>

      <div v-if="proxyMsg" class="msg" :class="proxyMsg.type">{{ proxyMsg.text }}</div>
      <div v-if="testResult" class="msg" :class="testResult.ok ? 'ok' : 'err'">
        <span class="mark">{{ testResult.ok ? '✓' : '✕' }}</span>{{ testResult.text }}
      </div>
      <div v-if="!proxyAvailable" class="msg warn">
        代理模块不可用（缺少 undici）。在 <code>gateway/</code> 执行 <code>npm i undici</code> 后重启网关。
      </div>

      <div class="card-sub hint">
        <b>为什么必须在这里配：</b>Node 的 fetch 不读取系统代理环境变量，与浏览器行为不同。<br />
        <b>用 Tailscale exit node 的话：</b>流量已在网卡层转发、对应用透明，此处<b>留空</b>即可。<br />
        常见端口：Clash Verge 默认 <code>7897</code>，Clash for Windows 默认 <code>7890</code>（填「混合端口」）。
        调整代理后调用异常？去「调用日志」页看看，或重启网关。
      </div>
    </div>

    <div class="card">
      <div class="card-title">
        严格鉴权
        <span class="badge" :class="strict ? 'on' : 'off'">{{ strict ? '已开启' : '已关闭' }}</span>
      </div>
      <div class="card-sub" style="margin-bottom: 12px">
        开启后：所有 <code>/v1</code> 调用（含模型列表）必须携带有效的 cgw- API Key，否则返回 401。
        未带 key 或 key 被删/禁用都会被拒。<code>/health</code> 不受影响。
      </div>
      <div class="btn-row">
        <button class="btn-primary" :disabled="strictSaving" @click="toggleStrict">
          {{ strictSaving ? '切换中…' : strict ? '关闭严格鉴权' : '开启严格鉴权' }}
        </button>
      </div>
      <div v-if="strictMsg" class="msg" :class="strictMsg.type">{{ strictMsg.text }}</div>
      <div class="card-sub hint">
        <b>建议开启：</b>配合「接入配置」里的 cgw- Key 使用，调用会计入按 key 的用量统计并自动绑定账号；
        关闭时未带 key 的请求虽放行，但不进统计。局域网开启时强烈建议保持开启。
      </div>
    </div>
  </div>
</template>

<style scoped>
.code {
  font-family: var(--mono); font-size: 12.5px; background: var(--bg);
  border: 1px solid var(--border); border-radius: 10px; padding: 14px;
  color: var(--text-2); margin-top: 12px; white-space: pre-wrap;
}

/* ---- 状态徽标 ---- */
.badge {
  display: inline-block; margin-left: 8px; padding: 1px 8px;
  border-radius: 999px; font-size: 10.5px; font-weight: 600; letter-spacing: 0.02em;
}
.badge.on  { background: var(--emerald-dim); color: var(--emerald-light); border: 1px solid rgba(16,185,129,0.28); }
.badge.off { background: rgba(255,255,255,0.05); color: var(--text-3); border: 1px solid var(--border); }

/* ---- 局域网地址行 ---- */
.lan-line {
  margin-top: 14px; padding: 12px 14px; border-radius: 10px;
  background: var(--bg); border: 1px dashed rgba(16,185,129,0.35);
}
.lan-line-title { font-size: 12.5px; color: var(--text-2); margin-bottom: 6px; }
.lan-line-row { display: flex; align-items: center; gap: 10px; padding: 3px 0; }
.lan-line-row code {
  flex: 1; min-width: 0; font-family: var(--mono); font-size: 12px; color: var(--emerald-light);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.lan-iface { font-size: 11px; color: var(--text-3); flex: none; }
.btn-ghost.sm { padding: 5px 10px; font-size: 11.5px; }

/* ---- 代理快速填充 ---- */
.presets { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.presets-lbl { font-size: 11.5px; color: var(--text-3); }
.preset {
  font-family: var(--mono); font-size: 11.5px; color: var(--text-2);
  background: var(--bg); border: 1px solid var(--border-strong); border-radius: 7px;
  padding: 4px 10px; cursor: pointer; transition: all 0.15s;
}
.preset:hover:not(:disabled) { color: var(--emerald-light); border-color: rgba(16,185,129,0.4); }
.preset:disabled { opacity: 0.5; cursor: not-allowed; }

.proxy-input {
  width: 100%; background: var(--bg); border: 1px solid var(--border-strong);
  border-radius: 9px; padding: 9px 12px; color: var(--text); font-size: 12.5px;
  outline: none; transition: border-color 0.15s;
}
.proxy-input:focus { border-color: var(--emerald); }
.proxy-input:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-row { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; }

.msg {
  margin-top: 10px; font-size: 12px; padding: 8px 11px;
  border-radius: 8px; border: 1px solid;
}
.msg.ok   { background: var(--emerald-dim); border-color: rgba(16,185,129,0.26); color: var(--emerald-light); }
.msg.err  { background: rgba(244,63,94,0.10); border-color: rgba(244,63,94,0.26); color: #fda4af; }
.msg.warn { background: rgba(251,191,36,0.09); border-color: rgba(251,191,36,0.24); color: var(--amber); }
.msg .mark { margin-right: 6px; font-weight: 700; }

.hint { margin-top: 14px; line-height: 1.75; }
.hint b { color: var(--text-2); font-weight: 600; }
.msg code, .hint code {
  font-family: var(--mono); background: rgba(255,255,255,0.06);
  padding: 1px 5px; border-radius: 4px; font-size: 11px;
}
</style>
