<script setup>
import { ref } from 'vue'
import CallLogsPanel from '../components/CallLogsPanel.vue'
import { useLiveData } from '../composables/useLiveData'

// 调用日志与 bridge 日志都取自共享单例：
// 此前本页面自己每 2.5s 轮询一次 /__gw/call-logs，而 useLiveData 也在轮询
// 同一个接口（每 2s），等于同一份数据被拉两遍。改为共用后只保留一路请求。
const { gwLogs, gwLogsLoaded, gwLogsError } = useLiveData()

const tab = ref('calls')
// 错误行判定：[err]/✗ 标记，但「listening」启动横幅虽走 stderr 不是错误，不标红
const isErrLine = (line) => (line.includes('[err]') || line.includes('✗')) && !/listening/i.test(line)
</script>

<template>
  <div class="content">
    <Teleport to="#page-tabs"><nav class="workspace-sections" aria-label="日志分类">
      <button :aria-current="tab === 'calls' ? 'page' : undefined" @click="tab = 'calls'">业务调用</button>
      <button :aria-current="tab === 'bridge' ? 'page' : undefined" @click="tab = 'bridge'">Bridge 运行日志</button>
    </nav></Teleport>

    <CallLogsPanel v-if="tab === 'calls'" />
    <template v-else>
      <div v-if="gwLogsError" class="log-warning" role="alert">{{ gwLogsError }}<span v-if="gwLogsLoaded"> 当前保留上次获取的记录。</span></div>
      <div class="page-head">
        <div class="live-tag"><span class="dot"></span>运行日志 · 实时更新</div>
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
.log-line { overflow-wrap: anywhere; }
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
</style>
