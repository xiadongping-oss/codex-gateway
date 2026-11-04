<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import * as api from '../api/gateway'

const props = defineProps({ account: { type:Object, required:true } })
const emit = defineEmits(['open'])
const q = ref(null)
const loading = ref(false)
const failed = ref(false)
let timer = null, revision = 0, disposed = false

const loggedIn = computed(() => props.account.loggedIn === true)
const identity = computed(() => loggedIn.value
  ? props.account.email?.includes('@') ? props.account.email : props.account.name || '已登录账号'
  : '未登录')
const quota = computed(() => {
  if (!loggedIn.value || !q.value) return null
  if (props.account.accountId && q.value.accountId !== props.account.accountId) return null
  return q.value
})
const windows = computed(() => {
  const weekly = quota.value?.weekly
  const models = Array.isArray(quota.value?.models) ? quota.value.models : []
  const valid = window => typeof window?.remainingPercent === 'number' && Number.isFinite(window.remainingPercent)
  const result = valid(weekly) ? [weekly] : []
  const tightest = models.filter(valid).reduce((a, b) => !a || b.remainingPercent < a.remainingPercent ? b : a, null)
  if (tightest && (!result.length || tightest.remainingPercent < weekly.remainingPercent)) result.push(tightest)
  return result
})
const plan = computed(() => quota.value?.plan?.badge)
const syncText = computed(() => {
  if (!loggedIn.value) return ''
  if (failed.value) return q.value ? '同步失败 · 上次记录' : '额度读取失败'
  if (!quota.value) return loading.value ? '读取中…' : '等待同步'
  if (quota.value.source === 'manual') return '手动记录'
  const seconds = quota.value.ageSec
  if (quota.value.source !== 'realtime' || typeof seconds !== 'number') return '等待上游同步'
  if (seconds < 60) return '刚刚同步'
  if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟前同步'
  return Math.floor(seconds / 3600) + ' 小时前同步'
})
const remaining = window => Math.max(0, Math.min(100, window.remainingPercent))
const windowLabel = window => /^weekly$/i.test(window.label || '') ? '每周额度' : window.label || '模型额度'
const windowHint = window => '剩余额度' + (window.resetIn && window.resetIn !== '—' ? ' · ' + (window.resetIn === '已重置' ? '已到重置时间' : window.resetIn + '后重置') : '')

async function load() {
  const request = ++revision
  if (!loggedIn.value) { q.value = null; loading.value = false; failed.value = false; return }
  loading.value = true
  const result = await api.getAccountQuota().catch(() => null)
  if (disposed || request !== revision) return
  loading.value = false
  failed.value = !result
  if (result) q.value = result
}
watch([() => props.account.accountId, () => props.account.loggedIn, () => props.account.email], () => {
  q.value = null
  load()
}, {flush:'sync'})
onMounted(() => { load(); timer = setInterval(load, 30000) })
onUnmounted(() => { disposed = true; revision++; clearInterval(timer) })
</script>

<template>
  <section class="overview-account" aria-label="当前账号与剩余额度">
    <header class="account-heading">
      <h3 :title="identity">{{ identity }}</h3>
      <span v-if="plan && plan !== '—'" class="plan-badge">{{ plan }}</span>
    </header>
    <div v-if="windows.length" class="quota-rows">
      <div v-for="(window,i) in windows" :key="window.id || i" class="quota-row" :class="window.tone" :title="windowHint(window)">
        <div class="quota-reading"><span>{{ windowLabel(window) }} · 剩余</span><strong>{{ remaining(window) }}<small>%</small></strong></div>
        <div class="quota-track" role="progressbar" :aria-label="windowLabel(window) + '剩余额度'" :aria-valuenow="remaining(window)" aria-valuemin="0" aria-valuemax="100"><div :style="{width:remaining(window)+'%'}" /></div>
      </div>
    </div>
    <p v-else class="quota-empty">{{ !loggedIn ? '登录后查看额度' : loading ? '正在读取额度…' : failed ? '暂时无法读取额度' : '暂无额度数据' }}</p>
    <footer class="account-footer">
      <span class="sync-text" :class="{warning:failed || quota?.stale}" :title="quota?.source === 'realtime' ? '最近一次上游记录的额度' : ''">{{ syncText }}</span>
      <button class="account-link" @click="emit('open')">{{ loggedIn ? '管理账号' : '连接账号' }} <span aria-hidden="true">→</span></button>
    </footer>
  </section>
</template>

<style scoped>
.overview-account { display:flex; flex-direction:column; gap:20px; min-width:0; padding:20px; border:1px solid var(--border); border-radius:12px; background:var(--card); }
.account-heading { display:flex; align-items:center; gap:8px; min-width:0; }
.account-heading h3 { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; font-weight:600; margin:0; color:var(--text); }
.plan-badge { flex:none; padding:3px 6px; border-radius:4px; background:var(--primary-soft); color:var(--primary); font-size:10px; }
.quota-rows { display:grid; gap:16px; }
.quota-row { --quota-tone:var(--primary); }
.quota-row.amber { --quota-tone:var(--amber); }
.quota-row.rose { --quota-tone:var(--rose); }
.quota-reading { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }
.quota-reading>span { color:var(--text-3); font-size:11px; }
.quota-reading strong { font:600 20px/1 var(--mono); color:var(--quota-tone); }
.quota-reading strong small { font-size:11px; margin-left:2px; font-weight:400; }
.quota-track { height:4px; border-radius:4px; background:var(--border); overflow:hidden; }
.quota-track>div { height:100%; border-radius:inherit; background:var(--quota-tone); }
.quota-empty { font-size:12px; color:var(--text-3); margin:0; padding:10px 0; }
.account-footer { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-top:auto; padding-top:12px; border-top:1px solid var(--border); }
.sync-text { color:var(--text-3); font-size:10px; }
.sync-text.warning { color:var(--amber); }
.account-link { display:inline-flex; align-items:center; gap:6px; margin-left:auto; padding:0; border:0; background:transparent; color:var(--primary); font:inherit; font-size:11px; cursor:pointer; white-space:nowrap; }
.account-link:hover { text-decoration:underline; }
</style>
