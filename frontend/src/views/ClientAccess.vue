<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import WorkspacePanel from '../components/WorkspacePanel.vue'
import { BASE, gwRequest, copyText } from '../api/client'
import * as api from '../api/gateway'
import { formatAccessConfig } from '../api/access-config'
import '../../../gateway/client-setup.js'

const emit = defineEmits(['navigate'])
const keys=ref([]), models=ref([]), lan=ref(null), keyId=ref(''), model=ref(''), base=ref(''), device=ref('')
const target=ref('')
const manifest=ref(null), loading=ref(true), busy=ref(false), error=ref(''), feedback=ref(''), mode=ref('install')
let disposed=false, revision=0
const localBase=(BASE || window.location.origin).replace(/\/$/,'')
const connections=computed(()=>target.value==='local' ? [{url:localBase,label:'网关本机 · '+localBase}] : target.value==='remote' && lan.value?.enabled ? (lan.value.addresses || []).map(a=>({url:`http://${a.address.includes(':') ? '['+a.address+']' : a.address}:${lan.value.port}`,label:`共享主机 · ${a.address}:${lan.value.port}`,preferred:a.preferred})) : [])
watch(connections,items=>{if(!items.some(c=>c.url===base.value))base.value=items.find(c=>c.preferred)?.url || items[0]?.url || ''},{flush:'sync'})
const textModels=computed(()=>models.value.filter(m=>m.kind!=='image'))
const prompt=computed(()=>base.value ? globalThis.CGWClientSetup.buildClientPrompt({base:base.value,target:target.value,key:'<复制时填入所选 API Key>',device:device.value,update:mode.value==='update'}) : '')
watch([base,keyId,device,model,mode,target],()=>{revision++;feedback.value=''}, {flush:'sync'})
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
  if(busy.value || !keyId.value || !manifest.value)return
  if(!target.value || !base.value){error.value='请先选择 Agent 所在电脑及可用的连接地址。';return}
  const selected=revision
  busy.value=true;feedback.value='';error.value=''
  try {
    const token=(await api.revealApiKey(keyId.value))?.token
    if(disposed || selected!==revision)return
    if(!token)throw new Error('未能读取密钥，请重新选择。')
    let text
    if(kind==='prompt')text=globalThis.CGWClientSetup.buildClientPrompt({base:base.value,target:target.value,key:token,device:device.value,update:mode.value==='update'})
    else if(kind==='model')text=formatAccessConfig(base.value+'/v1',token,model.value)
    else text=JSON.stringify(globalThis.CGWClientSetup.buildMcpConfig({base:base.value,target:target.value,key:token,device:device.value}),null,2)
    await copyText(text)
    if(!disposed && selected===revision)feedback.value='已复制，包含所选 API Key。请粘贴到目标客户端的私有配置或对话。'
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
    <WorkspacePanel title="连接到客户端" subtitle="本机和局域网共用一套接入方式；每位用户建议单独创建 API Key">
      <template #actions><button class="btn-ghost" @click="emit('navigate','lan')">管理共享</button><button class="btn-ghost" @click="emit('navigate','apikeys')">管理密钥</button></template>
      <div class="mode target-picker" role="group" aria-label="Agent 在哪台电脑上使用"><button :class="{active:target==='local'}" :disabled="busy" @click="target='local'">网关这台电脑</button><button :class="{active:target==='remote'}" :disabled="busy" @click="target='remote'">其他设备 · 无需安装网关</button></div>
      <p v-if="!target" class="hint">先选择 Agent 所在的电脑，再复制配置，避免把本机回环地址发给其他用户。</p>
      <p v-else-if="target==='local'" class="connection-note">127.0.0.1 只代表网关这台电脑。给其他电脑的用户配置时，请选择“其他设备”。</p>
      <p v-else class="connection-note">用户电脑只需 Agent 和 API Key；MCP、Skill 下载与素材页均连接网关主机，无需安装网关或 Node.js。{{lan?.enabled?'请选择两台电脑可互通的主机地址。':'共享尚未开启，请先在“管理共享”中开启局域网共享。'}}</p>
      <div class="fields">
        <label>连接地址<select v-model="base" :disabled="loading || busy"><option v-if="!connections.length" value="">{{target==='remote'?'请先开启共享':'请先选择 Agent 所在电脑'}}</option><option v-for="c in connections" :key="c.url" :value="c.url">{{c.label}}</option></select></label>
        <label>API Key<select v-model="keyId" :disabled="loading || busy"><option value="">请选择密钥</option><option v-for="k in keys" :key="k.id" :value="k.id">{{k.name}} · {{k.mask}}</option></select></label>
        <label>设备名称（可选）<input v-model="device" maxlength="80" :disabled="busy" placeholder="例如：设计工作站" /></label>
      </div>
      <p class="hint">局域网地址需要先开启共享。密钥只在复制时读取，预览始终隐藏密钥；设备名由客户端自报，IP 由连接记录。</p>
      <div class="actions"><button class="btn-ghost" :disabled="!base" @click="copySetup">复制网页接入地址</button></div>
    </WorkspacePanel>

    <WorkspacePanel title="让 Agent 完成配置" subtitle="复制 Prompt 到目标 Agent，由它安装 Skill、合并 MCP 配置并检查连接">
      <template #actions><span v-if="manifest" class="badge">网关 {{manifest.gatewayVersion}}</span></template>
      <div class="mode" role="group" aria-label="配置方式"><button :class="{active:mode==='install'}" @click="mode='install'">首次配置</button><button :class="{active:mode==='update'}" @click="mode='update'">更新 Skill / MCP</button></div>
      <p class="intro">{{mode==='update'?'比较内容哈希、备份并合并更新，保留现有密钥与其他配置；重新连接后验证工具定义。':'安装「GPT 图片生成」Skill（/gpt-image）与图片 MCP，保留现有模型和其他连接器。'}}</p>
      <textarea class="preview" :value="prompt" readonly rows="7" placeholder="选择 Agent 所在电脑后生成配置 Prompt" aria-label="配置 Prompt 预览，密钥已隐藏" />
      <div class="actions"><button class="btn-primary" :disabled="loading || busy || !keyId || !manifest || !base || !target" @click="copy('prompt')">{{busy?'复制中…':mode==='update'?'复制更新 Prompt':'复制配置 Prompt'}}</button><span class="hint">验证连接不会自动生成或删除图片。</span></div>
      <div v-if="manifest" class="versions"><span>Skill <code>{{manifest.skill.sha256.slice(0,12)}}</code></span><span>MCP <code>{{manifest.mcp.sha256.slice(0,12)}}</code></span><button class="btn-ghost" :disabled="loading || busy" @click="load">刷新版本</button></div>
      <p class="hint">这里显示网关提供的版本。目标客户端是否已安装、是否已重新加载，由更新 Prompt 实际检查。出图后 Skill 会要求 Agent 每次打开或刷新素材页；客户端需要支持浏览器工具。</p>
    </WorkspacePanel>

    <WorkspacePanel title="手动接入" subtitle="支持 Streamable HTTP MCP 和 OpenAI 兼容客户端">
      <div class="manual"><label>对话模型<select v-model="model" :disabled="loading || busy"><option v-for="m in textModels" :key="m.id" :value="m.id">{{m.id}}</option></select></label><button class="btn-ghost" :disabled="loading || busy || !keyId || !manifest || !base || !target" @click="copy('mcp')">复制 MCP JSON</button><button class="btn-ghost" :disabled="loading || busy || !keyId || !model || !manifest || !base || !target" @click="copy('model')">复制模型接入配置</button></div>
      <p class="hint">MCP：{{base}}/mcp · 模型接口：{{base}}/v1 · 素材页使用同一 API Key，按密钥隔离图片。</p>
    </WorkspacePanel>
    <p v-if="feedback" class="notice copy-feedback" role="status">{{feedback}}</p>
  </div>
</template>

<style scoped>
.target-picker{margin-bottom:14px}.connection-note{padding:10px 12px;margin:0 0 16px;background:var(--primary-soft);border-radius:8px;color:var(--primary);font-size:12px;line-height:1.7}.fields{display:grid;grid-template-columns:1.35fr 1fr 1fr;gap:14px}label{display:flex;flex-direction:column;gap:8px;min-width:0;font-size:12px;color:var(--text-2)}label span,.hint{font-size:12px;color:var(--text-3);line-height:1.7}input,select,.preview{min-width:0;width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:9px;background:var(--bg);color:var(--text);font:inherit}.hint{margin-top:12px}.actions,.manual,.versions{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:16px}.actions .hint{margin:0}.actions a{text-decoration:none}.mode{display:inline-flex;gap:4px;background:var(--bg);border:1px solid var(--border);padding:4px;border-radius:10px}.mode button{border:0;border-radius:7px;background:transparent;color:var(--text-3);padding:8px 16px;cursor:pointer}.mode .active{background:var(--primary-soft);color:var(--primary)}.intro{font-size:13px;color:var(--text-2);line-height:1.7;margin:14px 0}.preview{font:11px/1.7 var(--mono);resize:vertical}.versions{border-top:1px solid var(--border);padding-top:14px;color:var(--text-3);font-size:11px}.versions code{margin-left:6px}.versions button{margin-left:auto}.manual{margin-top:0}.manual label{flex:1;max-width:390px}.badge{font-size:11px;color:var(--primary);background:var(--primary-soft);padding:5px 10px;border-radius:20px}.notice{padding:12px 16px;background:var(--primary-soft);color:var(--primary);border-radius:10px;font-size:12px}.copy-feedback{position:fixed;bottom:24px;left:50%;transform:translateX(-35%);max-width:min(600px,80vw);box-shadow:0 6px 28px #0002;z-index:20}.notice.error{background:var(--card);color:var(--rose)}@media(max-width:1000px){.fields{grid-template-columns:1fr}.manual label{flex-basis:100%;max-width:none}}
</style>
