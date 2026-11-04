<script setup>
import { ref, onMounted } from 'vue'
import { gwRequest } from '../api/client'
import AccessConfig from '../components/AccessConfig.vue'
import WorkspacePanel from '../components/WorkspacePanel.vue'
defineEmits(['navigate'])
// ---- 出网代理 ----
// OpenAI 会按出口 IP 判定地区；地区不受支持时授权与 token 刷新都会 403。
// 注意：Node 的 fetch 不读系统代理环境变量，必须在这里显式配置才能生效。
const proxyLoaded = ref(false)
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
  try {
    const r = await gwRequest('/__gw/proxy', 'GET', null, undefined, { strictJson:true })
    proxyInput.value = r.configured || r.url || ''
    proxyEnabled.value = !!r.enabled; proxyAvailable.value = r.available !== false; proxyLoaded.value = true
  } catch { proxyMsg.value = { type:'err', text:'代理配置读取失败，请重新进入此页。' } }
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


onMounted(loadProxy)
</script>
<template>
  <div class="content settings-page">
    <AccessConfig @navigate="$emit('navigate',$event)" />
    <WorkspacePanel title="出网代理" subtitle="供登录授权和模型请求使用，与客户端接入地址无关" :badge="!proxyLoaded ? '读取中' : proxyEnabled ? '已启用' : '直连'">
      <label class="proxy-label" for="proxy-address">代理地址</label>
      <div class="proxy-row"><input id="proxy-address" v-model="proxyInput" placeholder="http://127.0.0.1:7897" spellcheck="false" :disabled="!proxyAvailable || !proxyLoaded || saving" @keyup.enter="saveProxy" /><button class="btn-primary" :disabled="saving || !proxyLoaded || !proxyAvailable" @click="saveProxy">{{ saving ? '应用中…' : '保存并应用' }}</button><button class="btn-ghost" :disabled="testing || !proxyLoaded || !proxyAvailable" @click="testProxyConn">{{ testing ? '测试中…' : '测试连接' }}</button></div>
      <div class="presets"><button v-for="preset in proxyPresets" :key="preset.url" class="preset" :disabled="!proxyAvailable || !proxyLoaded || saving" @click="proxyInput = preset.url">{{ preset.label }}</button><button class="preset" :disabled="detecting || !proxyAvailable || !proxyLoaded || saving" @click="detectProxy">{{ detecting ? '检测中…' : '检测系统代理' }}</button><button class="preset" :disabled="saving || !proxyLoaded" @click="proxyInput = ''">清空</button></div>
      <p class="setting-hint">填写代理软件的 HTTP／混合端口；留空直连。全局 VPN 或 Tailscale 出口已接管网络时，可留空。</p>
      <p v-if="!proxyAvailable" class="setting-feedback failed" role="alert">当前代理模块不可用，请重新安装完整桌面程序。</p>
      <p v-if="proxyMsg" class="setting-feedback" :class="{failed:proxyMsg.type==='err'}" role="status">{{ proxyMsg.text }}</p>
      <p v-if="testResult" class="setting-feedback" :class="{failed:!testResult.ok}" role="status">{{ testResult.text }}</p>
    </WorkspacePanel>
    <div class="settings-link"><div><strong>局域网共享与接入鉴权</strong><p>管理其他设备的接入地址，以及本机接口的 API Key 要求。</p></div><button class="btn-ghost" @click="$emit('navigate','lan')">前往管理 →</button></div>
  </div>
</template>
<style scoped>
.proxy-label{display:block;font-size:12px;color:var(--text-3);margin-bottom:7px}.proxy-row{display:flex;gap:10px}.proxy-row input{flex:1;min-width:0;padding:10px 12px;border:1px solid var(--border-strong);border-radius:8px;color:var(--text);background:var(--bg);font:12px var(--mono)}.proxy-row button{flex:none;white-space:nowrap}.presets{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}.preset{font-size:11px;padding:5px 9px;border:1px solid var(--border);border-radius:6px;color:var(--text-2);background:var(--bg);cursor:pointer}.preset:hover{border-color:var(--primary);color:var(--primary)}.setting-hint{font-size:12px;line-height:1.6;color:var(--text-3);margin-top:12px}.setting-feedback{margin-top:10px;color:var(--primary);font-size:12px}.setting-feedback.failed{color:var(--rose)}.settings-link{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 3px;font-size:12px}.settings-link strong{font-weight:550}.settings-link p{margin-top:4px;color:var(--text-3)}.settings-link button{flex:none}@media(max-width:760px){.proxy-row{flex-wrap:wrap}.proxy-row input{flex-basis:100%}.settings-link{flex-wrap:wrap}}
</style>
