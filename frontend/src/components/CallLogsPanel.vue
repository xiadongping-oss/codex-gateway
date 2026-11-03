<script setup>
import { ref, computed, onMounted } from 'vue'
import { useLiveData } from '../composables/useLiveData'
import { usePagination } from '../composables/usePagination'
import Pagination from '../components/Pagination.vue'

// 调用日志与 bridge 日志都取自共享单例：
// 此前本页面自己每 2.5s 轮询一次 /__gw/call-logs，而 useLiveData 也在轮询
// 同一个接口（每 2s），等于同一份数据被拉两遍。改为共用后只保留一路请求。
const { logs, refreshLogs, logsLoaded: loaded, logsError } = useLiveData()

const filter = ref('all')
const callerSearch=ref('')
defineProps({ title: {type:String,default:''} })
const detail = ref(localStorage.getItem('gw.logs.detail') !== 'compact')
function setDetail(value) { detail.value=value;localStorage.setItem('gw.logs.detail',value?'detail':'compact') }

onMounted(() => {
  refreshLogs()
})

// 状态筛选：全部 / 成功 / 限流 / 未授权 / 其他错误
const filterDefs = [
  { key: 'all', label: '全部', match: () => true },
  { key: 'ok', label: '成功 2xx', match: (s) => s >= 200 && s < 300 },
  { key: 'rate', label: '限流 429', match: (s) => s === 429 },
  { key: 'auth', label: '未授权 401', match: (s) => s === 401 },
  { key: 'err', label: '其他错误', match: (s) => s >= 400 && s !== 429 && s !== 401 }
]
const shown = computed(() => {
  const def = filterDefs.find((f) => f.key === filter.value) || filterDefs[0]
  return logs.value.filter((l) => def.match(l.status) && (!callerSearch.value.trim() || [l.model,l.endpoint,l.caller?.ip,l.caller?.device,l.caller?.keyName,l.caller?.keyId].some(v=>String(v || '').toLowerCase().includes(callerSearch.value.trim().toLowerCase()))))
})
const countOf = (def) => logs.value.filter((l) => def.match(l.status)).length
const {page,pages,visible}=usePagination(shown,30)

const fmtTime = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
const statusClass = (s) => (s === 200 ? 's-200' : s === 429 ? 's-429' : s === 401 ? 's-401' : s >= 400 ? 's-500' : '')
</script>

<template>
  <section class="call-panel" :class="{compact:!detail}">
    <div class="panel-heading"><h3 v-if="title">{{title}}</h3><input class="caller-search" v-model="callerSearch" @input="page=1" placeholder="搜索模型、端点、IP、设备或密钥" aria-label="搜索调用记录" /><div class="mode-switch" role="group" aria-label="调用展示模式"><button :class="{active:!detail}" @click="setDetail(false)">精简</button><button :class="{active:detail}" @click="setDetail(true)">详细</button></div></div>
    <div v-if="logsError" class="log-warning" role="alert">{{ logsError }}<span v-if="loaded"> 当前保留上次获取的记录。</span></div>
    <div class="page-head">
      <div class="live-tag"><span class="dot"></span>实时更新</div>
      <div class="chips">
        <button
          v-for="def in filterDefs"
          :key="def.key"
          class="chip"
          :class="{ active: filter === def.key }"
          @click="filter = def.key; page = 1"
        >
          {{ def.label }} <span class="n">{{ countOf(def) }}</span>
        </button>
      </div>
    </div>

    <div class="card calls-card">
      <div class="table" v-if="shown.length">
        <div class="tr th">
          <span>请求 / 模型</span><span>调用来源 / 密钥</span><span>状态</span>
          <span>耗时 / Token</span><span>时间</span>
        </div>
        <div class="tr" v-for="l in visible" :key="l.id">
          <span class="request"><strong>{{ l.model && l.model !== '—' ? l.model : l.endpoint === '/v1/models' ? '模型列表查询' : '未记录模型' }}</strong><small class="mono">{{l.method}} {{l.endpoint}}</small></span>
          <span class="caller" :title="l.caller?.keyId || ''"><strong>{{l.caller?.device || l.caller?.ip || '历史记录'}}</strong><small v-if="l.caller?.device">{{l.caller.ip}} · 自报设备</small><small>{{l.caller?.keyName || (l.caller?.keyId ? '已验证密钥' : l.status === 401 ? '认证未通过' : l.caller ? '未携带 API Key' : '未记录来源')}}<template v-if="l.caller?.keyId"> · {{l.caller.keyId.slice(-8)}}</template></small></span>
          <span class="mono" :class="statusClass(l.status)">{{ l.status }}</span>
          <span class="usage"><strong class="mono">{{ l.latency }}ms</strong><small>{{ l.tokens != null ? l.tokens.toLocaleString() + ' Token' : l.method === 'GET' ? '无需 Token' : '上游未返回用量' }}</small><small v-if="detail && l.usage">输入 {{l.usage.promptTokens}} · 输出 {{l.usage.completionTokens}}</small></span>
          <span class="mono time"><small v-if="detail">{{new Date(l.at).toLocaleDateString()}}</small>{{ fmtTime(l.at) }}</span>
        </div>
      </div>
      <div class="empty" v-else-if="logsError"><div class="empty-sub">暂时无法确认是否有调用记录，连接恢复后会自动刷新。</div></div>
      <div class="empty" v-else-if="loaded && (filter !== 'all' || callerSearch.trim())">
        <div class="empty-title">暂无匹配记录</div>
        <div class="empty-sub">当前筛选「{{ filterDefs.find((f) => f.key === filter)?.label }}」没有匹配的调用，可清空搜索或切换到「全部」。</div>
      </div>
      <div class="empty" v-else-if="loaded">
        <div class="empty-title">暂无调用记录</div>
        <div class="empty-sub">客户端发起调用后，记录会显示在这里。</div>
      </div>
      <div class="empty" v-else role="status">
        <div class="empty-sub">载入中…</div>
      </div>
    </div>
    <Pagination v-model="page" :pages="pages" :total="shown.length" />

  </section>
</template>

<style scoped>
.call-panel { display:flex;flex-direction:column;gap:16px;min-width:0; }
.panel-heading { display:flex;align-items:center;gap:12px;flex-wrap:wrap; }.panel-heading h3{font-size:14px;margin:0}.panel-heading .caller-search{margin-left:auto;box-sizing:border-box;min-width:140px;flex:0 1 360px}
.mode-switch{display:flex;padding:3px;background:var(--card);border:1px solid var(--border);border-radius:8px}.mode-switch button{border:0;background:transparent;color:var(--text-2);padding:6px 10px;cursor:pointer;border-radius:5px}.mode-switch .active{background:var(--primary-soft);color:var(--primary)}
.request,.usage,.time{display:flex;flex-direction:column;gap:5px;min-width:0;overflow-wrap:anywhere}.request strong,.usage strong{font-size:12px;font-weight:550}.request small,.usage small,.time small{font-size:10px;color:var(--text-3)}
.compact .tr{padding-block:9px}.compact .caller small,.compact .request small{display:none}
@media(max-width:700px){.tr:not(.th){grid-template-columns:minmax(0,1fr) minmax(0,1fr) 42px;gap:10px}.tr.th{display:none}.tr .usage{grid-column:1}.tr .time{grid-column:2 / 4}.panel-heading .caller-search{flex:1;width:100%}}

.log-warning { color: var(--amber); background: var(--card); border: 1px solid var(--border-strong); border-radius: 14px; padding: 12px 16px; }
.table { min-width:0; }.calls-card{min-width:0;overflow:visible}.caller{display:flex;flex-direction:column;gap:4px;min-width:0}.caller strong{font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis}.caller small{color:var(--text-3);font-size:10px;overflow-wrap:anywhere}.caller-search{border:1px solid var(--border);background:var(--card);color:var(--text);padding:10px 14px;border-radius:9px;width:min(100%,440px)}.caller-note{font-size:11px;color:var(--text-3);line-height:1.6}
.log-line { overflow-wrap: anywhere; }
.tabs { display: flex; gap: 4px; margin-bottom: 16px; background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 4px; width: fit-content; }
.tab {
  background: transparent; color: var(--text-3); border: none; border-radius: 8px;
  padding: 7px 16px; font-size: 12.5px; cursor: pointer; transition: all 0.15s ease;
}
.tab:hover { color: var(--text); }
.tab.active { background: var(--emerald-dim); color: var(--emerald-light); font-weight: 550; }
.bridge-logs {
  background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
  padding: 12px 14px; height: 380px; overflow-y: auto;
  font-family: var(--mono); font-size: 11.5px; line-height: 1.7; color: var(--text-2);
}
.log-line { white-space: pre-wrap; }
.log-line.err { color: var(--rose); }
.page-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.live-tag { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--emerald-light); font-family: var(--mono); width: fit-content; }
.live-tag .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--emerald-light); animation: pulse 1.5s infinite; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip {
  background: var(--card); color: var(--text-3); border: 1px solid var(--border);
  border-radius: 999px; padding: 4px 12px; font-size: 11.5px; cursor: pointer;
  transition: all 0.15s ease; display: inline-flex; align-items: center; gap: 5px;
}
.chip:hover { color: var(--text); border-color: var(--emerald); }
.chip.active { background: var(--emerald-dim); color: var(--emerald-light); border-color: rgba(139,107,214, 0.35); }
.chip .n { font-family: var(--mono); font-size: 10.5px; opacity: 0.75; }
.table { display: flex; flex-direction: column; }
.tr {
  display: grid; grid-template-columns:minmax(0,1.5fr) minmax(0,1.2fr) 46px minmax(100px,.8fr) 80px;
  gap: 12px; align-items: center; padding: 11px 4px;
  border-top: 1px solid var(--border); font-size: 12.5px;
}
.tr.th { color: var(--text-3); font-size: 11.5px; border-top: none; padding-top: 0; }
.mono { font-family: var(--mono); }
.m-post { color: var(--emerald-light); }
.ep { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }
.time { color: var(--text-3); }
.s-200 { color: var(--emerald-light); }
.s-429 { color: var(--rose); }
.s-401 { color: var(--amber); }
.s-500 { color: var(--rose); }
.empty { padding: 42px 8px; text-align: center; }
.empty-title { font-size: 13.5px; color: var(--text-2); margin-bottom: 8px; }
.empty-sub { font-size: 12px; color: var(--text-3); line-height: 1.7; max-width: 460px; margin: 0 auto; }
@media(max-width:700px){.tr:not(.th){grid-template-columns:minmax(0,1fr) minmax(0,1fr) 42px}.tr.th{display:none}}
</style>
