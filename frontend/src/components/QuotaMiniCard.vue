<script setup>
// 概览页的额度速览条：只回答「还能用多久、哪个模型最紧」，详情去账号页看。
import { ref, computed, onMounted, onUnmounted } from 'vue'
import * as api from '../api/gateway'

const emit = defineEmits(['open'])

const q = ref(null)
let timer = null

const account = computed(() => q.value?.account || null)
const weekly = computed(() => q.value?.weekly || null)
const plan = computed(() => q.value?.plan || null)

// 订阅临期：<=3 天黄，已过期红
const planTone = computed(() => {
  const d = plan.value?.expiresInDays
  if (typeof d !== 'number') return ''
  if (d < 0) return 'rose'
  if (d <= 3) return 'amber'
  return ''
})

// 余量最紧的那个模型——这才是真正会先卡住你的那一个
const tightest = computed(() => {
  const list = Array.isArray(q.value?.models) ? [...q.value.models] : []
  // Weekly 主窗口也是「会先卡住你」的候选，且往往是真正最紧的那个
  const w = weekly.value
  if (w) list.push({ label: w.label || 'Weekly', remainingPercent: w.remainingPercent, tone: w.tone })
  if (!list.length) return null
  return list.reduce((a, b) => (b.remainingPercent < a.remainingPercent ? b : a))
})

// 距上次真实观测多久（上游只在真实调用后才回限流头）
const ageText = computed(() => {
  const s = q.value?.ageSec
  if (typeof s !== 'number') return ''
  if (s < 60) return '刚刚'
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前'
  return Math.floor(s / 3600) + ' 小时前'
})
const isEmpty = computed(() => q.value?.source === 'none')

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
  <div v-if="q" class="quota-strip">
    <div class="qs-left">
      <div class="qs-title">
        账号额度
        <span v-if="plan && plan.badge && plan.badge !== '—'" class="qs-badge">{{ plan.badge }}</span>
        <span v-if="planTone" class="qs-expire" :class="planTone">
          {{ planTone === 'rose' ? '订阅已过期' : '订阅 ' + plan.expiresInText }}
        </span>
        <span v-if="q.source === 'realtime'" class="qs-rt" :title="'用量来自 Codex 上游限流头，仅在上游真实响应后更新（最近一次：' + (ageText || '未知') + '）'">实时<span v-if="ageText"> · {{ ageText }}</span></span>
        <span v-else-if="q.source === 'manual'" class="qs-manual" title="上游还没回过限流头，显示的是手动填写的值">手动</span>
        <span v-if="q.stale" class="qs-stale" title="超过 30 分钟没再观测到上游限流头，数字可能已经变了">可能已过期</span>
        <span v-if="q.sample" class="qs-sample" title="旧版本自动生成的示例数据，到账号页「编辑」保存一次即可覆盖">示例</span>
      </div>
      <div class="qs-account">{{ account.name }}</div>
    </div>

    <div v-if="isEmpty" class="qs-empty">
      还没有观测到额度——到账号页点「刷新额度」探一次，或直接用它跑一次对话（ChatGPT 未公开额度接口）
    </div>

    <div class="qs-mid" v-if="weekly">
      <div class="qs-row">
        <span class="qs-key">{{ weekly.label }} 剩余</span>
        <span class="qs-val" :class="weekly.tone">{{ weekly.remainingPercent }}%</span>
      </div>
      <div class="qs-bar">
        <div class="qs-fill" :class="weekly.tone" :style="{ width: weekly.remainingPercent + '%' }"></div>
      </div>
      <div class="qs-foot">{{ weekly.resetIn }}后重置</div>
    </div>

    <div class="qs-mid tight" v-if="tightest">
      <div class="qs-row">
        <span
          class="qs-key"
          title="把当前账号所有额度窗口放在一起比（各模型的 5 小时窗口 + Weekly 周窗口），取剩余比例最低的一个——下一个把你卡住的就是它。下方小字是对应的窗口名。"
        >最紧余量</span>
        <span class="qs-val" :class="tightest.tone">{{ tightest.remainingPercent }}%</span>
      </div>
      <div class="qs-bar">
        <div class="qs-fill" :class="tightest.tone" :style="{ width: tightest.remainingPercent + '%' }"></div>
      </div>
      <div class="qs-foot ellipsis">{{ tightest.label }}</div>
    </div>

    <button class="btn-ghost sm qs-btn" @click="emit('open')">额度详情</button>
  </div>
</template>

<style scoped>
.quota-strip {
  display: flex; align-items: center; gap: 22px;
  padding: 13px 16px; background: var(--card);
  border: 1px solid var(--border); border-radius: 12px;
}
.qs-left { flex: none; min-width: 150px; }
.qs-title {
  font-size: 12px; color: var(--text-3);
  display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
}
.qs-rt {
  font-size: 10.5px; font-weight: 600; border-radius: 6px; padding: 1px 7px;
  color: #34d399; background: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.35);
}
.qs-sample {
  font-size: 10.5px; font-weight: 600; border-radius: 6px; padding: 1px 7px; cursor: help;
  color: #fbbf24; background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.35);
}
.qs-manual {
  font-size: 10.5px; font-weight: 600; border-radius: 6px; padding: 1px 7px; cursor: help;
  color: var(--text-2); background: rgba(255,255,255,0.06); border: 1px solid var(--border-strong);
}
.qs-stale {
  font-size: 10.5px; font-weight: 600; border-radius: 6px; padding: 1px 7px; cursor: help;
  color: #fbbf24; background: rgba(245,158,11,0.1); border: 1px dashed rgba(245,158,11,0.45);
}
/* 空态不画进度条：画了就是「还剩 100%」的假信息 */
.qs-empty { flex: 1; font-size: 12px; color: var(--text-3); }
.qs-badge {
  font-size: 10.5px; font-weight: 700; color: #04130d;
  background: var(--emerald); border-radius: 5px; padding: 1px 6px;
}
.qs-expire {
  font-size: 10.5px; font-weight: 600; border-radius: 5px; padding: 1px 6px;
  color: var(--amber); background: rgba(251, 191, 36, 0.14);
  border: 1px solid rgba(251, 191, 36, 0.35);
}
.qs-expire.rose {
  color: var(--rose); background: rgba(244, 63, 94, 0.14);
  border-color: rgba(244, 63, 94, 0.35);
}
.qs-account { font-size: 13px; font-weight: 600; margin-top: 3px; }

.qs-mid { flex: 1; min-width: 120px; }
.qs-mid.tight { max-width: 220px; }
.qs-row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.qs-key { font-size: 11px; color: var(--text-3); }
.qs-val { font-family: var(--mono); font-size: 13px; font-weight: 600; }
.qs-val.emerald { color: var(--emerald-light); }
.qs-val.amber { color: var(--amber); }
.qs-val.rose { color: var(--rose); }
.qs-bar {
  height: 5px; border-radius: 999px; background: rgba(255, 255, 255, 0.07);
  overflow: hidden; margin: 5px 0 4px;
}
.qs-fill { height: 100%; border-radius: 999px; transition: width 0.4s ease; }
.qs-fill.emerald { background: linear-gradient(90deg, #10b981, #34d399); }
.qs-fill.amber { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
.qs-fill.rose { background: linear-gradient(90deg, #e11d48, #f43f5e); }
.qs-foot { font-size: 10.5px; color: var(--text-3); font-family: var(--mono); }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.qs-btn { flex: none; padding: 6px 12px; font-size: 12px; }
</style>
