<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import * as api from '../api/gateway'
import { BASE, copyText } from '../api/client'
import { formatAccessConfig } from '../api/access-config'
import WorkspacePanel from './WorkspacePanel.vue'
const props = defineProps({ models: { type: Array, default: null }, model: { type: String, default: '' } })
const emit = defineEmits(['navigate','update:model'])
const keys = ref([]), catalog = ref([]), modelId = ref(props.model), keyId = ref(''), manual = ref(false), manualKey = ref('')
const loading = ref(true), busy = ref(false), message = ref(''), failed = ref(false)
let disposed = false, timer
const baseUrl = (BASE || window.location.origin) + '/v1'
const availableModels = computed(() => props.models || catalog.value)
function chooseModel() { if (!availableModels.value.some(m => m.id === modelId.value)) modelId.value = availableModels.value.find(m => m.id === props.model)?.id || availableModels.value.find(m => m.kind !== 'image')?.id || availableModels.value[0]?.id || 'gpt-6.1-sol' }
watch(() => props.model, value => { if (value) modelId.value = value })
watch(availableModels, chooseModel)
watch(modelId, value => emit('update:model',value))
const preview = computed(() => formatAccessConfig(baseUrl, (manual.value ? manualKey.value.trim() : keyId.value) ? '<复制时填入所选密钥>' : null, modelId.value))
async function copyConfig(format) {
  if (busy.value || !modelId.value) return
  const selection = [modelId.value,keyId.value,manual.value,manualKey.value].join('|')
  busy.value = true; message.value = ''; failed.value = false
  try {
    const token = manual.value ? manualKey.value.trim() : keyId.value ? (await api.revealApiKey(keyId.value))?.token : ''
    if (disposed || selection !== [modelId.value,keyId.value,manual.value,manualKey.value].join('|')) return
    if (!token) throw new Error('请先选择或填入有效 API Key。')
    const text = format === 'json' ? JSON.stringify({baseUrl,apiKey:token,model:modelId.value},null,2) : formatAccessConfig(baseUrl,token,modelId.value)
    await copyText(text)
    if (!disposed) message.value = '接入配置已复制，包含所选 API Key。'
  } catch (error) { if (!disposed) { failed.value = true; message.value = error.message || '复制失败，请重试。' } }
  finally { if (!disposed) { busy.value = false; clearTimeout(timer); timer = setTimeout(() => { message.value = '' },5000) } }
}
onMounted(async () => {
  try {
    const [list, models] = await Promise.all([api.listApiKeys(), props.models ? Promise.resolve([]) : api.getModels()])
    if (disposed) return
    keys.value = (list || []).filter(k => !k.disabled); catalog.value = models || []; keyId.value = keys.value[0]?.id || ''; chooseModel()
  } catch { if (!disposed) { failed.value = true; message.value = '配置读取失败，请重新进入此页。' } }
  finally { if (!disposed) loading.value = false }
})
onUnmounted(() => { disposed = true; manualKey.value = ''; clearTimeout(timer) })
</script>
<template>
  <WorkspacePanel title="客户端接入" subtitle="选择模型和密钥，复制到 OpenAI 兼容客户端">
    <template #actions><button class="btn-ghost" @click="emit('navigate','apikeys')">管理 API Key</button></template>
    <div class="access-fields">
      <label>接口地址<input :value="baseUrl" readonly aria-label="接口地址" /></label>
      <label>模型<select v-model="modelId" :disabled="loading || busy"><option v-if="!availableModels.length" value="gpt-6.1-sol">gpt-6.1-sol</option><option v-for="item in availableModels" :key="item.id" :value="item.id">{{ item.id }}</option></select></label>
      <label>API Key<input v-if="manual" v-model="manualKey" type="password" placeholder="cgw-…" autocomplete="off" :disabled="busy" /><select v-else v-model="keyId" :disabled="loading || busy"><option value="">请选择密钥</option><option v-for="key in keys" :key="key.id" :value="key.id">{{ key.name }} · {{ key.mask }}</option></select></label>
    </div>
    <div class="access-actions"><button class="btn-primary" :disabled="loading || busy || !(manual ? manualKey.trim() : keyId)" @click="copyConfig('env')">{{ busy ? '复制中…' : '复制接入配置' }}</button><button class="btn-ghost" :disabled="loading || busy || !(manual ? manualKey.trim() : keyId)" @click="copyConfig('json')">复制 JSON</button><label class="manual-toggle"><input v-model="manual" type="checkbox" :disabled="busy" />手动填写密钥</label></div>
    <pre class="access-preview">{{ preview }}</pre>
    <p class="access-hint">客户端选择 OpenAI 兼容协议。按需开启工具调用、图片输入与思考模式，关闭“自定义协议”。密钥仅在复制时读取。</p>
    <p v-if="!keys.length && !loading && !manual" class="access-hint">暂无可用密钥，请先到 API Key 页面创建。</p>
    <p v-if="message" :class="['access-feedback',{failed}]" role="status">{{ message }}</p>
  </WorkspacePanel>
</template>
<style scoped>
.access-fields{display:grid;grid-template-columns:1.25fr 1fr 1fr;gap:14px}.access-fields label{display:flex;flex-direction:column;gap:7px;min-width:0;font-size:12px;color:var(--text-3)}.access-fields input,.access-fields select{width:100%;min-width:0;min-height:38px;padding:8px 10px;border:1px solid var(--border-strong);border-radius:8px;background:var(--bg);color:var(--text);font:inherit;font-size:12px}.access-fields input[readonly]{font-family:var(--mono);color:var(--text-2)}.access-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:14px 0}.manual-toggle{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-3);margin-left:auto}.manual-toggle input{accent-color:var(--primary)}.access-preview{padding:12px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;font:11px/1.6 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text-2)}.access-hint{margin-top:10px;font-size:12px;line-height:1.6;color:var(--text-3)}.access-feedback{margin-top:10px;font-size:12px;color:var(--primary)}.access-feedback.failed{color:var(--rose)}@media(max-width:1000px){.access-fields{grid-template-columns:1fr}.manual-toggle{margin-left:0}}
</style>
