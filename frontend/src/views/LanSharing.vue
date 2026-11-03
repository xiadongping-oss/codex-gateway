<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import * as api from '../api/gateway'
import { gwRequest, copyText } from '../api/client'
import { isDesktopWorkspace } from '../desktopWorkspace'
import WorkspacePanel from '../components/WorkspacePanel.vue'
import { formatAccessConfig } from '../api/access-config'
import '../../../gateway/client-setup.js'
defineEmits(['navigate'])
const lan = ref(null), keys = ref([]), models = ref([]), selectedAddress = ref(''), keyId = ref(''), model = ref('')
const loading = ref(false), error = ref(''), feedback = ref(''), copyBusy = ref(false)
const saving = ref(false), portDraft = ref('4174'), portDirty = ref(false)
const strict = ref(null), strictBusy = ref(false), strictError = ref('')
async function loadStrict() {
  try { const result = await gwRequest('/__gw/strict-auth','GET',null,undefined,{strictJson:true}); if (!disposed) { strict.value = result; strictError.value = '' } }
  catch { if (!disposed) strictError.value = '鉴权设置读取失败，请刷新重试。' }
}
async function toggleStrict() {
  if (!strict.value || strictBusy.value) return
  strictBusy.value = true; strictError.value = ''
  try { const result = await gwRequest('/__gw/strict-auth','POST',{enabled:!strict.value.enabled},undefined,{strictJson:true}); if (!result?.ok) throw new Error('设置未能保存，请重试。'); if (!disposed) strict.value = result }
  catch (error) { if (!disposed) strictError.value = error.message || '设置未能保存，请重试。' }
  finally { if (!disposed) strictBusy.value = false }
}
let generation = 0, timer, feedbackTimer, disposed = false
const addresses = computed(() => lan.value?.addresses || [])
const endpoint = computed(() => selectedAddress.value && lan.value ? `http://${selectedAddress.value}:${lan.value.port}/v1` : '')
const available = computed(() => !!lan.value?.enabled && !!endpoint.value)
const validPort = computed(() => /^\d+$/.test(portDraft.value) && Number(portDraft.value) >= 1024 && Number(portDraft.value) <= 65535)
function applyLan(value, resetPort = false) {
  lan.value = value
  if (!portDirty.value || resetPort) { portDraft.value = String(value.port); portDirty.value = false }
  if (!addresses.value.some(a => a.address === selectedAddress.value)) selectedAddress.value = api.primaryLanAddress(addresses.value)?.address || ''
}
watch([keyId, model, selectedAddress], () => { feedback.value = '' }, { flush: 'sync' })
async function refresh() {
  if (loading.value || saving.value) return
  const seq = ++generation
  loading.value = true
  try {
    const [status, keyList, catalog] = await Promise.all([gwRequest('/__gw/status'), gwRequest('/__gw/apikeys'), gwRequest('/__gw/models')])
    if (seq !== generation) return
    if (!status?.lan || !Array.isArray(status.lan.addresses)) throw new Error('暂时无法读取共享状态。')
    applyLan(status.lan)
    keys.value = (keyList.keys || []).filter(k => !k.disabled)
    models.value = catalog.data || []
    if (!addresses.value.some(a => a.address === selectedAddress.value)) selectedAddress.value = api.primaryLanAddress(addresses.value)?.address || ''
    if (!keys.value.some(k => k.id === keyId.value)) keyId.value = keys.value[0]?.id || ''
    if (!models.value.some(m => m.id === model.value)) model.value = catalog.defaultModel || models.value[0]?.id || ''
    error.value = ''
  } catch (e) { if (seq === generation) error.value = e.message || '共享状态读取失败，请重试。' }
  finally { if (seq === generation) loading.value = false }
}
async function saveSharing(enabled) {
  const closing = lan.value?.enabled && !enabled
  if (saving.value || loading.value || (!closing && !validPort.value)) return
  saving.value = true; error.value = ''; feedback.value = ''
  try {
    const result = await gwRequest('/__gw/lan', 'POST', { enabled, port: closing ? lan.value.port : Number(portDraft.value) }, undefined, { strictJson: true })
    if (disposed) return
    if (!result.ok || !result.lan) throw new Error('未能确认共享状态，请刷新后重试。')
    applyLan(result.lan, true)
    feedback.value = enabled ? '共享已开启，设置已保存。可复制下方配置供其他设备接入。' : '共享已关闭，设置已保存。'
  } catch (e) { if (!disposed) error.value = e.detail || e.message || '共享设置保存失败，请重试。' }
  finally { if (!disposed) saving.value = false }
}
async function copyConfig() {
  if (!available.value || !keyId.value || !model.value || copyBusy.value) return
  const selection = [keyId.value, model.value, endpoint.value].join('|')
  copyBusy.value = true
  try {
    const key = await api.revealApiKey(keyId.value)
    if (disposed || !available.value || selection !== [keyId.value, model.value, endpoint.value].join('|')) return
    if (!key?.token) throw new Error('无法读取所选密钥，请重新选择。')
    await copyText(formatAccessConfig(endpoint.value,key.token,model.value))
    feedback.value = '接入配置已复制，包含所选 API Key。'
  } catch (e) { if (!disposed) feedback.value = e.message || '复制失败，请重试。' }
  finally { if (!disposed) { copyBusy.value = false; clearTimeout(feedbackTimer); feedbackTimer = setTimeout(() => { feedback.value = '' }, 5000) } }
}
async function copyRemotePrompt() {
  if (!available.value || !keyId.value || copyBusy.value) return
  const selection = [keyId.value,endpoint.value].join('|')
  copyBusy.value = true
  try {
    const key = await api.revealApiKey(keyId.value)
    if (disposed || !available.value || selection !== [keyId.value,endpoint.value].join('|')) return
    if (!key?.token) throw new Error('无法读取所选密钥，请重新选择。')
    const text = globalThis.CGWClientSetup.buildClientPrompt({base:new URL(endpoint.value).origin,target:'remote',key:key.token})
    await copyText(text)
    if (!disposed && selection === [keyId.value,endpoint.value].join('|')) feedback.value = '远程 MCP Prompt 已复制，包含主机共享地址及所选密钥。用户电脑无需安装网关。'
  } catch (e) { if (!disposed) feedback.value = e.message || '复制失败，请重试。' }
  finally { if (!disposed) copyBusy.value = false }
}
async function copySetupAddress() {
  if (!available.value) return
  const address = new URL('/setup',endpoint.value).href
  try { await copyText(address); if (!disposed) feedback.value = '共享接入页已复制，发给其他用户后由其输入自己的 API Key。' }
  catch { if (!disposed) feedback.value = '复制失败，请重试。' }
}
async function copyAddress() { try { await copyText(endpoint.value); feedback.value = '接口地址已复制。' } catch { feedback.value = '复制失败，请重试。' } }
onMounted(() => { refresh(); loadStrict(); timer = setInterval(() => { if (!document.hidden) refresh() }, 10000) })
onUnmounted(() => { disposed = true; generation++; clearInterval(timer); clearTimeout(feedbackTimer) })
</script>
<template>
  <div class="content sharing-page">
    <p v-if="error" class="sharing-notice" role="alert">{{ error }}</p>
    <WorkspacePanel title="共享状态" subtitle="让同一网络中的其他设备连接模型接口" :badge="!lan ? '等待连接' : lan.enabled ? '已开启' : lan.error ? '开启失败' : '仅本机访问'">
      <template #actions><button class="btn-ghost" :disabled="loading || saving" @click="refresh();loadStrict()">{{ loading ? '刷新中…' : '刷新状态' }}</button></template>
      <div class="sharing-summary"><div><span>共享监听地址</span><strong>{{ lan?.enabled ? lan.listenHost + ':' + lan.port : '未监听' }}</strong></div><div><span>可用网络地址</span><strong>{{ lan?.enabled ? addresses.length : '—' }}</strong></div><div><span>接入方式</span><strong>接口地址 + API Key</strong></div></div>
      <div v-if="lan?.manageable" class="sharing-control">
        <div class="sharing-control-top"><div class="sharing-control-copy"><h3><span class="sharing-dot" :class="{ enabled: lan.enabled }"></span>{{ lan.enabled ? '局域网共享已开启' : '局域网共享已关闭' }}</h3><p>{{ lan.enabled ? '其他设备可通过共享端口连接模型接口。关闭共享会断开这些连接。' : '开启后，同一网络中的设备可使用 API Key 接入模型服务。' }}</p></div><button :class="lan.enabled ? 'btn-ghost' : 'btn-primary'" :disabled="saving || loading || (!lan.enabled && !validPort)" @click="saveSharing(!lan.enabled)">{{ saving ? '应用中…' : lan.enabled ? '关闭共享' : '开启共享' }}</button></div>
        <div class="sharing-port-row"><label for="sharing-port">共享端口<input id="sharing-port" v-model="portDraft" inputmode="numeric" type="text" maxlength="5" :disabled="saving" :aria-invalid="!validPort" @input="portDirty = true" /></label><button v-if="portDirty" class="btn-ghost" :disabled="saving || loading || !validPort" @click="saveSharing(lan.enabled)">保存端口</button><p>设置会自动保留，下次启动继续生效。管理页面使用独立的本机端口。</p></div>
        <p v-if="!validPort" class="sharing-notice">请输入 1024–65535 之间的端口。</p>
        <p v-if="lan.error" class="sharing-notice" role="alert">{{ lan.error }} 网关的本机功能仍可正常使用。</p>
        <button v-if="lan.configuredEnabled && !lan.enabled" class="btn-ghost sharing-cancel" :disabled="saving || loading || !validPort" @click="saveSharing(false)">取消下次自动开启</button>
      </div>
      <div v-else-if="lan && !lan.enabled" class="sharing-empty"><h3>当前仅允许本机访问</h3><p>{{ isDesktopWorkspace() ? '共享管理尚未就绪，请更新桌面端后重试。' : '如需向局域网开放，请在项目目录使用下方命令重新启动网关。' }}</p><code v-if="!isDesktopWorkspace()">npm run start:lan</code></div>
    </WorkspacePanel>
    <WorkspacePanel title="接入鉴权" subtitle="使用网关 API Key 识别客户端、限制访问并记录用量" :badge="lan?.enabled ? '共享端口强制鉴权' : strict ? strict.enabled ? '本机鉴权已开启' : '本机鉴权已关闭' : '等待读取'">
      <div class="sharing-control-top"><div><h3>本机接口也要求 API Key</h3><p>建议开启，只有携带有效密钥的客户端才能调用本机模型接口。健康检查不受影响。</p></div><button :class="strict?.enabled ? 'btn-ghost' : 'btn-primary'" :disabled="!strict || strictBusy" @click="toggleStrict">{{ strictBusy ? '保存中…' : strict?.enabled ? '关闭本机鉴权' : '开启本机鉴权' }}</button></div>
      <p class="sharing-hint">局域网共享端口始终要求有效 API Key，不受此开关影响。账号与管理页面始终只对本机开放。</p>
      <p v-if="strictError" class="sharing-notice" role="alert">{{ strictError }}</p>
      <button class="btn-ghost" style="margin-top:12px" @click="$emit('navigate','apikeys')">管理 API Key</button>
    </WorkspacePanel>
    <WorkspacePanel v-if="lan?.enabled" title="客户端接入" subtitle="选择共享地址、密钥和模型，复制到 OpenAI 兼容客户端">
      <div v-if="!addresses.length" class="sharing-empty"><h3>暂无可用网络地址</h3><p>请检查网卡连接状态，再刷新列表。</p></div>
      <template v-else>
        <div class="sharing-fields"><label>接口地址<select v-model="selectedAddress"><option v-for="a in addresses" :key="a.address" :value="a.address">{{ a.address }} · {{ api.lanKindLabel(a) }}{{ a.preferred ? ' · 推荐' : '' }}</option></select></label><label>API Key<select v-model="keyId"><option value="" disabled>请选择密钥</option><option v-for="k in keys" :key="k.id" :value="k.id">{{ k.name || k.id }}</option></select></label><label>模型<select v-model="model"><option value="" disabled>请选择模型</option><option v-for="m in models" :key="m.id" :value="m.id">{{ m.label || m.id }}</option></select></label></div>
        <div class="sharing-address"><code>{{ endpoint }}</code><button class="btn-ghost" @click="copyAddress">复制地址</button></div>
        <p class="sharing-hint">远程 MCP 用户无需安装网关或 Node.js。复制下方 Prompt 交给对方 Agent，或发送共享接入页地址；不要发送 127.0.0.1 的本机地址。</p>
        <div class="sharing-actions"><button class="btn-primary" :disabled="!available || !keyId || copyBusy" @click="copyRemotePrompt">复制远程 MCP Prompt</button><button class="btn-ghost" :disabled="!available" @click="copySetupAddress">复制共享接入页</button><button class="btn-ghost" :disabled="!available || !keyId || !model || copyBusy" @click="copyConfig">{{ copyBusy ? '复制中…' : '复制接入配置' }}</button><button class="btn-ghost" @click="$emit('navigate','apikeys')">管理 API Key</button></div>
        <p v-if="!keys.length" class="sharing-hint">暂无可用密钥，请先创建 API Key。</p>
      </template>
    </WorkspacePanel>
    <p v-if="feedback" class="sharing-feedback" role="status">{{ feedback }}</p>
    <WorkspacePanel title="访问范围" subtitle="共享仅提供模型接口，管理功能保留在本机">
      <div class="sharing-rules"><div><h3>模型接口</h3><p>其他设备使用网关 API Key 访问 /v1 接口。</p></div><div><h3>管理页面</h3><p>账号、密钥与设置仅在本机管理。</p></div><div><h3>网络连接</h3><p>设备需位于可互通的网络，系统防火墙需允许网关端口。Tailscale 地址仅供同一网络内的设备使用。</p></div></div>
    </WorkspacePanel>
  </div>
</template>
<style scoped>
.sharing-summary { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; }
.sharing-summary>div { padding:16px; border:1px solid var(--border); border-radius:10px; background:var(--bg); min-width:0; }
.sharing-summary span { display:block; color:var(--text-3); font-size:12px; }
.sharing-summary strong { display:block; margin-top:8px; font-size:15px; font-weight:550; overflow-wrap:anywhere; }
.sharing-empty { margin-top:20px; padding:20px; border:1px solid var(--border); background:var(--bg); border-radius:12px; }
h3 { font-size:13px; font-weight:600; } p { font-size:12px; color:var(--text-2); line-height:1.7; margin-top:6px; }
.sharing-empty code { display:block; margin-top:16px; color:var(--primary); font-size:13px; }
.sharing-control { margin-top:20px; padding:20px; border:1px solid var(--border); background:var(--bg); border-radius:12px; }
.sharing-control-top { display:flex; align-items:center; justify-content:space-between; gap:24px; }
.sharing-control-top button { flex:none; white-space:nowrap; }
.sharing-control h3 { display:flex; align-items:center; gap:9px; }
.sharing-dot { width:8px; height:8px; background:var(--text-3); border-radius:50%; }.sharing-dot.enabled { background:var(--primary); box-shadow:0 0 0 4px var(--primary-soft); }
.sharing-port-row { display:flex; align-items:center; flex-wrap:wrap; gap:12px 16px; margin-top:20px; padding-top:18px; border-top:1px solid var(--border); }
.sharing-port-row label { display:flex; align-items:center; gap:12px; font-size:12px; color:var(--text-2); }
.sharing-port-row input { width:100px; padding:9px 12px; background:var(--card); border:1px solid var(--border-strong); border-radius:8px; color:var(--text); font:inherit; font-variant-numeric:tabular-nums; }
.sharing-port-row input:focus-visible { outline:2px solid var(--primary); outline-offset:2px; }
.sharing-port-row p { margin:0; flex:1; min-width:220px; }
.sharing-cancel { margin-top:12px; }
.sharing-fields { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; }
.sharing-fields label { display:flex; flex-direction:column; gap:8px; font-size:12px; color:var(--text-2); min-width:0; }
select { width:100%; padding:10px 12px; background:var(--bg); border:1px solid var(--border-strong); border-radius:8px; color:var(--text); font:inherit; }
select:focus-visible { outline:2px solid var(--primary); outline-offset:2px; }
.sharing-address { display:flex; align-items:center; gap:12px; margin:20px 0; padding:16px; background:var(--bg); border:1px solid var(--border); border-radius:10px; }
.sharing-address code { flex:1; min-width:0; overflow-wrap:anywhere; font-size:13px; }
.sharing-address button { flex:none; }
.sharing-actions { display:flex; gap:12px; flex-wrap:wrap; }.sharing-actions button { white-space:nowrap; }
.sharing-rules { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:24px; }
.sharing-notice { color:var(--rose); }.sharing-feedback { color:var(--primary); }.sharing-hint { color:var(--amber); }
@media(max-width:1000px) { .sharing-summary,.sharing-fields { grid-template-columns:minmax(0,1fr); } }
@media(max-width:760px) { .sharing-rules { grid-template-columns:minmax(0,1fr); gap:16px; }.sharing-address { flex-wrap:wrap; }.sharing-control-top { align-items:flex-start; flex-direction:column; gap:16px; } }
</style>
