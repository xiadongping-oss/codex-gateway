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
    feedback.value = enabled ? '共享已开启。' : '共享已关闭。'
  } catch (e) { if (!disposed) error.value = e.detail || e.message || '共享设置保存失败，请重试。' }
  finally { if (!disposed) saving.value = false }
}
onMounted(() => { refresh(); loadStrict(); timer = setInterval(() => { if (!document.hidden) refresh() }, 10000) })
onUnmounted(() => { disposed = true; generation++; clearInterval(timer) })
</script>
<template>
  <div class="content sharing-page">
    <p v-if="error" class="sharing-notice" role="alert">{{ error }}</p>
    <WorkspacePanel title="共享状态" subtitle="局域网设备通过共享端口访问模型接口。关闭共享会断开已有连接。" :badge="!lan ? '读取中' : lan.enabled ? '已开启' : lan.error ? '开启失败' : '已关闭'">
      <template #actions>
        <button class="btn-ghost" :disabled="loading || saving" @click="refresh();loadStrict()">{{ loading ? '刷新中…' : '刷新状态' }}</button>
        <button class="sharing-toggle" :class="{on:lan?.enabled}" role="switch" :aria-checked="!!lan?.enabled" :aria-label="lan?.enabled ? '关闭局域网共享' : '开启局域网共享'" :disabled="!lan?.manageable || saving || loading || (!lan?.enabled && !validPort)" @click="saveSharing(!lan.enabled)"><span /></button>
      </template>
      <div class="sharing-summary">
        <div class="sharing-tile"><span>共享监听地址</span><strong class="mono">{{ lan?.enabled ? lan.listenHost + ':' + lan.port : '未监听' }}</strong></div>
        <div class="sharing-tile" :title="addresses.map(a=>a.address).join(', ')"><span>可用网络地址</span><strong>{{ lan?.enabled ? addresses.length : '—' }}</strong></div>
        <div class="sharing-tile"><span>接入方式</span><strong>接口地址 + API Key</strong></div>
        <div class="sharing-tile port-tile">
          <label for="sharing-port">共享端口</label>
          <div class="port-controls"><input id="sharing-port" v-model="portDraft" inputmode="numeric" maxlength="5" :disabled="saving || !lan?.manageable" :aria-invalid="!validPort" @input="portDirty=true" @keyup.enter="portDirty && validPort && saveSharing(lan.enabled)" /><button v-if="portDirty" class="btn-ghost" :disabled="saving || loading || !validPort" @click="saveSharing(lan.enabled)">保存</button></div>
        </div>
      </div>
      <p v-if="!validPort" class="sharing-notice" role="alert">端口范围为 1024–65535。</p>
      <p v-if="lan?.error" class="sharing-notice" role="alert">{{ lan.error }}</p>
      <button v-if="lan?.configuredEnabled && !lan.enabled" class="btn-ghost sharing-cancel" :disabled="saving || loading || !validPort" @click="saveSharing(false)">取消下次自动开启</button>
      <p v-if="lan && !lan.manageable && !lan.enabled" class="sharing-hint">{{ isDesktopWorkspace() ? '共享管理暂不可用。' : '命令行启动共享：npm run start:lan' }}</p>
    </WorkspacePanel>
    <WorkspacePanel title="接入与访问" subtitle="局域网端口强制使用 API Key。本机模型接口可单独设置鉴权要求。">
      <template #actions><button class="btn-ghost" data-workspace-page="apikeys" @click="$emit('navigate','apikeys')">管理 API Key</button></template>
      <div class="access-grid">
        <section class="access-tile">
          <div class="access-tile-head"><h3>本机鉴权</h3><button class="sharing-toggle" :class="{on:strict?.enabled}" role="switch" :aria-checked="!!strict?.enabled" :aria-label="strict?.enabled ? '关闭本机鉴权' : '开启本机鉴权'" :disabled="!strict || strictBusy" @click="toggleStrict"><span /></button></div>
          <strong>{{ !strict ? '读取中' : strict.enabled ? '需 API Key' : '免 API Key' }}</strong>
          <p>本机模型接口</p>
        </section>
        <section class="access-tile"><h3>局域网鉴权</h3><strong>需 API Key</strong><p>共享端口始终启用</p></section>
        <section class="access-tile"><h3>管理页面</h3><strong>仅本机</strong><p>账号、密钥与设置</p></section>
        <section class="access-tile" title="设备需位于可互通的网络，防火墙需放行共享端口。Tailscale 地址仅供同一网络内的设备使用。"><h3>网络范围 ⓘ</h3><strong>局域网 / Tailscale</strong><p>共享端口需允许入站</p></section>
      </div>
      <p v-if="strictError" class="sharing-notice" role="alert">{{ strictError }}</p>
    </WorkspacePanel>
    <p v-if="feedback" class="sharing-feedback" role="status">{{ feedback }}</p>
  </div>
</template>
<style scoped>
.sharing-summary,.access-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; }
.sharing-tile,.access-tile { min-width:0; padding:18px; border:1px solid var(--border); border-radius:10px; background:var(--bg); }
.sharing-tile { display:flex; flex-direction:column; gap:12px; justify-content:space-between; min-height:108px; }
.sharing-tile>span,.sharing-tile>label { color:var(--text-3); font-size:12px; }
.sharing-tile strong,.access-tile>strong { color:var(--text); font-size:15px; font-weight:550; overflow-wrap:anywhere; }
.port-controls { display:flex; align-items:center; gap:8px; min-height:24px; }
.port-controls input { width:80px; min-width:0; max-width:100%; padding:3px 0; border:0; border-bottom:1px solid var(--border-strong); background:transparent; color:var(--text); font:550 15px var(--mono); }
.port-controls button { padding:3px 7px; font-size:11px; }
.sharing-toggle { display:inline-flex; align-items:center; flex:none; width:36px; height:22px; padding:3px; border:0; border-radius:20px; background:var(--border-strong); cursor:pointer; }
.sharing-toggle span { width:16px; height:16px; border-radius:50%; background:white; box-shadow:0 1px 3px #0002; transition:transform .15s; }
.sharing-toggle.on { background:var(--primary); }
.sharing-toggle.on span { transform:translateX(14px); }
.sharing-toggle:disabled { opacity:.45; cursor:wait; }
.access-tile-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:14px; }
.access-tile h3 { font-size:12px; color:var(--text-3); font-weight:500; margin:0 0 18px; }
.access-tile-head h3 { margin:0; }
.access-tile p { margin:8px 0 0; font-size:11px; color:var(--text-3); line-height:1.6; }
.sharing-notice { color:var(--rose); font-size:12px; margin-top:12px; }
.sharing-feedback,.sharing-hint { font-size:12px; color:var(--text-3); }
.sharing-cancel { margin-top:12px; }
@media(max-width:1100px) { .sharing-summary,.access-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media(max-width:520px) { .sharing-summary,.access-grid { grid-template-columns:1fr; } }
</style>
