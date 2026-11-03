<script setup>
// 概览页的额度速览条：只回答「还能用多久、哪个模型最紧」，详情去账号页看。
import { ref, computed, onMounted, onUnmounted } from 'vue'
import * as api from '../api/gateway'
import QuotaWindow from './QuotaWindow.vue'

const emit = defineEmits(['open'])

const q = ref(null)
let timer = null

const account = computed(() => q.value?.account || null)
const weekly = computed(() => q.value?.weekly || null)
const plan = computed(() => q.value?.plan || null)

const windows = computed(() => {
  const result = weekly.value ? [weekly.value] : []
  const models = Array.isArray(q.value?.models) ? q.value.models : []
  const tightest = models.reduce((a,b) => !a || b.remainingPercent < a.remainingPercent ? b : a, null)
  if (tightest && (!weekly.value || tightest.remainingPercent < weekly.value.remainingPercent)) result.push(tightest)
  return result
})

// 距上次真实观测多久（上游只在真实调用后才回限流头）
const ageText = computed(() => {
  const s = q.value?.ageSec
  if (typeof s !== 'number') return ''
  if (s < 60) return '刚刚'
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前'
  return Math.floor(s / 3600) + ' 小时前'
})

async function load() {
  const r = await api.getAccountQuota().catch(() => null)
  if (r) q.value = r
}

onMounted(() => {
  load()
  timer = setInterval(load, 30000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <section v-if="q" class="quota-overview card">
    <header class="qo-head"><div><div class="qo-title">账号用量 <span v-if="plan?.badge && plan.badge !== '—'" class="qo-plan">{{ plan.badge }}</span></div><p class="qo-account">{{ account?.name || '当前账号' }}</p></div><div class="qo-actions"><span class="qo-sync">{{ q.source === 'realtime' ? '上游同步 · ' + (ageText || '刚刚') : q.source === 'manual' ? '手动记录' : '等待同步' }}</span><button class="btn-ghost" @click="emit('open')">查看额度 →</button></div></header>
    <div v-if="windows.length" class="qo-windows"><QuotaWindow v-for="(w,i) in windows" :key="w.id || i" :quota="w" compact /></div>
    <p v-else class="qo-empty">暂无额度数据，完成一次调用后自动同步。</p>
  </section>
</template>
<style scoped>
.quota-overview { min-width:0; }
.qo-head { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px; margin-bottom:16px; }
.qo-title { display:flex; align-items:center; gap:8px; font-size:13px; font-weight:600; }
.qo-plan { color:var(--primary); background:var(--primary-soft); border-radius:5px; padding:2px 6px; font-size:10px; }
.qo-account { color:var(--text-3); font-size:11px; margin-top:4px; overflow-wrap:anywhere; }
.qo-actions { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.qo-sync { color:var(--text-3); font-size:11px; }
.qo-actions button { font-size:12px; }
.qo-windows { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr)); gap:16px; }
.qo-empty { color:var(--text-3); font-size:12px; padding:12px 0 0; }
@media(max-width:680px) { .qo-actions { width:100%; justify-content:space-between; } }
</style>
