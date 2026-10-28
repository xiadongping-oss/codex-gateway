<script setup>
import { ref, computed } from 'vue'
import { useLiveData } from '../composables/useLiveData'

const emit = defineEmits(['navigate'])
import StatusCard from '../components/StatusCard.vue'
import AccountCard from '../components/AccountCard.vue'
import ModelsCard from '../components/ModelsCard.vue'
import LogsCard from '../components/LogsCard.vue'
import QuotaMiniCard from '../components/QuotaMiniCard.vue'
import LanMiniCard from '../components/LanMiniCard.vue'
import BridgePoolCard from '../components/BridgePoolCard.vue'
import SetupModal from '../components/SetupModal.vue'

const { status, account, logs, capabilities, capabilitiesBase, gw, gwBusy, gwRestart, loadingDiagnose, diagnoseError, health, toggleCapability, diagnose } =
  useLiveData()

const showSetup = ref(false)

async function handleDiagnose() {
  await diagnose()
}
const fmtUptime = (s) => {
  const h = String(Math.floor(s / 3600)).padStart(2, '0')
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const sec = String(s % 60).padStart(2, '0')
  return `${h}:${m}:${sec}`
}
// token 量精简显示：1234 → 1.2K，1234567 → 1.2M
const fmtTok = (n) => {
  n = Number(n) || 0
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

// 限流占比与压力档位（自原「用量监控」页并入概览）
const requests = computed(() => gw.value?.metrics?.requests || 0)
const rateLimited = computed(() => gw.value?.metrics?.rateLimited || 0)
const limitRatio = computed(() => {
  const total = requests.value
  if (!total) return 0
  return Math.min(100, Math.round((rateLimited.value / total) * 100))
})
const pressureLabel = computed(() => {
  if (!rateLimited.value) return '正常'
  if (limitRatio.value < 5) return '轻微'
  if (limitRatio.value < 20) return '偏高'
  return '高频限流'
})
const pressureClass = computed(() => {
  if (!rateLimited.value) return 'ok'
  if (limitRatio.value < 5) return 'warn'
  return 'bad'
})

// 认证健康：真正的登录态来自 /__gw/auth/state 的 account.loggedIn。
// 此前误用 gw.health.ok（那是 bridge 的 HTTP 存活探测），
// 结果 bridge 一停或健康检查超时，界面就误报「需重新授权」。
const authOk = computed(() => account.value?.loggedIn !== false)
const authHint = computed(() => {
  const d = String(account.value?.detail || '')
  if (/token_expired|token refresh failed/i.test(d)) return ' · 登录已过期'
  if (/invalid_request_error|unauthorized|401/i.test(d)) return ' · 认证异常'
  if (/凭据未加载|重新授权/.test(d)) return ' · ' + d
  return ''
})
</script>

<template>
  <div class="content">
    <!-- 网关自动托管条 -->
    <div class="gw-banner">
      <div class="gw-left">
        <span class="state-badge" :class="gw.running ? 'on' : 'off'">
          <span class="state-dot"></span>{{ gw.running ? '网关已自动托管' : '网关未运行' }}
        </span>
        <span v-if="!authOk" class="auth-pill" @click="showSetup = true" title="点击重新授权">
          <span class="state-dot"></span>需重新授权{{ authHint }}
        </span>
        <span class="gw-meta">
          本地启动器拉起 chatgpt-bridge · 运行时长
          <b class="mono">{{ gw.running ? fmtUptime(gw.uptimeSec) : '—' }}</b>
          · API Key <b class="mono">{{ gw.apikeysCount || 0 }}</b> 个
        </span>
      </div>
      <div class="gw-right">
        <button class="btn-ghost sm" :disabled="gwBusy" @click="gwRestart">重启网关</button>
        <button class="btn-ghost sm" @click="showSetup = true">连接 / 登录</button>
      </div>
    </div>

    <!-- 额度速览：只回答「还能用多久、哪个模型最紧」 -->
    <QuotaMiniCard @open="$emit('navigate', 'account')" />

    <!-- 局域网接入速览：首屏一等入口（详情在「模型能力」页） -->
    <LanMiniCard @open="$emit('navigate', 'models')" />

    <!-- Row 1 -->
    <div class="row">
      <StatusCard :status="status" />
      <AccountCard :account="account" @manage="showSetup = true" />
    </div>

    <!-- Row 1.5：实例池（多账号各自一个 bridge 进程，端口/状态/在途） -->
    <BridgePoolCard
      :instances="gw.bridgeInstances || []"
      :pool="gw.bridgePool || {}"
      :active-account-id="gw.activeAccountId || ''"
    />

    <!-- Row 2：用量快照（含原「用量监控」页的限流占比） -->
    <div class="row">
      <section class="card c-quota">
        <div class="card-title">用量快照</div>
        <div class="card-sub">网关真实调用、限流与 Token 消耗 · 持久化于本地，跨重启一致</div>
        <div class="q-grid">
          <div class="q-item">
            <div class="q-label">网关调用次数</div>
            <div class="q-value">{{ requests.toLocaleString() }}</div>
          </div>
          <div class="q-item">
            <div class="q-label">触发限流</div>
            <div class="q-value" :class="rateLimited > 0 ? 'bad' : ''">{{ rateLimited }}</div>
          </div>
          <div class="q-item">
            <div class="q-label">Token 总量</div>
            <div class="q-value">{{ fmtTok(gw.tokensTotal || 0) }}</div>
          </div>
          <div class="q-item">
            <div class="q-label">API Key 数</div>
            <div class="q-value">{{ gw.apikeysCount || 0 }}</div>
          </div>
        </div>
        <div class="limit-row">
          <div class="bar-wrap">
            <div class="bar" :class="pressureClass" :style="{ width: limitRatio + '%' }"></div>
          </div>
          <span class="pressure-tag" :class="pressureClass">{{ pressureLabel }}</span>
          <span class="pressure-meta">限流 {{ rateLimited }} · 总调用 {{ requests.toLocaleString() }}</span>
        </div>
        <button class="btn-ghost sm full" @click="$emit('navigate', 'apikeys')">查看 Key 调用明细</button>
      </section>
    </div>

    <!-- Row 3 -->
    <div class="row">
      <ModelsCard :capabilities="capabilities" :supported="capabilitiesBase" @toggle="toggleCapability" />
      <LogsCard :logs="logs" />
    </div>

    <SetupModal
      v-if="showSetup"
      :loading="loadingDiagnose"
      :error="diagnoseError"
      :health="health"
      @close="showSetup = false"
      @diagnose="handleDiagnose"
    />
  </div>
</template>

<style scoped>
.content {
  flex: 1; overflow-y: auto; padding: 24px;
  display: flex; flex-direction: column; gap: 18px;
}
.gw-banner {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px; background: var(--card); border: 1px solid var(--border); border-radius: 12px;
}
.gw-left { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.state-badge { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; font-size: 12.5px; font-weight: 600; }
.state-badge.on { background: var(--emerald-dim); color: var(--emerald-light); }
.state-badge.off { background: rgba(244,63,94,0.12); color: var(--rose); }
.state-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.auth-pill {
  display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px;
  font-size: 12.5px; font-weight: 600; cursor: pointer;
  background: rgba(244,63,94,0.12); color: var(--rose); border: 1px solid rgba(244,63,94,0.3);
}
.auth-pill:hover { background: rgba(244,63,94,0.2); }
.gw-meta { font-size: 12.5px; color: var(--text-2); }
.gw-meta b { color: var(--text); }
.gw-right { display: flex; gap: 8px; }
.btn-ghost.sm { padding: 7px 12px; font-size: 12px; }
.c-quota { flex: 1; }
.q-grid { display: flex; gap: 10px; margin-top: 14px; }
.q-item { flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 12px; }
.q-label { font-size: 11.5px; color: var(--text-3); }
.q-value { font-size: 20px; font-weight: 700; margin-top: 6px; }
.q-value .sep { color: var(--text-3); margin: 0 2px; }
.q-value.bad { color: var(--rose); }
.limit-row { display: flex; align-items: center; gap: 12px; margin-top: 14px; }
.bar-wrap { flex: 1; height: 10px; background: var(--bg); border: 1px solid var(--border); border-radius: 999px; overflow: hidden; }
.bar { height: 100%; border-radius: 999px; transition: width 0.4s ease; background: var(--emerald); }
.bar.warn { background: #f59e0b; }
.bar.bad { background: var(--rose); }
.pressure-tag { font-size: 11.5px; font-weight: 600; padding: 3px 10px; border-radius: 999px; flex: none; }
.pressure-tag.ok { background: var(--emerald-dim); color: var(--emerald-light); }
.pressure-tag.warn { background: rgba(245,158,11,0.14); color: #fbbf24; }
.pressure-tag.bad { background: rgba(244,63,94,0.12); color: var(--rose); }
.pressure-meta { font-size: 11px; color: var(--text-3); font-family: var(--mono); flex: none; }
.full { width: 100%; margin-top: 12px; }
</style>
