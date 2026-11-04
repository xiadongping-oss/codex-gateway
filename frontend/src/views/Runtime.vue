<script setup>
import { computed } from 'vue'
import { useLiveData } from '../composables/useLiveData'
import WorkspacePanel from '../components/WorkspacePanel.vue'
import BridgePoolCard from '../components/BridgePoolCard.vue'
import FailoverCard from '../components/FailoverCard.vue'
defineEmits(['navigate'])
const { status, gw, gwConnected, lastError } = useLiveData()
const state = computed(() => gwConnected.value !== true ? '等待连接' : gw.value.running ? '运行中' : '已停止')
</script>
<template>
  <div class="content runtime-page">
    <p v-if="gwConnected !== true || lastError" class="runtime-notice" role="status">暂时无法同步运行状态，正在重试。</p>
    <WorkspacePanel title="运行状态" subtitle="本机模型代理与请求负载" :badge="state">
      <template #actions><button class="btn-ghost" @click="$emit('navigate','overview')">管理模型代理</button></template>
      <div class="runtime-metrics"><div><span>本地接口</span><strong>{{ status.host }}</strong></div><div><span>监听端口</span><strong>{{ status.port }}</strong></div><div><span>请求 / 秒</span><strong>{{ gwConnected ? status.qps : '—' }}</strong></div><div><span>运行时长</span><strong>{{ gwConnected ? Math.floor((gw.uptimeSec || 0) / 60) + ' 分钟' : '—' }}</strong></div></div>
    </WorkspacePanel>
    <BridgePoolCard v-if="gwConnected" :instances="gw.bridgeInstances || []" :pool="gw.bridgePool || {}" :active-account-id="gw.activeAccountId || ''" />
    <FailoverCard v-if="gwConnected" :failover="gw.failover || {}" />
    <div class="actions"><button class="btn-ghost" @click="$emit('navigate','account')">管理账号与额度</button><button class="btn-ghost" @click="$emit('navigate','logs')">查看调用日志</button></div>
  </div>
</template>
<style scoped>
.runtime-metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:16px; }
.runtime-metrics>div { padding:16px; background:var(--bg); border:1px solid var(--border); border-radius:10px; min-width:0; }
.runtime-metrics span { display:block; color:var(--text-3); font-size:12px; }
.runtime-metrics strong { display:block; margin-top:8px; font:500 20px var(--mono); overflow-wrap:anywhere; }
.runtime-notice { padding:12px 16px; background:var(--card); border:1px solid var(--border); border-radius:12px; font-size:12px; color:var(--amber); }
.runtime-page :deep(.card-title) { font-size:14px; font-weight:650; }
.runtime-page :deep(.card-sub) { font-size:12px; margin-top:4px; }
.runtime-page :deep(.pool-head), .runtime-page :deep(.fo-head) { flex-wrap:wrap; }
.runtime-page :deep(.pool-item) { flex-wrap:wrap; }
@media(max-width:1100px) { .runtime-metrics { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media(max-width:760px) { .runtime-metrics strong { font-size:16px; } }
</style>
