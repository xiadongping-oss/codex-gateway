<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import * as api from '../api/gateway'
import SetupModal from '../components/SetupModal.vue'
import AccountQuotaCard from '../components/AccountQuotaCard.vue'
import { useLiveData } from '../composables/useLiveData'

// 网关运行控制（自原「网关控制」页并入）
const { gw, gwBusy, gwStart, gwStop, gwRestart } = useLiveData()
const gwUptime = computed(() => {
  const s = gw.value.uptimeSec || 0
  const h = String(Math.floor(s / 3600)).padStart(2, '0')
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const sec = String(s % 60).padStart(2, '0')
  return `${h}:${m}:${sec}`
})
const gwHealthOk = computed(() => gw.value.health && gw.value.health.ok)
const gwCfg = computed(() => gw.value.config || {})

// 健康检查失败原因：/health 透传 bridge 的错误体（/__gw/status 的 health.data.error）
// 常见失败是上游地区限制（未配代理直连），这时给出可操作的指引而不是干巴巴的「失败」。
const gwHealthReason = computed(() => {
  if (gwHealthOk.value) return null
  const h = gw.value.health || {}
  if (h.timeout) return { text: '健康检查超时（bridge 无响应）', hint: '' }
  if (h.status === 0) return { text: 'bridge 端口无响应，实例可能启动失败', hint: '查看「API 日志」里的启动报错' }
  const detail = String(h.data?.error || h.error || '').trim()
  if (!detail) return null
  const regionBlock = /unsupported_country_region_territory|region_territory/i.test(detail)
  return {
    text: detail.length > 160 ? detail.slice(0, 160) + '…' : detail,
    hint: regionBlock
      ? '上游拒绝了当前网络出口（地区限制）。请在「设置 → 出网代理」配置代理并测通后重启网关。'
      : ''
  }
})

// 来自 /__gw/auth/state（含真实账号 id/name/email/provider/loggedIn）
const account = ref({ loggedIn: false, accountId: null, name: '—', provider: '—', email: '—', expiresAt: '—', detail: '' })
const health = ref(null)
const loading = ref(false)
const error = ref('')
const showSetup = ref(false)
const mode = ref('bridge')
const accounts = ref([])
const activeId = ref(null)
const editingId = ref(null)
const editName = ref('')
const editNote = ref('')
const fetchErr = ref('')
const timers = []

// 诊断卡片助手：秒数人性化 + ISO 转本地时间
function fmtDur(sec) {
  sec = Number(sec) || 0
  if (sec >= 86400) return `${Math.floor(sec / 86400)} 天 ${Math.floor((sec % 86400) / 3600)} 小时`
  if (sec >= 3600) return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分钟`
  if (sec >= 60) return `${Math.floor(sec / 60)} 分钟`
  return `${sec} 秒`
}
function fmtTime(iso) {
  const d = new Date(iso)
  if (isNaN(d)) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// 检测连接的显式反馈：此前只更新页面底部的「连接诊断」卡片，正常时肉眼无感知。
// 现在检测完成在按钮行下直接给一条结果横条（成功/失败 + 关键摘要），10 秒后淡出。
const diagResult = ref(null)
let diagTimer = null

// 8 秒定时刷新与手动操作（切换 / 删除 / 重命名后都会 refresh）会重叠。
// 网络慢时先发的旧响应可能后到，把刚切换完的新状态覆盖回去 ——
// 典型表现就是「明明点了切换，『当前』标记却还在旧账号上」。
// 用单调递增的序号作废过期响应：只有最后一次发起的刷新有权写状态。
let refreshSeq = 0
const isStale = (seq) => typeof seq === 'number' && seq !== refreshSeq

async function diagnose(seq = null) {
  loading.value = true
  error.value = ''
  try {
    const h = await api.diagnose()
    const acc = await api.getAccount()
    const s = await api.getAuthState().catch(() => null)
    if (isStale(seq)) return
    health.value = h
    account.value = acc
    if (s?.mode) mode.value = s.mode
    const bridgeOk = health.value?.ok === true
    const parts = []
    if (health.value?.version) parts.push('bridge v' + health.value.version)
    parts.push(account.value?.loggedIn ? '账号登录有效' : '账号未登录')
    if (bridgeOk && account.value?.loggedIn && gwHealthOk.value) parts.push('上游健康检查通过')
    diagResult.value = {
      ok: bridgeOk && !!account.value?.loggedIn,
      text: bridgeOk
        ? '连接正常 · ' + parts.join(' · ')
        : '桥接进程异常' + (health.value?.error ? '：' + String(health.value.error).slice(0, 120) : '')
    }
    clearTimeout(diagTimer)
    diagTimer = setTimeout(() => (diagResult.value = null), 10000)
  } catch (e) {
    if (isStale(seq)) return
    error.value = e?.message || '诊断失败'
    fetchErr.value = error.value
    diagResult.value = { ok: false, text: '检测失败：' + (e?.message || '网关控制接口无响应') }
    clearTimeout(diagTimer)
    diagTimer = setTimeout(() => (diagResult.value = null), 10000)
  } finally {
    if (!isStale(seq)) loading.value = false
  }
}

async function loadAccounts(seq = null) {
  fetchErr.value = ''
  try {
    const a = await api.getAccounts()
    if (isStale(seq)) return
    if (a && Array.isArray(a.accounts)) {
      accounts.value = a.accounts
      activeId.value = a.activeId
      return
    }
    // 拉取失败不要清空已有列表：一次网络抖动就让账号页变成「尚无账号」，
    // 用户会以为数据被删了。保留上一次的结果 + 顶部提示更诚实。
    if (!a) { fetchErr.value = '账号列表拉取失败'; return }
    accounts.value = []
    activeId.value = null
  } catch (e) {
    fetchErr.value = e?.message || '账号列表拉取失败'
  }
}

async function refresh() {
  const seq = ++refreshSeq
  await diagnose(seq)
  await loadAccounts(seq)
}

async function switchTo(id) {
  loading.value = true
  error.value = ''
  try {
    await api.activateAccount(id)
    await refresh()
  } catch (e) {
    error.value = e?.message || '切换失败'
  } finally {
    loading.value = false
  }
}

async function removeAcc(id) {
  if (typeof window !== 'undefined' && !window.confirm('确定删除该账号？该操作不可撤销。')) return
  loading.value = true
  error.value = ''
  try {
    await api.removeAccount(id)
    await refresh()
  } catch (e) {
    error.value = e?.message || '删除失败'
  } finally {
    loading.value = false
  }
}

function startEdit(a) {
  editingId.value = a.id
  editName.value = a.name || ''
  editNote.value = a.note || ''
}
function cancelEdit() {
  editingId.value = null
  editName.value = ''
  editNote.value = ''
}
async function saveEdit(id) {
  loading.value = true
  error.value = ''
  try {
    await api.renameAccount(id, { name: editName.value, note: editNote.value })
    editingId.value = null
    await refresh()
  } catch (e) {
    error.value = e?.message || '保存失败'
  } finally {
    loading.value = false
  }
}

const providerLabel = (p) => ({ oauth: 'OAuth', token: 'Token', import: '导入', apikey: 'API Key' }[p] || p || '—')

// 「导入本机登录」快捷按钮已移除：功能与「添加账号 → 导入」标签页完全重复，
// 且该标签页还支持文件导入 / 官方登录 / Token 粘贴等更多入口，保留一处即可。

onMounted(() => {
  refresh()
  timers.push(setInterval(refresh, 8000))
})
onUnmounted(() => {
  timers.forEach(clearInterval)
  // diagTimer 是 setTimeout，上面只清了 setInterval —— 组件卸载后它仍会写 ref
  clearTimeout(diagTimer)
})
</script>

<template>
  <div class="content">
    <!-- 顶部双列：账号（状态头+列表） | 网关运行控制 -->
    <div class="grid-top">
    <div class="card">
      <div class="acc-title-row">
        <div class="card-title">账号 <span class="count">{{ accounts.length }}</span></div>
        <div class="acc-head-actions">
          <button class="btn-ghost" @click="diagnose" :disabled="loading">{{ loading ? '检测中…' : '检测连接' }}</button>
          <button class="btn-primary" @click="showSetup = true">添加账号</button>
        </div>
      </div>

      <!-- 检测连接结果横条：显式反馈，10 秒后自动淡出 -->
      <div v-if="diagResult" class="diag-result" :class="diagResult.ok ? 'ok' : 'bad'">
        <span class="status-dot" :class="{ off: !diagResult.ok }"></span>
        <span class="diag-text">{{ diagResult.text }}</span>
      </div>

      <!-- 仅异常 / 特殊模式显示状态条；正常登录态由当前账号行直接呈现，避免重复 -->
      <div v-if="mode === 'openai' || !account.loggedIn || !accounts.length" class="conn-state" :class="account.loggedIn ? 'ok' : 'bad'">
        <span class="status-dot" :class="{ off: !account.loggedIn }"></span>
        <div class="conn-main">
          <div class="cs-name">
            <template v-if="account.loggedIn">
              <span class="cs-name-text">{{ account.name }}</span>
              <span class="prov" :class="'prov-' + account.provider">{{ providerLabel(account.provider) }}</span>
              <!-- 此前这里恒显示「API Key 模式」：只要 account.loggedIn 为真就渲染，
                   于是在 bridge 模式 + 已登录 + 列表为空时也会谎报模式。 -->
              <span class="mode-badge">{{ mode === 'openai' ? 'API Key 模式' : 'Bridge 模式' }}</span>
            </template>
            <template v-else>
              <span class="cs-name-text">{{ account.detail || '尚未配置账号' }}</span>
              <span class="mode-badge">{{ mode === 'openai' ? 'API Key' : 'Bridge' }}</span>
            </template>
          </div>
          <div class="cs-mail">{{ account.loggedIn ? account.email : '点击「添加账号」完成授权' }}</div>
        </div>
      </div>
      <div v-if="error" class="modal-error">{{ error }}</div>

      <div v-if="!accounts.length" class="empty">
        <template v-if="fetchErr">拉取账号列表失败：{{ fetchErr }}</template>
        <template v-else>尚无账号，点击「添加账号」创建第一个。</template>
      </div>

      <div v-for="a in accounts" :key="a.id" class="acc-row" :class="{ active: a.id === activeId }">
        <span class="acc-dot" :class="{ off: !a.hasAuth }"></span>
        <div class="acc-main">
          <template v-if="editingId === a.id">
            <div class="acc-edit-row">
              <input class="acc-edit" v-model="editName" maxlength="40" placeholder="账号名称" @keyup.enter="saveEdit(a.id)" />
              <input class="acc-edit acc-edit-note" v-model="editNote" maxlength="120" placeholder="备注（可选）" @keyup.enter="saveEdit(a.id)" />
              <button class="btn-primary sm" :disabled="loading" @click="saveEdit(a.id)">保存</button>
              <button class="btn-ghost sm" :disabled="loading" @click="cancelEdit">取消</button>
            </div>
          </template>
          <template v-else>
            <div class="acc-name-row">
              <span class="acc-name" :title="a.name">{{ a.name }}</span>
              <span class="prov" :class="'prov-' + a.provider">{{ providerLabel(a.provider) }}</span>
              <span v-if="a.id === activeId" class="cur">当前</span>
            </div>
            <div class="acc-meta">
              <span class="acc-auth" :class="a.hasAuth ? 'ok' : 'bad'">{{ a.hasAuth ? '登录态有效' : '无登录态' }}</span>
              <span v-if="a.note" class="acc-note" :title="a.note">· {{ a.note }}</span>
            </div>
          </template>
        </div>
        <div class="acc-actions" v-if="editingId !== a.id">
          <button
            v-if="a.id !== activeId"
            class="btn-ghost sm"
            :disabled="loading"
            @click="switchTo(a.id)"
          >切换</button>
          <button class="btn-ghost sm" :disabled="loading" @click="startEdit(a)">重命名</button>
          <button
            class="btn-del sm"
            :disabled="loading || accounts.length <= 1"
            :title="accounts.length <= 1 ? '至少保留一个账号' : '删除该账号'"
            @click="removeAcc(a.id)"
          >删除</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="gw-head">
        <div class="card-title">
          网关运行控制
          <span class="gw-badge" :class="gw.running ? 'on' : 'off'">
            <span class="gw-dot"></span>{{ gw.running ? '运行中' : '已停止' }}
          </span>
        </div>
        <div class="gw-actions">
          <button v-if="!gw.running" class="btn-primary" :disabled="gwBusy" @click="gwStart">启动网关</button>
          <button v-else class="btn-ghost" :disabled="gwBusy" @click="gwStop">停止网关</button>
          <button class="btn-ghost" :disabled="gwBusy" @click="gwRestart">重启网关</button>
        </div>
      </div>
      <div class="gw-state">
        <span>PID <b class="mono">{{ gw.pid || '—' }}</b></span>
        <span>运行时长 <b class="mono">{{ gw.running ? gwUptime : '—' }}</b></span>
        <span>健康检查 <b :class="gwHealthOk ? 'ok' : 'bad'">{{ gwHealthOk ? '通过' : (gw.running ? '失败' : '—') }}</b></span>
        <span>Bridge 端口 <b class="mono">{{ gwCfg.bridgePort || '—' }}</b></span>
        <span>开机自启 <b :class="gwCfg.autoStart ? 'ok' : 'bad'">{{ gwCfg.autoStart ? '是' : '否' }}</b></span>
      </div>
      <div v-if="gwHealthReason" class="gw-health-reason">
        <div class="reason-text">{{ gwHealthReason.text }}</div>
        <div v-if="gwHealthReason.hint" class="reason-hint">{{ gwHealthReason.hint }}</div>
      </div>
    </div>
    </div>

    <div class="grid2">
      <AccountQuotaCard />

      <div class="card" v-if="health">
        <div class="card-title">连接诊断</div>
        <div class="health-status" :class="health.ok === true ? 'ok' : 'bad'">
          {{ health.ok === true ? '✓ 桥接进程正常' : '✗ 桥接进程异常' }}
          <span v-if="health.version">· bridge v{{ health.version }}</span>
        </div>
        <div v-if="health.error" class="health-row">
          <span class="h-name">错误</span>
          <span class="h-ok bad">✗</span>
          <span class="h-detail">{{ health.error }}</span>
        </div>
        <template v-if="health.auth">
          <div class="health-row">
            <span class="h-name">登录凭据</span>
            <span class="h-ok" :class="health.auth.loaded ? 'ok' : 'bad'">{{ health.auth.loaded ? '✓ 已加载' : '✗ 未加载' }}</span>
            <span class="h-detail">{{ health.auth.loaded ? 'OAuth 凭据有效，可以发起真实请求' : '缺少有效凭据，请点「添加账号」重新授权' }}</span>
          </div>
          <div class="health-row">
            <span class="h-name">访问令牌</span>
            <span class="h-ok" :class="(health.auth.expires_in_seconds ?? 0) > 0 ? 'ok' : 'bad'">{{ (health.auth.expires_in_seconds ?? 0) > 0 ? '✓' : '✗' }}</span>
            <span class="h-detail">
              {{ (health.auth.expires_in_seconds ?? 0) > 0 ? '剩余 ' + fmtDur(health.auth.expires_in_seconds) : '已过期，需重新授权' }}
              <template v-if="health.auth.last_refresh">· 上次刷新 {{ fmtTime(health.auth.last_refresh) }}</template>
            </span>
          </div>
        </template>
        <div v-if="health.rate_limit" class="health-row">
          <span class="h-name">本地保护</span>
          <span class="h-ok ok">✓</span>
          <span class="h-detail">本小时已转发 {{ health.rate_limit.hourly_used ?? 0 }} / {{ health.rate_limit.hourly_hard ?? '—' }} 次（网关自身防刷阈值，非账号额度）</span>
        </div>
      </div>
    </div>

    <SetupModal
      v-if="showSetup"
      @close="showSetup = false"
      @changed="refresh"
    />
  </div>
</template>

<style scoped>
/* 顶部双列：账号 | 网关运行控制（分栏比例与下方 .grid2 一致，保证上下两行沟壑对齐） */
.grid-top { display: grid; grid-template-columns: 1.05fr 1fr; gap: 18px; align-items: stretch; }
@media (max-width: 1100px) { .grid-top { grid-template-columns: 1fr; } }

/* 双列卡片网格：额度 | 连接诊断 */
.grid2 { display: grid; grid-template-columns: 1.05fr 1fr; gap: 18px; align-items: start; }

/* ---- 账号卡标题行：标题 + 操作按钮同行 ---- */
.acc-title-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.acc-head-actions { display: flex; gap: 10px; flex-shrink: 0; }
/* 检测连接结果横条 */
.diag-result {
  display: flex; align-items: center; gap: 10px; margin-bottom: 12px;
  padding: 9px 14px; border-radius: 10px; font-size: 13px;
  border: 1px solid var(--border); background: var(--card-2, rgba(16,185,129,0.06));
}
.diag-result.ok { border-color: rgba(16,185,129,0.35); }
.diag-result.bad { border-color: rgba(244,63,94,0.4); background: rgba(244,63,94,0.07); }
.diag-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2, var(--text)); }
.conn-state {
  display: flex; align-items: center; gap: 12px; padding: 12px 16px; min-width: 0; flex: 1;
  border: 1px solid var(--border); border-radius: 12px;
}
.conn-state.ok { border-color: var(--emerald); background: var(--emerald-dim); }
.conn-main { min-width: 0; }
.cs-name { font-size: 13.5px; font-weight: 600; display: flex; align-items: center; gap: 8px; min-width: 0; }
.cs-name-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mode-badge {
  font-size: 11px; font-weight: 600; color: #34d399; flex-shrink: 0;
  background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.3);
  border-radius: 6px; padding: 1px 7px;
}
.cs-mail { font-size: 12px; color: var(--text-3); font-family: var(--mono); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---- 账号列表行 ---- */
.count {
  font-size: 12px; color: var(--text-3); background: var(--bg);
  border: 1px solid var(--border-strong); border-radius: 999px; padding: 0 8px; margin-left: 6px;
}
.empty { font-size: 12.5px; color: var(--text-3); padding: 10px 0; }
.acc-row {
  display: flex; align-items: center; gap: 12px; padding: 13px 14px;
  border: 1px solid var(--border); border-radius: 12px; margin-bottom: 10px;
  background: var(--bg);
}
.acc-row:last-child { margin-bottom: 0; }
.acc-row.active { border-color: var(--emerald); background: var(--emerald-dim); }
.acc-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--emerald); flex: none; }
.acc-dot.off { background: var(--text-3); }
.acc-main { flex: 1; min-width: 0; }
.acc-name-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.acc-name { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.acc-meta {
  display: flex; align-items: center; gap: 6px; margin-top: 3px;
  font-size: 11.5px; font-family: var(--mono); min-width: 0;
}
.acc-auth { flex-shrink: 0; }
.acc-auth.ok { color: var(--emerald-light); }
.acc-auth.bad { color: var(--amber); }
.acc-note { color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.acc-actions { display: flex; gap: 8px; flex: none; }
.btn-ghost.sm { padding: 6px 10px; font-size: 11.5px; }

/* 行内编辑：名称 / 备注横排 + 按钮右侧 */
.acc-edit-row { display: flex; align-items: center; gap: 8px; }
.acc-edit {
  flex: 1; min-width: 0; box-sizing: border-box;
  font-size: 13px; color: var(--text); background: var(--card);
  border: 1px solid var(--border-strong); border-radius: 8px;
  padding: 7px 10px; outline: none;
}
.acc-edit:focus { border-color: var(--emerald); }
.acc-edit-note { font-size: 12px; color: var(--text-2); }

.prov {
  font-size: 10.5px; font-weight: 600; border-radius: 6px; padding: 1px 6px; flex-shrink: 0;
  color: #9aa0a8; background: rgba(154, 160, 168, 0.12); border: 1px solid rgba(154, 160, 168, 0.25);
}
.prov-oauth { color: #34d399; background: rgba(16, 185, 129, 0.12); border-color: rgba(16, 185, 129, 0.3); }
.prov-apikey { color: #60a5fa; background: rgba(96, 165, 250, 0.12); border-color: rgba(96, 165, 250, 0.3); }
.cur {
  font-size: 10.5px; font-weight: 600; color: #34d399; flex-shrink: 0;
  background: rgba(16, 185, 129, 0.18); border: 1px solid rgba(16, 185, 129, 0.4);
  border-radius: 6px; padding: 1px 6px;
}
.btn-del {
  background: transparent; color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.35);
  border-radius: 8px; padding: 6px 10px; font-size: 11.5px; cursor: pointer;
}
.btn-del:hover:not(:disabled) { background: rgba(239, 68, 68, 0.12); }
.btn-del:disabled { opacity: 0.4; cursor: not-allowed; }

/* ---- 连接诊断 ---- */
.health-status { font-size: 13px; font-weight: 600; margin: 6px 0 12px; }
.health-status.ok { color: var(--emerald-light); }
.health-status.bad { color: var(--rose); }
.health-row { display: flex; align-items: center; gap: 10px; padding: 5px 0; font-size: 12px; }
.h-name { font-family: var(--mono); color: var(--text-2); width: 64px; flex-shrink: 0; }
.h-ok { font-weight: 700; flex-shrink: 0; }
.h-ok.ok { color: var(--emerald-light); }
.h-ok.bad { color: var(--rose); }
.h-detail { color: var(--text-3); font-family: var(--mono); font-size: 11px; flex: 1; min-width: 0; }
.mono { font-family: var(--mono); font-size: 11px; color: var(--emerald-light); }

/* ---- 网关运行控制 ---- */
.gw-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.gw-badge {
  display: inline-flex; align-items: center; gap: 7px;
  font-size: 11px; font-weight: 600; padding: 2px 10px;
  border-radius: 999px; margin-left: 8px; vertical-align: 1px;
}
.gw-badge.on { background: var(--emerald-dim); color: var(--emerald-light); }
.gw-badge.off { background: rgba(244, 63, 94, 0.12); color: var(--rose); }
.gw-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.gw-actions { display: flex; gap: 10px; }
.gw-state {
  display: flex; gap: 10px 18px; flex-wrap: wrap; padding: 12px 14px; margin-top: 12px;
  background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
  font-size: 12px; color: var(--text-2);
}
.gw-state b { color: var(--text); font-weight: 600; }
.gw-state b.ok { color: var(--emerald-light); }
.gw-state b.bad { color: var(--rose); }
/* 健康检查失败原因：把 /health 的上游错误原样带出，地区限制时给代理指引 */
.gw-health-reason {
  margin-top: 8px; padding: 10px 14px;
  background: color-mix(in srgb, var(--rose) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--rose) 30%, transparent);
  border-radius: 10px; font-size: 12px; line-height: 1.6;
}
.gw-health-reason .reason-text { color: var(--text-2); word-break: break-all; }
.gw-health-reason .reason-hint { color: var(--rose); font-weight: 600; }
</style>
