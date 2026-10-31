<script setup>
import { ref, computed, onMounted } from 'vue'
import { useLiveData } from '../composables/useLiveData'

// 调用日志与 bridge 日志都取自共享单例：
// 此前本页面自己每 2.5s 轮询一次 /__gw/call-logs，而 useLiveData 也在轮询
// 同一个接口（每 2s），等于同一份数据被拉两遍。改为共用后只保留一路请求。
const { gwLogs, logs, refreshLogs, logsLoaded: loaded, logsError, gwLogsLoaded, gwLogsError } = useLiveData()

const filter = ref('all')
// 页内 Tab：业务调用日志 / Bridge 进程运行日志（自原「网关控制」页并入）
const tab = ref('calls')

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
  return logs.value.filter((l) => def.match(l.status))
})
const countOf = (def) => logs.value.filter((l) => def.match(l.status)).length

const fmtTime = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
const statusClass = (s) => (s === 200 ? 's-200' : s === 429 ? 's-429' : s === 401 ? 's-401' : s >= 400 ? 's-500' : '')
// 错误行判定：[err]/✗ 标记，但「listening」启动横幅虽走 stderr 不是错误，不标红
const isErrLine = (line) => (line.includes('[err]') || line.includes('✗')) && !/listening/i.test(line)
</script>

<template>
  <div class="content">
    <div class="tabs">
      <button class="tab" :class="{ active: tab === 'calls' }" @click="tab = 'calls'">业务调用</button>
      <button class="tab" :class="{ active: tab === 'bridge' }" @click="tab = 'bridge'">Bridge 运行日志</button>
    </div>

    <template v-if="tab === 'calls'">
    <div v-if="logsError" class="log-warning" role="alert">{{ logsError }}<span v-if="loaded"> 当前保留上次获取的记录。</span></div>
    <div class="page-head">
      <div class="live-tag"><span class="dot"></span>实时调用日志 · 网关反代逐笔记录 · 每 2.5s 刷新</div>
      <div class="chips">
        <button
          v-for="def in filterDefs"
          :key="def.key"
          class="chip"
          :class="{ active: filter === def.key }"
          @click="filter = def.key"
        >
          {{ def.label }} <span class="n">{{ countOf(def) }}</span>
        </button>
      </div>
    </div>

    <div class="card">
      <div class="table" v-if="shown.length">
        <div class="tr th">
          <span>方法</span><span>端点</span><span>模型</span><span>状态</span>
          <span>延迟</span><span>Token</span><span>时间</span>
        </div>
        <div class="tr" v-for="l in shown" :key="l.id">
          <span class="mono m-post">{{ l.method }}</span>
          <span class="mono ep">{{ l.endpoint }}</span>
          <span class="mono">{{ l.model }}</span>
          <span class="mono" :class="statusClass(l.status)">{{ l.status }}</span>
          <span class="mono">{{ l.latency }}ms</span>
          <span class="mono">{{ l.tokens ?? '—' }}</span>
          <span class="mono time">{{ fmtTime(l.at) }}</span>
        </div>
      </div>
      <div class="empty" v-else-if="logsError"><div class="empty-sub">暂时无法确认是否有调用记录，连接恢复后会自动刷新。</div></div>
      <div class="empty" v-else-if="loaded && filter !== 'all'">
        <div class="empty-title">该状态下暂无记录</div>
        <div class="empty-sub">当前筛选「{{ filterDefs.find((f) => f.key === filter)?.label }}」没有匹配的调用，切换到「全部」查看所有记录。</div>
      </div>
      <div class="empty" v-else-if="loaded">
        <div class="empty-title">暂无调用记录</div>
        <div class="empty-sub">从任意 OpenAI 兼容客户端（WorkBuddy / Codex CLI / curl）发起请求后，这里会实时显示每次 /v1 调用的模型、状态、延迟与 Token 用量。</div>
      </div>
      <div class="empty" v-else role="status">
        <div class="empty-sub">载入中…</div>
      </div>
    </div>
    </template>

    <template v-else>
      <div v-if="gwLogsError" class="log-warning" role="alert">{{ gwLogsError }}<span v-if="gwLogsLoaded"> 当前保留上次获取的记录。</span></div>
      <div class="page-head">
        <div class="live-tag"><span class="dot"></span>启动器捕获的 chatgpt-bridge 子进程标准输出 / 错误 · 每 3s 刷新</div>
      </div>
      <div class="card">
        <div class="bridge-logs">
          <div v-for="(line, i) in gwLogs" :key="i" class="log-line" :class="{ err: isErrLine(line) }">{{ line }}</div>
          <div v-if="!gwLogs.length" class="empty-sub" role="status" style="padding: 30px; text-align: center">{{ gwLogsError ? '暂时无法确认是否有运行日志' : gwLogsLoaded ? '暂无日志' : '载入中…' }}</div>
        </div>
        <div class="card-sub" style="margin-top: 10px">
          这里是进程级运行日志（启动 / 健康检查 / 上游错误 / 补丁校验）；业务调用的模型、状态与 Token 请看「业务调用」标签。
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.log-warning { color: var(--amber); background: var(--card); border: 1px solid var(--border-strong); border-radius: 14px; padding: 12px 16px; }
.table { min-width: 640px; }
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
.chip.active { background: var(--emerald-dim); color: var(--emerald-light); border-color: rgba(16, 185, 129, 0.35); }
.chip .n { font-family: var(--mono); font-size: 10.5px; opacity: 0.75; }
.table { display: flex; flex-direction: column; }
.tr {
  display: grid; grid-template-columns: 54px 1fr 0.8fr 60px 64px 72px 84px;
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
</style>
