<script setup>
// 降级（failover）状态卡片：把 /__gw/status.failover 翻成用户可读面板。
//
// 为什么展示：多账号池在收到 429/401 时会自动换号重放，但在此之前用户侧完全无感知——
// 他只看到「突然变慢」或「某次调用被延后」。这里把「哪些账号在冷却、还剩多久、为什么」
// 直接摊开，并给出可行动提示（额度耗尽＝等几分钟；凭据失效＝去重新授权）。
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'

const props = defineProps({
  failover: { type: Object, default: () => ({ degraded: [], stats: {}, maxAttempts: 2 }) }
})

const list = computed(() => Array.isArray(props.failover?.degraded) ? props.failover.degraded : [])
const stats = computed(() => props.failover?.stats || {})
const maxAttempts = computed(() => Number(props.failover?.maxAttempts) || 2)

const hasDegraded = computed(() => list.value.length > 0)

// 本地秒级倒计时：快照里的 remainSec 是抓取时刻的值，每 3s 才随轮询刷新一次；
// 这里基于「上次抓取时刻」本地递推，界面每秒平滑递减，不必为倒计时单独打请求。
const lastUpdate = ref(Date.now())
const tick = ref(0)
watch(() => props.failover, () => { lastUpdate.value = Date.now() }, { deep: true })

let timer = null
onMounted(() => { timer = setInterval(() => tick.value++, 1000) })
onUnmounted(() => { if (timer) clearInterval(timer) })

function cdOf(item) {
  void tick.value // 触发重算
  const base = Number(item?.remainSec) || 0
  const elapsed = (Date.now() - lastUpdate.value) / 1000
  const left = Math.max(0, base - elapsed)
  const m = String(Math.floor(left / 60)).padStart(2, '0')
  const s = String(Math.floor(left % 60)).padStart(2, '0')
  return `${m}:${s}`
}

// 触发原因 → 用户可读提示与色调
function reasonInfo(item) {
  const code = Number(item?.reason)
  if (code === 429) return { text: '额度窗口耗尽', hint: '等几分钟自动恢复，或换其它模型', tone: 'amber' }
  if (code === 401) return { text: '凭据失效', hint: '去「账号」页重新授权后自动复活', tone: 'rose' }
  return { text: '降级冷却中', hint: '暂时不会被选为服务账号', tone: 'amber' }
}
</script>

<template>
  <section class="card fo-card">
    <div class="fo-head">
      <div>
        <div class="card-title">账号降级（failover）</div>
        <div class="card-sub">
          收到 429/401 时自动换号重放；这里显示正在冷却的账号与剩余时间——排障时直接看出「为什么没切过去」
        </div>
      </div>
      <span class="fo-flag" :class="hasDegraded ? 'warn' : 'ok'">
        <span class="dot"></span>{{ hasDegraded ? list.length + ' 个冷却中' : '全部健康' }}
      </span>
    </div>

    <div v-if="!hasDegraded" class="fo-calm">
      ✓ 当前无账号处于降级冷却，所有账号都可被正常选为服务账号。
    </div>

    <div v-else class="fo-list">
      <div v-for="item in list" :key="item.accountId" class="fo-item" :class="reasonInfo(item).tone">
        <div class="fo-who">
          <span class="fo-acct">{{ item.accountId }}</span>
          <span class="fo-reason">{{ reasonInfo(item).text }}</span>
        </div>
        <div class="fo-right">
          <span class="fo-cd">{{ cdOf(item) }}</span>
          <span class="fo-hint">{{ reasonInfo(item).hint }}</span>
        </div>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat"><b>{{ stats.attempts ?? 0 }}</b><span>降级尝试</span></div>
      <div class="stat"><b>{{ stats.succeeded ?? 0 }}</b><span>换号成功</span></div>
      <div class="stat"><b>{{ stats.exhausted ?? 0 }}</b><span>全部耗尽</span></div>
      <div class="stat"><b>{{ stats.skippedDegraded ?? 0 }}</b><span>跳过(冷却中)</span></div>
      <div class="stat"><b>{{ maxAttempts }}</b><span>单请求最多换号</span></div>
    </div>
  </section>
</template>

<style scoped>
.fo-card { flex: 1; }
.fo-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.fo-flag {
  display: inline-flex; align-items: center; gap: 6px; flex: none;
  font-size: 10.5px; font-weight: 700; padding: 3px 9px; border-radius: 999px;
}
.fo-flag .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.fo-flag.ok { background: var(--emerald-dim); color: var(--emerald-light); }
.fo-flag.warn { background: rgba(245, 158, 11, 0.14); color: var(--amber); }

.fo-calm {
  margin-top: 14px; padding: 13px 14px; border-radius: 10px;
  background: var(--card-2); border: 1px dashed var(--border-strong);
  font-size: 12.5px; color: var(--text-2);
}

.fo-list { margin-top: 14px; display: flex; flex-direction: column; gap: 9px; }
.fo-item {
  display: flex; align-items: center; justify-content: space-between; gap: 14px;
  padding: 11px 13px; border-radius: 10px;
  background: var(--card-2); border: 1px solid var(--border);
}
.fo-item.amber { border-color: rgba(245, 158, 11, 0.4); }
.fo-item.rose { border-color: rgba(244, 63, 94, 0.4); }
.fo-who { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.fo-acct { font-family: var(--mono); font-size: 13px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fo-reason { font-size: 11.5px; color: var(--text-2); }
.fo-item.amber .fo-reason { color: var(--amber); }
.fo-item.rose .fo-reason { color: var(--rose); }
.fo-right { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex: none; }
.fo-cd { font-family: var(--mono); font-size: 17px; font-weight: 700; color: var(--text); letter-spacing: 0.5px; }
.fo-hint { font-size: 10.5px; color: var(--text-3); max-width: 200px; text-align: right; }

.stat-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 15px; }
.stat { background: var(--card-2); border: 1px solid var(--border); border-radius: 9px; padding: 8px 12px; flex: 1; min-width: 84px; }
.stat b { display: block; font-family: var(--mono); font-size: 16px; font-weight: 600; color: var(--text); }
.stat span { font-size: 10px; color: var(--text-3); }

@media (max-width: 760px) {
  .fo-item { flex-wrap: wrap; gap: 8px 12px; }
  .fo-right { align-items: flex-start; text-align: left; }
  .fo-hint { text-align: left; max-width: none; }
}
</style>
