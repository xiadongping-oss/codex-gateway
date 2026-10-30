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

const { status, account, logs, capabilities, capabilitiesBase, gw, gwBusy, gwRestart, gwStart, gwStop, gwConnected, gwActionError, lastError, toggleCapability } =
  useLiveData()

const showSetup = ref(false)
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
  return Math.min(100, Math.round((rateLimited.value / total) * 1000) / 10)
})
const pressureLabel = computed(() => {
  if (!rateLimited.value) return '正常'
  if (limitRatio.value < 5) return '轻微'
  if (limitRatio.value < 20) return '偏高'
  return '高频限流'
})


// 认证健康：真正的登录态来自 /__gw/auth/state 的 account.loggedIn。
// 此前误用 gw.health.ok（那是 bridge 的 HTTP 存活探测），
// 结果 bridge 一停或健康检查超时，界面就误报「需重新授权」。
const authOk = computed(() => account.value?.loggedIn !== false)
</script>

<template>
  <div class="content overview">
    <div v-if="gwConnected === false || lastError" class="connection-note" role="status">无法同步网关状态，请检查服务与控制台登录状态。正在自动重试。</div>
    <div v-if="gwActionError" class="connection-note" role="alert">{{ gwActionError }}</div>
    <div class="hero-grid">
      <section class="gateway-hero" aria-label="网关运行控制">
        <div class="hero-copy">
          <span class="eyebrow">LOCAL GATEWAY <span class="hero-status" :class="{ stopped: !gw.running }"><i></i>{{ !gwConnected ? '等待连接' : gw.running ? '运行中' : '已停止' }}</span></span>
          <h2>{{ !gwConnected ? '连接你的 AI 工作站' : gw.running ? '让 AI 随时就绪' : '从这里，连接 AI' }}</h2>
          <p>{{ !gwConnected ? '正在等待本地网关返回运行状态。' : gw.running ? '本地服务已启动，统一连接你的 AI 客户端。' : '启动本地服务，开始使用你的模型与工具。' }}</p>
          <div class="hero-facts">
            <div><span>运行时长</span><strong>{{ gw.running ? fmtUptime(gw.uptimeSec || 0) : '—' }}</strong></div>
            <div><span>服务端口</span><strong>{{ status.port }}</strong></div>
            <div><span>访问地址</span><strong class="host-value">{{ status.host }}</strong></div>
          </div>
          <button class="restart-link" :disabled="gwBusy || !gw.running || !gwConnected" @click="gwRestart">↻ 重启服务</button>
        </div>
        <div class="power-area">
          <button class="power-button" :class="{ running: gw.running }" :disabled="gwBusy || !gwConnected" @click="gw.running ? gwStop() : gwStart()" :aria-label="gw.running ? '停止网关' : '启动网关'">
            <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><path d="M24 7v18M14 12a17 17 0 1020 0"/></svg>
          </button>
          <span>{{ !gwConnected ? '等待连接' : gwBusy ? '处理中…' : gw.running ? '点击停止' : '点击启动' }}</span>
        </div>
      </section>
      <section class="account-summary">
        <div class="section-top"><span>当前账号</span><span class="account-state" :class="{ missing: !authOk }">{{ authOk ? '已登录' : '待连接' }}</span></div>
        <div class="account-symbol"><svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0116 0v2"/></svg></div>
        <h3>{{ authOk ? (account.name || '当前账号') : '连接你的账号' }}</h3>
        <p class="account-description">{{ authOk ? (account.email?.includes('@') ? account.email : '已保存本机登录态') : '登录后即可调用模型、生成图片。' }}</p>
        <button class="btn-ghost" @click="showSetup = true">{{ authOk ? '管理登录' : '连接 / 登录' }} <span>↗</span></button>
      </section>
    </div>

    <div class="section-heading"><h2>使用概况</h2><span>累计用量 · 随调用更新</span></div>
    <div class="stat-grid">
      <section class="stat-card"><div class="stat-label"><span>网关调用</span><span class="stat-icon">↗</span></div><strong>{{ gwConnected ? requests.toLocaleString() : '—' }}</strong><span class="stat-foot">累计请求次数</span></section>
      <section class="stat-card"><div class="stat-label"><span>Token 用量</span><span class="stat-icon">◇</span></div><strong>{{ gwConnected ? fmtTok(gw.tokensTotal || 0) : '—' }}</strong><span class="stat-foot">输入与输出总量</span></section>
      <button class="stat-card stat-action" @click="$emit('navigate', 'apikeys')"><div class="stat-label"><span>API Key</span><span class="stat-icon">⚿</span></div><strong>{{ gwConnected ? (gw.apikeysCount || 0) : '—' }}</strong><span class="stat-foot">管理接入密钥 <span>→</span></span></button>
      <section class="stat-card"><div class="stat-label"><span>触发限流</span><span class="stat-icon">≈</span></div><strong :class="{ warning: rateLimited > 0 }">{{ gwConnected ? rateLimited : '—' }}<small>次</small></strong><span class="stat-foot">{{ gwConnected ? `占总调用 ${limitRatio}% · ${pressureLabel}` : '等待同步数据' }}</span></section>
    </div>

    <div class="section-heading"><h2>工作空间</h2><span>常用功能，一步直达</span></div>
    <div class="quick-grid">
      <button class="quick-card" @click="$emit('navigate', 'models')"><span class="quick-icon">◇</span><span><b>模型与接入</b><small>查看可用模型，连接客户端</small></span><span class="arrow">↗</span></button>
      <button class="quick-card" @click="$emit('navigate', 'images')"><span class="quick-icon mint">▧</span><span><b>图片素材</b><small>浏览生成图片与本地素材</small></span><span class="arrow">↗</span></button>
      <button class="quick-card" @click="$emit('navigate', 'logs')"><span class="quick-icon peach">≡</span><span><b>调用记录</b><small>查看请求详情与运行日志</small></span><span class="arrow">↗</span></button>
    </div>
    <QuotaMiniCard @open="$emit('navigate', 'account')" />
    <LanMiniCard @open="$emit('navigate', 'models')" />
    <details class="details-panel">
      <summary><span>运行详情</span><span>账号信息、模型能力与实例状态</span></summary>
      <div class="detail-content">
        <div class="row"><StatusCard :status="status" /><AccountCard :account="account" @manage="showSetup = true" /></div>
        <BridgePoolCard :instances="gw.bridgeInstances || []" :pool="gw.bridgePool || {}" :active-account-id="gw.activeAccountId || ''" />
        <div class="row"><ModelsCard :capabilities="capabilities" :supported="capabilitiesBase" @toggle="toggleCapability" /><LogsCard :logs="logs" /></div>
      </div>
    </details>
    <footer class="overview-footer"><span class="footer-dot"></span>你的服务，运行在本机。<span>Codex Gateway</span></footer>
    <SetupModal v-if="showSetup" @close="showSetup = false" @changed="showSetup = false" />
  </div>
</template>

<style scoped>
.overview { padding: 6px 32px 24px; gap: 18px; }
.hero-grid { display: grid; grid-template-columns: minmax(0, 2.2fr) minmax(240px, 1fr); gap: 20px; }
.gateway-hero { border-radius: 26px; background: var(--hero); padding: 28px 32px 22px; display: flex; justify-content: space-between; align-items: center; gap: 24px; }
.hero-copy { min-width: 0; }
.eyebrow { color: var(--primary); font-size: 10px; font-weight: 700; letter-spacing: 1.8px; display: flex; align-items: center; gap: 14px; }
.hero-status { font-size: 10px; letter-spacing: 0; display: inline-flex; align-items: center; gap: 5px; color: var(--success); }
.hero-status i, .footer-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.hero-status.stopped { color: var(--text-3); }
h2 { font-size: 27px; font-weight: 650; letter-spacing: -.8px; margin-top: 15px; }
.hero-copy p { color: var(--text-2); font-size: 12px; margin-top: 7px; }
.hero-facts { display: flex; gap: 30px; margin-top: 27px; }
.hero-facts div { display: flex; flex-direction: column; gap: 6px; }
.hero-facts span { font-size: 10px; color: var(--text-2); }
.hero-facts strong { font-family: var(--mono); font-size: 16px; font-weight: 500; }
.hero-facts .host-value { font-size: 13px; }
.hero-facts small { font-family: var(--sans); font-size: 10px; font-weight: 400; color: var(--text-2); }
.restart-link { background: none; border: 0; color: var(--primary); font-size: 11px; cursor: pointer; margin-top: 22px; padding: 3px 0; }
.power-area { display: flex; flex-direction: column; align-items: center; gap: 17px; flex-shrink: 0; }
.power-area > span { font-size: 11px; color: var(--text-2); }
.power-button { width: 88px; height: 88px; border-radius: 30px; border: 0; background: var(--card); color: var(--primary); cursor: pointer; box-shadow: 0 0 0 10px var(--primary-soft); transition: transform .2s; }
.power-button:hover { transform: translateY(-3px); }
.power-button.running { background: var(--primary); color: var(--on-primary); }
.power-button svg { width: 40px; height: 40px; }
.account-summary { background: var(--card); border: 1px solid var(--border); border-radius: 26px; padding: 22px; min-width: 0; }
.section-top { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--text-2); }
.account-state { background: var(--emerald-dim); color: var(--success); padding: 3px 9px; border-radius: 20px; font-size: 10px; }
.account-state.missing { color: var(--text-3); background: var(--card-2); }
.account-symbol { width: 43px; height: 43px; border-radius: 16px; background: var(--primary-soft); color: var(--primary); display: grid; place-items: center; margin: 18px 0 12px; }
.account-summary h3 { font-size: 17px; font-weight: 600; overflow-wrap: anywhere; }
.account-description { color: var(--text-3); font-size: 11px; margin-top: 5px; overflow-wrap: anywhere; }
.account-summary button { width: 100%; display: flex; justify-content: space-between; margin-top: 18px; font-size: 12px; padding: 8px 14px; }
.section-heading { display: flex; justify-content: space-between; align-items: center; margin-top: 5px; }
.section-heading h2 { font-size: 15px; letter-spacing: 0; margin: 0; }
.section-heading > span { font-size: 10px; color: var(--text-3); }
.stat-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
.stat-card { text-align: left; border: 1px solid var(--border); border-radius: 20px; padding: 18px 20px; background: var(--card); color: var(--text); min-width: 0; }
.stat-label { display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: var(--text-2); }
.stat-icon { color: var(--primary); font-size: 19px; }
.stat-card strong { display: block; font-family: var(--mono); font-size: 29px; font-weight: 500; margin: 9px 0 6px; letter-spacing: -1px; }
.stat-card strong small { font-size: 11px; color: var(--text-3); margin-left: 6px; }
.stat-foot { display: flex; justify-content: space-between; color: var(--text-3); font-size: 10px; }
.stat-action { cursor: pointer; }.stat-action:hover { border-color: var(--primary); }
.warning { color: var(--rose); }
.quick-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.quick-card { display: flex; align-items: center; gap: 12px; padding: 18px; border: 1px solid var(--border); background: var(--card); color: var(--text); border-radius: 20px; text-align: left; cursor: pointer; }
.quick-card:hover { border-color: var(--primary); }
.quick-icon { display: grid; place-items: center; width: 40px; height: 40px; flex-shrink: 0; border-radius: 14px; background: var(--primary-soft); color: var(--primary); font-size: 23px; }
.quick-icon.mint { background: var(--emerald-dim); color: var(--success); }.quick-icon.peach { background: var(--card-2); color: var(--amber); }
.quick-card b { display: block; font-size: 12px; font-weight: 600; }.quick-card small { display: block; color: var(--text-3); font-size: 10px; margin-top: 4px; }
.arrow { margin-left: auto; color: var(--text-3); }
.details-panel { border: 1px solid var(--border); border-radius: 18px; background: var(--card); }
summary { padding: 16px 20px; cursor: pointer; font-size: 12px; }summary span + span { color: var(--text-3); margin-left: 14px; font-size: 10px; }
.detail-content { padding: 0 16px 16px; display: flex; flex-direction: column; gap: 16px; }
.overview-footer { display: flex; align-items: center; gap: 7px; font-size: 10px; color: var(--text-3); padding: 0 4px; }.overview-footer > span:last-child { margin-left: auto; }
.connection-note { color: var(--amber); background: var(--card); padding: 10px 16px; border: 1px solid var(--border); border-radius: 12px; font-size: 12px; }
.overview :deep(.quota-strip), .overview :deep(.lan-strip) { border-radius: 18px; }
@media(max-width:1150px) { .gateway-hero { padding: 24px; gap: 16px; }.hero-facts { gap: 18px; }.power-button { width: 70px; height: 70px; border-radius: 24px; }.quick-card { padding: 14px; gap: 9px; }.quick-card small { font-size: 9px; } }
@media(max-width:760px) { .overview { padding: 4px 18px 20px; }.hero-grid { grid-template-columns: 1fr; }.account-summary { padding: 18px; }.stat-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }.quick-grid { grid-template-columns: 1fr; }.quick-card small { font-size: 11px; } }
@media(max-width:420px) { .gateway-hero { padding: 20px 16px; gap: 12px; }h2 { font-size: 21px; }.eyebrow { flex-wrap: wrap; gap: 5px; }.hero-facts { gap: 12px; }.hero-facts strong { font-size: 12px; }.power-button { width: 52px; height: 52px; border-radius: 20px; box-shadow: 0 0 0 5px var(--primary-soft); }.power-button svg { width: 28px; }.stat-card { padding: 14px; }summary span + span { display: block; margin: 5px 0 0; } }

@media(max-width:760px) {
  .overview :deep(.quota-strip), .overview :deep(.lan-strip) { flex-wrap: wrap; gap: 14px; }
  .overview :deep(.qs-empty) { flex-basis: 100%; }
  .overview :deep(.ls-actions) { margin-left: auto; }
  .detail-content .row > :deep(.card) { min-width: 0; flex-basis: 100%; }
  .detail-content :deep(.metrics) { flex-wrap: wrap; gap: 16px; }
  .detail-content :deep(.metric) { padding: 0; border: 0; flex-basis: 100%; }
  .stat-card strong { font-size: 25px; overflow-wrap: anywhere; }
}
</style>
