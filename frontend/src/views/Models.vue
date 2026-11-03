<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import * as api from '../api/gateway'
import WorkspacePanel from '../components/WorkspacePanel.vue'
import AccessConfig from '../components/AccessConfig.vue'
import AppIcon from '../components/AppIcon.vue'
defineEmits(['navigate'])
const section = ref('text'), models = ref([]), capabilities = ref(null), imageModel = ref(''), selectedModel = ref('')
const loading = ref(false), error = ref(''), synced = ref(false)
let disposed = false
const textModels = computed(() => models.value.filter(m=>m.kind!=='image'))
const imageModels = computed(() => models.value.filter(m=>m.kind==='image'))
const sections = [{id:'text',icon:'models',title:'文本模型',description:'对话、写作、代码与图片理解'},{id:'agent',icon:'runtime',title:'Agent 能力',description:'工具调用与多步骤任务协作'},{id:'image',icon:'images',title:'出图能力',description:'生成、参考图重绘与编辑边界'}]
const statusNames = {wired:'已接入',limited:'有限支持',missing:'尚未接入',unverified:'待实测',provider:'由供应商决定'}
const verificationNames = {passed:'实测通过',limited:'实测有限',failed:'实测未通过',unsupported:'当前不支持'}
const imageExamples = [{title:'透明背景',endpoint:'/v1/images/generations',body:{prompt:'生成一个透明底的茶壶图标',background:'transparent',output_format:'png'}},{title:'蒙版局部编辑',endpoint:'/v1/images/edits',body:{prompt:'把蒙版区域中的方块改成绿色三角形',image:'data:image/png;base64,…',mask:'data:image/png;base64,…'}},{title:'向两侧扩图',endpoint:'/v1/images/edits',body:{prompt:'自然延伸背景，保留原有主体',image:'data:image/png;base64,…',outpaint:{left:256,right:256}}}]
function checkedAt(value){return value?new Date(value).toLocaleString('zh-CN',{hour12:false}):''}
const modelDescriptions = {'gpt-6.1-sol':'默认模型，适合对话、写作与代码任务。','gpt-6-astra':'适合复杂问题分析和多步骤推理。','gpt-6.1-terra':'适合常规问答、内容整理和批量处理。'}
async function refresh(force=false) {
  if (loading.value) return
  loading.value=true;error.value=''
  try {
    const [catalog,status]=await Promise.all([api.getModels({refresh:force}),api.getGatewayStatus()])
    if(disposed)return
    models.value=catalog||[];capabilities.value=catalog?.capabilities||null;synced.value=catalog?.modelsOk===true
    imageModel.value=status?.imageModel||''
    if(!selectedModel.value)selectedModel.value=catalog?.defaultModel||textModels.value[0]?.id||''
    if(!models.value.length)error.value='暂无模型目录，请检查账号连接后重试。'
  } catch {if(!disposed)error.value='目录读取失败，请重试。'}
  finally{if(!disposed)loading.value=false}
}
function choose(id){selectedModel.value=id;document.getElementById('model-access')?.scrollIntoView({behavior:'smooth',block:'start'})}
onMounted(()=>refresh());onUnmounted(()=>{disposed=true})
</script>
<template>
  <div class="content models-page">
    <nav class="capability-nav" aria-label="模型能力分类"><button v-for="item in sections" :key="item.id" :class="{active:section===item.id}" :aria-pressed="section===item.id" @click="section=item.id"><span class="capability-icon"><AppIcon :name="item.icon" /></span><span><strong>{{ item.title }}</strong><small>{{ item.description }}</small></span><span class="capability-arrow">→</span></button></nav>
    <p v-if="error" class="model-error" role="alert">{{ error }}</p>
    <WorkspacePanel v-if="section==='text'" title="文本与图片理解" subtitle="选择模型后，在下方复制客户端接入配置" :badge="synced ? '目录已同步' : '本地目录'">
      <template #actions><button class="btn-ghost" :disabled="loading" @click="refresh(true)">{{ loading?'刷新中…':'刷新目录' }}</button></template>
      <p v-if="!synced" class="model-note">当前目录可以用于配置，实际调用仍需账号连接正常。</p>
      <div class="text-models"><article v-for="model in textModels" :key="model.id" :class="['model-card',{selected:selectedModel===model.id}]"><div class="model-card-heading"><h3>{{ model.label }}</h3><span v-if="model.id===selectedModel" class="small-badge">已选择</span></div><code>{{ model.id }}</code><p>{{ modelDescriptions[model.id] || '可通过 OpenAI 兼容客户端调用。' }}</p><div class="model-tags"><span>文本与代码</span><span v-if="model.vision">图片输入</span><span>流式响应</span></div><button class="btn-ghost" @click="choose(model.id)">选择并配置</button></article></div>
      <p class="model-note">图片输入用于识别、分析参考图片；生成图片请查看“出图能力”。模型目录不代表账号当前可用状态。</p>
    </WorkspacePanel>
    <WorkspacePanel v-else-if="section==='agent'" title="让模型与客户端工具协作" subtitle="网关传递工具请求与结果，客户端负责执行动作">
      <div v-if="capabilities" class="agent-grid"><article v-for="feature in capabilities.agent" :key="feature.id"><span class="small-badge">已接入</span><h3>{{ feature.title }}</h3><p>{{ feature.detail }}</p></article></div>
      <p v-else class="model-note">能力信息尚未读取，请刷新目录或更新网关。</p>
      <ol class="agent-flow"><li><b>1</b>模型提出工具调用</li><li><b>2</b>客户端执行动作</li><li><b>3</b>回传结果，继续任务</li></ol>
      <div class="usage-note"><h3>可以用于哪些任务？</h3><p>搭配支持工具的客户端，可进行代码修改、文件整理、命令执行与多步骤工作流。具体工具和执行权限由客户端提供，网关不会自动获得电脑控制权限。</p><p>图片工具也可通过本网关的 MCP 服务接入支持 MCP 的客户端；这不代表所有客户端都自带浏览器或电脑操作能力。</p></div>
    </WorkspacePanel>
    <WorkspacePanel v-else title="图片生成与编辑" subtitle="按当前网关链路列出功能，避免把模型原生能力当作已接通的功能" :badge="capabilities?.mode==='openai'?'API 供应商直连':'订阅工具通道'">
      <template #actions><button class="btn-ghost" :disabled="loading" @click="refresh()">{{ loading?'刷新中…':'刷新状态' }}</button></template>
      <div class="image-route"><div><span>实际出图路径</span><strong>{{ capabilities?.mode==='openai'?'由已配置的 API 供应商处理':imageModel ? imageModel+' + image_generation':'等待读取' }}</strong></div><span class="small-badge">标准接口单次 1 张</span></div>
      <div v-if="capabilities?.verification" class="verification-note"><strong>当前账号实测</strong><span>{{ checkedAt(capabilities.verification.checkedAt) }} · {{ capabilities.verification.model }}</span><p>仅对应当前账号、通道和网关适配版本。换账号或记录超过 30 天后，需重新验证。</p></div>
      <div class="feature-table"><div class="feature-head"><span>功能</span><span>支持状态</span><span>使用方式与限制</span></div><div v-for="feature in capabilities?.image||[]" :key="feature.id" class="feature-row"><h3>{{ feature.title }}</h3><span :class="['feature-status',feature.verification?.status||feature.status]">{{ feature.verification ? verificationNames[feature.verification.status] : statusNames[feature.status] }}</span><div><p>{{ feature.detail }}</p><p v-if="feature.verification" class="verification-detail">实测：{{ feature.verification.detail }}</p></div></div></div>
      <p v-if="!capabilities" class="model-note">能力清单尚未读取，请刷新目录或更新网关。</p>
      <div class="usage-note"><h3>图片模型名称怎么选？</h3><p v-if="capabilities?.mode!=='openai'">下面是供客户端填写的兼容名称。在订阅通道中，换名称不会切换实际出图模型，也不会自动启用透明底或局部编辑；画质和尺寸由请求参数控制。</p><div class="image-aliases"><button v-for="model in imageModels" :key="model.id" class="btn-ghost" @click="choose(model.id)"><code>{{ model.id }}</code></button></div></div>
      <div v-if="capabilities?.mode!=='openai'" class="image-examples"><article v-for="example in imageExamples" :key="example.title"><h3>{{ example.title }}</h3><code>POST {{ example.endpoint }}</code><pre>{{ JSON.stringify(example.body,null,2) }}</pre></article></div>
      <p class="model-note">编辑接口接受 JSON 或 multipart 文件上传（image / image[]、mask）。蒙版须与原图同尺寸，透明处编辑、不透明处保留；自动扩图使用 PNG 输入。“已接入”表示代码链路就绪，“实测通过／有限”才表示当前账号已验收。</p>
    </WorkspacePanel>
    <div id="model-access"><AccessConfig :models="models" :model="selectedModel" @update:model="selectedModel=$event" @navigate="$emit('navigate',$event)" /></div>
    <WorkspacePanel title="接口速查" subtitle="同一接口地址可供不同类型的客户端使用"><div class="endpoint-list"><div><code>/v1/responses</code><span>文本、图像输入与工具调用</span></div><div><code>/v1/chat/completions</code><span>OpenAI 兼容对话客户端</span></div><div><code>/v1/images/generations</code><span>标准出图与参考图重绘</span></div><div><code>/v1/images/edits</code><span>图片编辑、蒙版与扩图</span></div></div></WorkspacePanel>
  </div>
</template>
<style scoped>
.verification-note{padding:14px 16px;border:1px solid var(--border);border-radius:9px;margin-bottom:14px;background:var(--primary-soft)}.verification-note strong{font-size:12px}.verification-note span{margin-left:12px;font:11px var(--mono);color:var(--text-3)}.verification-note p{margin-top:5px}.verification-detail{font-size:11px!important;margin-top:6px;color:var(--primary)!important}.feature-status.passed{background:var(--primary-soft);color:var(--primary)}.feature-status.failed{color:var(--rose)}.image-examples{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:16px}.image-examples article{min-width:0;border:1px solid var(--border);border-radius:9px;padding:14px;background:var(--bg)}.image-examples code{display:block;font:10px var(--mono);color:var(--text-3);margin-top:7px;overflow-wrap:anywhere}.image-examples pre{font:10px/1.7 var(--mono);color:var(--text-2);white-space:pre-wrap;overflow-wrap:anywhere;margin-top:12px}.feature-row>div{min-width:0}@media(max-width:1100px){.image-examples{grid-template-columns:1fr}}@media(max-width:760px){.feature-row>div{grid-column:1/-1}.verification-note span{display:block;margin:7px 0 0}}
.capability-nav{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;flex-shrink:0}.capability-nav button{display:flex;align-items:center;gap:12px;padding:16px;border:1px solid var(--border);border-radius:12px;background:var(--card);color:var(--text);text-align:left;cursor:pointer}.capability-nav button.active{border-color:var(--primary);background:var(--primary-soft)}.capability-icon{display:grid;place-items:center;width:38px;height:38px;flex:none;background:var(--card-2);border-radius:10px;color:var(--primary)}.capability-icon svg{width:19px;height:19px}.capability-nav strong{display:block;font-size:13px;font-weight:600}.capability-nav small{display:block;margin-top:4px;font-size:11px;color:var(--text-3);line-height:1.5}.capability-arrow{margin-left:auto;color:var(--primary)}.text-models,.agent-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.model-card,.agent-grid article{padding:18px;border:1px solid var(--border);border-radius:10px;background:var(--bg);min-width:0}.model-card.selected{border-color:var(--primary)}h3{font-size:13px;font-weight:600}.model-card-heading{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.model-card>code{display:block;font:11px var(--mono);color:var(--text-3);margin-top:7px;overflow-wrap:anywhere}p{font-size:12px;line-height:1.65;color:var(--text-2)}.model-card p{margin-top:14px;min-height:40px}.small-badge{padding:3px 7px;background:var(--primary-soft);color:var(--primary);font-size:10px;border-radius:5px;white-space:nowrap}.model-tags{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0}.model-tags span{font-size:10px;color:var(--text-2);border:1px solid var(--border);padding:3px 6px;border-radius:5px}.model-card button{width:100%;margin-top:4px}.model-note{font-size:12px;color:var(--text-3);margin-top:14px}.model-note:first-child{margin-top:0;margin-bottom:14px}.model-error{color:var(--rose);font-size:12px}.agent-grid h3{margin:13px 0 7px}.agent-flow{display:flex;list-style:none;gap:16px;padding:18px 0;margin-top:16px;border-bottom:1px solid var(--border)}.agent-flow li{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-2);flex:1}.agent-flow b{display:grid;place-items:center;border-radius:50%;width:23px;height:23px;background:var(--primary-soft);color:var(--primary);font-size:11px}.usage-note{padding:16px;margin-top:16px;border:1px solid var(--border);border-radius:10px;background:var(--bg)}.usage-note p{margin-top:7px}.image-route{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border:1px solid var(--border);background:var(--bg);border-radius:9px;margin-bottom:18px}.image-route span{font-size:11px;color:var(--text-3)}.image-route strong{display:block;font-size:13px;font-weight:550;margin-top:5px;overflow-wrap:anywhere}.feature-head,.feature-row{display:grid;grid-template-columns:minmax(125px,1fr) 90px minmax(0,2.5fr);gap:16px;align-items:start;padding:13px 4px}.feature-head{font-size:11px;color:var(--text-3);border-bottom:1px solid var(--border)}.feature-row+.feature-row{border-top:1px solid var(--border)}.feature-row h3{font-size:12px;line-height:1.7}.feature-status{width:fit-content;font-size:10px;line-height:1.6;padding:3px 7px;border-radius:5px;background:var(--card-2);color:var(--text-3);white-space:nowrap}.feature-status.wired{background:var(--primary-soft);color:var(--primary)}.feature-status.limited,.feature-status.unverified{background:var(--card-2);color:var(--text-2);border:1px solid var(--border)}.image-aliases{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.image-aliases code{font-size:11px;overflow-wrap:anywhere}.endpoint-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.endpoint-list code{display:block;font:11px var(--mono);color:var(--primary);overflow-wrap:anywhere}.endpoint-list span{display:block;font-size:12px;color:var(--text-3);margin-top:7px}#model-access{flex-shrink:0;scroll-margin-top:14px}@media(max-width:1100px){.text-models,.agent-grid{grid-template-columns:1fr}.model-card p{min-height:0}.capability-nav small{display:none}}@media(max-width:760px){.capability-nav{grid-template-columns:1fr}.capability-nav small{display:block}.feature-head{display:none}.feature-row{grid-template-columns:1fr auto}.feature-row p{grid-column:1/-1}.agent-flow{flex-direction:column}.endpoint-list{grid-template-columns:1fr}.image-route{align-items:flex-start;flex-direction:column}}
</style>
