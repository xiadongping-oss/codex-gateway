<script setup>
// 实例池卡片：把 /__gw/status 里已经有的 bridgeInstances 摊开给用户看。
//
// 为什么要展示：池化后「一个账号一个 bridge 进程」，控制台原本只有一句
// 「网关已自动托管」，用户看不出现在到底起了几个进程、各占哪个端口、
// 哪个账号正在服务、有没有实例卡在 starting。出问题时这些正是第一手信息。
import { computed } from 'vue'

const props = defineProps({
  instances: { type: Array, default: () => [] },
  pool: { type: Object, default: () => ({}) },
  activeAccountId: { type: String, default: '' }
})

const max = computed(() => Number(props.pool?.maxInstances) || 0)
const list = computed(() => (Array.isArray(props.instances) ? props.instances : []))
const running = computed(() => list.value.filter((i) => i.state === 'ready').length)
const inflightTotal = computed(() => list.value.reduce((s, i) => s + (Number(i.inflight) || 0), 0))

const stateText = (s) => ({ ready: '就绪', starting: '启动中', stopping: '停止中', failed: '失败' }[s] || s || '—')
const stateClass = (s) => ({ ready: 'ok', starting: 'warn', stopping: 'warn', failed: 'bad' }[s] || 'off')

// 空闲时长：回收阈值之前都能直观看出「这个实例快被回收了」
function idleText(sec) {
  const n = Number(sec) || 0
  if (n < 5) return '刚刚'
  if (n < 60) return `${n}s`
  if (n < 3600) return `${Math.floor(n / 60)}m`
  return `${Math.floor(n / 3600)}h`
}

// 空闲回收阈值（毫秒→分钟文案），没有就只显示进程数
const idleMin = computed(() => {
  const ms = Number(props.pool?.idleTimeoutMs) || 0
  return ms > 0 ? Math.round(ms / 60000) : 0
})
</script>

<template>
  <section class="card c-pool">
    <div class="pool-head">
      <div>
        <div class="card-title">Bridge 实例池</div>
        <div class="card-sub">
          一个账号一个独立进程，切换账号＝切端口，互不抢占同一份登录态
          <template v-if="idleMin"> · 空闲 {{ idleMin }} 分钟自动回收</template>
        </div>
      </div>
      <div class="pool-stats">
        <span class="stat">
          <b>{{ running }}</b><i v-if="max">/{{ max }}</i> 运行中
        </span>
        <span class="stat"><b>{{ inflightTotal }}</b> 在途请求</span>
        <span v-if="pool.evictions" class="stat warn"><b>{{ pool.evictions }}</b> 次淘汰</span>
        <span v-if="pool.failures" class="stat bad"><b>{{ pool.failures }}</b> 次启动失败</span>
      </div>
    </div>

    <div v-if="!list.length" class="pool-empty">
      还没有运行中的实例。添加账号并完成授权后，网关会按账号自动拉起第一个 bridge。
    </div>

    <div v-else class="pool-list">
      <div
        v-for="inst in list"
        :key="inst.key || inst.port"
        class="inst"
        :class="{ active: inst.key && inst.key === activeAccountId }"
      >
        <span class="inst-state" :class="stateClass(inst.state)">
          <span class="dot"></span>{{ stateText(inst.state) }}
        </span>
        <span class="inst-name" :title="inst.key || ''">
          {{ inst.label || inst.key || '未绑定账号' }}
          <span v-if="inst.key && inst.key === activeAccountId" class="inst-cur">当前</span>
        </span>
        <span class="inst-cell mono">:{{ inst.port }}</span>
        <span class="inst-cell mono" :title="'在途请求数'">{{ Number(inst.inflight) || 0 }} 在途</span>
        <span class="inst-cell mono" :title="'距上次使用'">空闲 {{ idleText(inst.idleSec) }}</span>
        <span class="inst-cell mono pid" :title="'进程 PID'">{{ inst.pid ? 'PID ' + inst.pid : '—' }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.c-pool { flex: 1; }
.pool-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.pool-stats { display: flex; gap: 14px; flex-wrap: wrap; flex: none; }
.stat { font-size: 11.5px; color: var(--text-3); white-space: nowrap; }
.stat b { font-family: var(--mono); font-size: 13px; color: var(--text); font-weight: 600; }
.stat i { font-style: normal; font-family: var(--mono); color: var(--text-3); }
.stat.warn b { color: var(--amber); }
.stat.bad b { color: var(--rose); }

.pool-empty {
  margin-top: 14px; padding: 14px; border-radius: 10px;
  background: var(--bg); border: 1px dashed var(--border-strong);
  font-size: 12.5px; color: var(--text-3);
}

.pool-list { margin-top: 14px; display: flex; flex-direction: column; gap: 8px; }
.inst {
  display: flex; align-items: center; gap: 14px;
  padding: 10px 12px; border-radius: 10px;
  background: var(--card-2); border: 1px solid var(--border);
}
/* 当前服务中的实例用左侧绿边标出——用户看的第一件事就是「哪个账号在服务」 */
.inst.active { border-color: rgba(16, 185, 129, 0.35); box-shadow: inset 3px 0 0 var(--emerald); }
.inst-state {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 999px; flex: none;
}
.inst-state .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.inst-state.ok { background: var(--emerald-dim); color: var(--emerald-light); }
.inst-state.warn { background: rgba(251, 191, 36, 0.14); color: var(--amber); }
.inst-state.bad { background: rgba(244, 63, 94, 0.12); color: var(--rose); }
.inst-state.off { background: rgba(255, 255, 255, 0.06); color: var(--text-3); }
.inst-name {
  flex: 1; min-width: 0; font-size: 12.5px; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.inst-cur {
  font-size: 10px; font-weight: 700; margin-left: 6px; padding: 1px 6px; border-radius: 5px;
  color: #04130d; background: var(--emerald);
}
.inst-cell { font-size: 11.5px; color: var(--text-2); flex: none; min-width: 74px; }
.mono { font-family: var(--mono); }
.pid { min-width: 92px; text-align: right; color: var(--text-3); }

@media (max-width: 900px) {
  .inst { flex-wrap: wrap; gap: 8px 12px; }
  .pid { text-align: left; }
}
</style>
