<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import WorkspacePanel from '../components/WorkspacePanel.vue'
import { BASE, gwRequest, copyText } from '../api/client'
import * as api from '../api/gateway'
import { formatAccessConfig } from '../api/access-config'
import { vModalFocus } from '../composables/modalFocus'
import '../../../gateway/client-setup.js'

const emit = defineEmits(['navigate'])
const props = defineProps({ initialModel: { type:String, default:'' } })
const keys=ref([]), models=ref([]), lan=ref(null), keyId=ref(''), model=ref(props.initialModel), base=ref(''), device=ref('')
const manual = ref(false), manualKey = ref('')
const manualDialog = ref(false), keyDraft = ref('')
function openManual() { keyDraft.value = manualKey.value; manualDialog.value = true }
function closeManual() { manualDialog.value = false; keyDraft.value = '' }
function applyManual() { manualKey.value = keyDraft.value.trim(); manual.value = !!manualKey.value; closeManual() }
function clearManual() { manual.value = false; manualKey.value = ''; closeManual() }
const hasKey = computed(() => manual.value ? !!manualKey.value.trim() : !!keyId.value)
const target=ref('local')
const manifest=ref(null), loading=ref(true), busy=ref(false), error=ref(''), feedback=ref(''), mode=ref('install')
let disposed=false, revision=0
const localBase=(BASE || window.location.origin).replace(/\/$/,'')
const connections=computed(()=>target.value==='local' ? [{url:localBase,label:'网关本机 · '+localBase}] : target.value==='remote' && lan.value?.enabled ? (lan.value.addresses || []).map(a=>({url:`http://${a.address.includes(':') ? '['+a.address+']' : a.address}:${lan.value.port}`,label:`共享主机 · ${a.address}:${lan.value.port}`,preferred:a.preferred})) : [])
watch(connections,items=>{if(!items.some(c=>c.url===base.value))base.value=items.find(c=>c.preferred)?.url || items[0]?.url || ''},{flush:'sync',immediate:true})
const prompt=computed(()=>base.value ? globalThis.CGWClientSetup.buildClientPrompt({base:base.value,target:target.value,key:'<复制时填入所选 API Key>',device:device.value,update:mode.value==='update',switchKey:mode.value==='switch-key'}) : '')
watch([base,keyId,device,model,mode,target,manual,manualKey],()=>{revision++;feedback.value=''}, {flush:'sync'})
async function load() {
  loading.value=true;error.value=''
  try {
    const [keyList,catalog,status,assets]=await Promise.all([api.listApiKeys(),api.getModels(),gwRequest('/__gw/status'),fetch(localBase+'/client-assets.json',{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('更新清单读取失败');return r.json()})])
    if(disposed)return
    keys.value=(keyList || []).filter(k=>!k.disabled);models.value=catalog || [];lan.value=status.lan;manifest.value=assets
    if(!connections.value.some(c=>c.url===base.value))base.value=connections.value.find(c=>c.preferred)?.url || connections.value[0]?.url || ''
    if(!keys.value.some(k=>k.id===keyId.value))keyId.value=keys.value[0]?.id || ''
    if(!models.value.some(m=>m.id===model.value))model.value=models.value.find(m=>m.kind!=='image')?.id || ''
  } catch(e) {if(!disposed)error.value=e.message || '接入信息读取失败，请重试。'}
  finally {if(!disposed)loading.value=false}
}
async function copy(kind) {
  const updatePrompt = kind==='prompt' && mode.value==='update'
  if(busy.value || (!hasKey.value && !updatePrompt) || !manifest.value)return
  if(!target.value || !base.value){error.value='请先选择 Agent 所在电脑及可用的连接地址。';return}
  const selected=revision
  busy.value=true;feedback.value='';error.value=''
  try {
    const token=updatePrompt ? undefined : manual.value ? manualKey.value.trim() : (await api.revealApiKey(keyId.value))?.token
    if(disposed || selected!==revision)return
    if(!updatePrompt && !token)throw new Error('未能读取密钥，请重新选择。')
    let text
    if(kind==='prompt')text=globalThis.CGWClientSetup.buildClientPrompt({base:base.value,target:target.value,key:token,device:device.value,update:mode.value==='update',switchKey:mode.value==='switch-key'})
    else if(kind==='model')text=formatAccessConfig(base.value+'/v1',token,model.value)
    else if(kind==='json')text=JSON.stringify({baseUrl:base.value+'/v1',apiKey:token,model:model.value},null,2)
    else text=JSON.stringify(globalThis.CGWClientSetup.buildMcpConfig({base:base.value,target:target.value,key:token,device:device.value}),null,2)
    await copyText(text)
    if(!disposed && selected===revision)feedback.value=updatePrompt ? '已复制更新 Prompt，不包含 API Key；保留目标客户端原凭据。' : mode.value==='switch-key' && kind==='prompt' ? '已复制更换 Key Prompt，包含所选新 Key；请仅发给对应用户。' : '已复制，包含所选 API Key。请粘贴到目标客户端的私有配置或对话。'
  } catch(e) {if(!disposed && selected===revision)error.value=e.message || '复制失败，请重试。'}
  finally {if(!disposed)busy.value=false}
}
async function copySetup() {
  if(!target.value || !base.value)return
  const selected=revision,remote=target.value==='remote'
  try {await copyText(base.value+'/setup');if(!disposed && selected===revision)feedback.value=remote?'共享接入页地址已复制。其他设备打开后使用自己的 API Key，无需安装网关。':'本机接入页地址已复制，仅限网关这台电脑使用；不要转发给其他设备。'}
  catch {if(!disposed)error.value='地址复制失败。'}
}
onMounted(load)
onUnmounted(()=>{disposed=true;revision++})
</script>

<template>
  <div class="content access-page">
    <div v-if="error" class="notice error" role="alert">{{error}} <button class="btn-ghost" :disabled="loading" @click="load">重试</button></div>
    <WorkspacePanel title="连接位置" subtitle="本机和局域网共用一套接入方式；每位用户建议单独创建 API Key">
      <template #actions><button class="btn-ghost" :class="{'manual-active':manual}" :disabled="busy" @click="openManual">{{ manual ? '已填写 API Key' : '手动填写 API Key' }}</button><button class="btn-ghost" @click="emit('navigate','lan')">管理共享</button><button class="btn-ghost" @click="emit('navigate','apikeys')">管理密钥</button></template>
      <template #title-extra><div class="mode target-picker" role="radiogroup" aria-label="客户端位置">
        <label class="target-option" :class="{selected:target==='local'}"><input type="radio" name="client-target" v-model="target" value="local" :disabled="busy" /><span>本机</span></label>
        <label class="target-option" :class="{selected:target==='remote'}"><input type="radio" name="client-target" v-model="target" value="remote" :disabled="busy" /><span>局域网用户</span></label>
      </div></template>
      <p v-if="target==='remote' && !lan?.enabled" class="connection-note">请先在「局域网共享」开启局域网共享。</p>
      <div class="fields">
        <label>连接地址<select v-model="base" :disabled="loading || busy"><option v-if="!connections.length" value="">{{target==='remote'?'请先开启共享':'请先选择 Agent 所在电脑'}}</option><option v-for="c in connections" :key="c.url" :value="c.url">{{c.label}}</option></select></label>
        <label>API Key<input v-if="manual" type="text" value="已使用手动填写的 API Key" readonly /><select v-else v-model="keyId" :disabled="loading || busy"><option value="">请选择密钥</option><option v-for="k in keys" :key="k.id" :value="k.id">{{k.name}} · {{k.mask}}</option></select></label>
        <label>设备名称（可选）<input v-model="device" maxlength="80" :disabled="busy" placeholder="例如：设计工作站" /></label>
      </div>
      <div class="actions"><button class="btn-primary" :disabled="!base" @click="copySetup">复制网页接入地址</button></div>
    </WorkspacePanel>

    <WorkspacePanel title="Agent 配置" subtitle="复制 Prompt 到目标 Agent，由它安装 Skill、合并 MCP 配置并检查连接">
      <template #title-extra><div class="mode" role="group" aria-label="配置方式"><button :class="{active:mode==='install'}" @click="mode='install'">首次配置</button><button :class="{active:mode==='update'}" @click="mode='update'">更新 Skill / MCP</button><button :class="{active:mode==='switch-key'}" @click="mode='switch-key'">更换 API Key</button></div></template>

      <p class="connection-note" v-if="mode==='update'">更新 Prompt 不包含上方所选 Key，始终保留目标客户端原有凭据，可发给连接同一网关的不同用户。</p>
      <p class="connection-note" v-else-if="mode==='switch-key'">请在上方选择该用户的新 Key。换 Key 会切换个人图库，旧图片不会自动迁移；客户端需要重新加载连接。</p>
      <p class="connection-note" v-else>首次配置使用上方所选 Key；请为每位用户分别选择自己的 Key，不要共用接入 Prompt。</p>
      <textarea class="preview" :value="prompt" readonly rows="7" placeholder="选择 Agent 所在电脑后生成配置 Prompt" aria-label="配置 Prompt 预览，密钥已隐藏" />
      <div class="actions"><button class="btn-primary" :disabled="loading || busy || (!hasKey && mode!=='update') || !manifest || !base || !target" @click="copy('prompt')">{{busy?'复制中…':mode==='update'?'复制更新 Prompt':mode==='switch-key'?'复制换 Key Prompt':'复制配置 Prompt'}}</button>
      <div v-if="manifest" class="versions"><span>Skill <code>{{manifest.skill.sha256.slice(0,12)}}</code></span><span>MCP <code>{{manifest.mcp.sha256.slice(0,12)}}</code></span><button class="btn-ghost" :disabled="loading || busy" @click="load">刷新版本</button></div></div>

    </WorkspacePanel>

    <WorkspacePanel title="手动接入" subtitle="支持 Streamable HTTP MCP 和 OpenAI 兼容客户端">
      <div class="manual">
        <label class="model-field">
          <span>接入模型</span>
          <select v-model="model" :disabled="loading || busy">
            <option v-for="m in models" :key="m.id" :value="m.id">{{m.id}}</option>
          </select>
        </label>
        <button class="btn-ghost" :disabled="loading || busy || !hasKey || !manifest || !base || !target" @click="copy('mcp')">复制 MCP JSON</button>
        <button class="btn-ghost" :disabled="loading || busy || !hasKey || !model || !manifest || !base || !target" @click="copy('model')">复制模型接入配置</button>
        <button class="btn-ghost" :disabled="loading || busy || !hasKey || !model || !manifest || !base || !target" @click="copy('json')">复制模型 JSON</button>
      </div>
      <p class="hint">MCP：{{base}}/mcp · 模型接口：{{base}}/v1 · 素材页使用同一 API Key，按密钥隔离图片。</p>
    </WorkspacePanel>
    <p v-if="feedback" class="notice copy-feedback" role="status">{{feedback}}</p>
    <div v-if="manualDialog" class="manual-overlay" @click.self="closeManual">
      <form class="manual-dialog" role="dialog" aria-modal="true" aria-label="手动填写 API Key" v-modal-focus="closeManual" @submit.prevent="applyManual">
        <h3>手动填写 API Key</h3>
        <label>API Key<input v-model="keyDraft" type="password" autocomplete="off" placeholder="填写客户端使用的 API Key" /></label>
        <div class="actions"><button v-if="manual" type="button" class="btn-ghost" @click="clearManual">改用列表密钥</button><button type="button" class="btn-ghost" @click="closeManual">取消</button><button type="submit" class="btn-primary" :disabled="!keyDraft.trim()">使用此密钥</button></div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.connection-note{padding:10px 12px;margin:0 0 16px;background:var(--primary-soft);border-radius:8px;color:var(--primary);font-size:12px;line-height:1.7}.fields{display:grid;grid-template-columns:1.35fr 1fr 1fr;gap:14px}label{display:flex;flex-direction:column;gap:8px;min-width:0;font-size:12px;color:var(--text-2)}label span,.hint{font-size:12px;color:var(--text-3);line-height:1.7}input,select,.preview{min-width:0;width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:9px;background:var(--bg);color:var(--text);font:inherit}.hint{margin-top:12px}.actions,.manual,.versions{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:16px}.actions .hint{margin:0}.actions a{text-decoration:none}.mode{display:inline-flex;gap:4px;background:var(--bg);border:1px solid var(--border);padding:4px;border-radius:10px}.mode button{border:0;border-radius:7px;background:transparent;color:var(--text-3);padding:8px 16px;cursor:pointer}.mode .active{background:var(--primary-soft);color:var(--primary)}.intro{font-size:13px;color:var(--text-2);line-height:1.7;margin:14px 0}.preview{font:11px/1.7 var(--mono);resize:vertical}.versions{border-top:1px solid var(--border);padding-top:14px;color:var(--text-3);font-size:11px}.versions code{margin-left:6px}.versions button{margin-left:auto}.manual{margin-top:0}.manual label{flex:1;max-width:390px}.badge{font-size:11px;color:var(--primary);background:var(--primary-soft);padding:5px 10px;border-radius:20px}.notice{padding:12px 16px;background:var(--primary-soft);color:var(--primary);border-radius:10px;font-size:12px}.copy-feedback{position:fixed;bottom:24px;left:50%;transform:translateX(-35%);max-width:min(600px,80vw);box-shadow:0 6px 28px #0002;z-index:20}.notice.error{background:var(--card);color:var(--rose)}@media(max-width:1000px){.fields{grid-template-columns:1fr}.manual label{flex-basis:100%;max-width:none}}
.manual { align-items: flex-end; }
.manual-active { color:var(--primary); border-color:var(--primary); }
.manual-overlay { position:fixed; inset:0; z-index:100; background:#0005; display:grid; place-items:center; padding:20px; }
.manual-dialog { width:min(480px,100%); padding:24px; border:1px solid var(--border); border-radius:12px; background:var(--card); box-shadow:0 16px 60px #0003; }
.manual-dialog h3 { font-size:16px; margin:0 0 20px; }
.manual-dialog .actions { justify-content:flex-end; }
.manual select, .manual button { min-height: 40px; }
.manual + .hint { overflow-wrap: anywhere; }


.target-picker { margin-left:4px; }
.mode { font-size:12px; }
.mode button { font:inherit; line-height:20px; }
.target-option { position:relative; display:flex; align-items:center; padding:8px 16px; border-radius:7px; cursor:pointer; }
.target-option input { position:absolute; opacity:0; width:1px; height:1px; }
.target-option span { font-size:12px; line-height:20px; color:var(--text-3); }
.target-option.selected { background:var(--primary-soft); }
.target-option.selected span { color:var(--primary); }
.target-option:has(input:focus-visible) { outline:2px solid var(--primary); outline-offset:2px; }
.target-option:has(input:disabled) { opacity:.5; cursor:wait; }
.actions .versions { margin:0 0 0 auto; padding:0; border:0; }
.manual .model-field { flex-direction:row; align-items:center; max-width:none; flex:1 1 300px; gap:12px; }
.model-field span { white-space:nowrap; flex:none; }
.model-field select { flex:1; width:auto; }
.manual { align-items:center; }
</style>
