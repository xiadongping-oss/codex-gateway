<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { gwRequest } from '../api/client'
import { isDesktopWorkspace } from '../desktopWorkspace'
import WorkspacePanel from '../components/WorkspacePanel.vue'
defineEmits(['navigate'])
const lan = ref(null)
const loading = ref(false), error = ref(''), feedback = ref('')
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
let generation = 0, timer, disposed = false
const addresses = computed(() => lan.value?.addresses || [])
const validPort = computed(() => /^\d+$/.test(portDraft.value) && Number(portDraft.value) >= 1024 && Number(portDraft.value) <= 65535)
function applyLan(value, resetPort = false) {
  lan.value = value
  if (!portDirty.value || resetPort) { portDraft.value = String(value.port); portDirty.value = false }
}
async function refresh() {
  if (loading.value || saving.value) return
  const seq = ++generation
  loading.value = true
  try {
    const status = await gwRequest('/__gw/status')
    if (seq !== generation) return
    if (!status?.lan || !Array.isArray(status.lan.addresses)) throw new Error('暂时无法读取共享状态。')
    applyLan(status.lan)
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
    feedback.value = enabled ? '共享已开启，设置已保存。请到「配置客户端」为其他设备配置接入。' : '共享已关闭，设置已保存。'
  } catch (e) { if (!disposed) error.value = e.detail || e.message || '共享设置保存失败，请重试。' }
  finally { if (!disposed) saving.value = false }
}
onMounted(() => { refresh(); loadStrict(); timer = setInterval(() => { if (!document.hidden) refresh() }, 10000) })
onUnmounted(() => { disposed = true; generation++; clearInterval(timer) })
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
    <WorkspacePanel title="连接其他设备" subtitle="在统一接入页选择其他设备，复制 Prompt、MCP 或模型配置">
      <button class="btn-primary" @click="$emit('navigate','access')">配置客户端 →</button>
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
.sharing-rules { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:24px; }
.sharing-notice { color:var(--rose); }.sharing-feedback { color:var(--primary); }.sharing-hint { color:var(--amber); }
@media(max-width:1000px) { .sharing-summary { grid-template-columns:minmax(0,1fr); } }
@media(max-width:760px) { .sharing-rules { grid-template-columns:minmax(0,1fr); gap:16px; }.sharing-control-top { align-items:flex-start; flex-direction:column; gap:16px; } }
</style>
