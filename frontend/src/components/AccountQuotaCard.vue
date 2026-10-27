<script setup>
// 账号额度卡片（cockpit tools 同款）
// 数据来自 /__gw/account/quota：真实账号身份 + 本地维护的订阅/用量配置。
import { ref, computed, onMounted, onUnmounted } from 'vue'
import * as api from '../api/gateway'

const q = ref(null)
const loading = ref(false)
const err = ref('')
const saving = ref(false)
let timer = null

const weekly = computed(() => q.value?.weekly || null)
const models = computed(() => (Array.isArray(q.value?.models) ? q.value.models : []))
const plan = computed(() => q.value?.plan || null)
const account = computed(() => q.value?.account || null)

// 订阅临期：<=3 天告警，已过期报错
const planUrgent = computed(() => {
  const d = plan.value?.expiresInDays
  if (typeof d !== 'number') return ''
  if (d < 0) return 'rose'
  if (d <= 3) return 'amber'
  return ''
})

const initial = computed(() => {
  const n = account.value?.name || account.value?.email || '?'
  return String(n).trim().charAt(0).toUpperCase()
})

// 掩码邮箱，避免整屏暴露
const maskedEmail = computed(() => {
  const e = account.value?.email || ''
  if (!e || e === '—' || !e.includes('@')) return e || '—'
  const [u, d] = e.split('@')
  const head = u.slice(0, 2)
  const tail = u.length > 4 ? u.slice(-1) : ''
  return `${head}${'*'.repeat(Math.max(2, u.length - 3))}${tail}@${d}`
})

// 配置来源：account = 该账号专属；shared = 所有账号共用
const isOwn = computed(() => q.value?.scope === 'account')
const syncedText = computed(() => {
  const t = q.value?.syncedAt ? new Date(q.value.syncedAt) : null
  if (!t || isNaN(t)) return ''
  const p2 = (n) => String(n).padStart(2, '0')
  return `${p2(t.getHours())}:${p2(t.getMinutes())}`
})

// ---- 编辑态 ----
const editing = ref(false)
const draft = ref(null)

const pad = (n) => String(n).padStart(2, '0')
function toLocalInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const toDateInput = (iso) => { const v = toLocalInput(iso); return v ? v.slice(0, 10) : '' }
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null)
const fromDateInput = (v) => (v ? new Date(v + 'T00:00:00').toISOString() : null)

function startEdit() {
  const e = (q.value && q.value.editable) || {}
  draft.value = {
    teamName: e.teamName || '',
    accountType: (q.value && q.value.accountType) || '标准',
    plan: {
      name: (e.plan && e.plan.name) || '',
      multiplier: (e.plan && e.plan.multiplier) || '',
      expiresAt: toDateInput(e.plan && e.plan.expiresAt)
    },
    weekly: {
      label: (e.weekly && e.weekly.label) || 'Weekly',
      usedPercent: Number(e.weekly && e.weekly.usedPercent) || 0,
      resetText: (e.weekly && e.weekly.resetText) || '',
      resetsAt: toLocalInput(e.weekly && e.weekly.resetsAt)
    },
    models: (Array.isArray(e.models) ? e.models : []).map((m) => ({
      id: m.id || '',
      label: m.label || '',
      usedPercent: Number(m.usedPercent) || 0,
      resetText: m.resetText || '',
      resetsAt: toLocalInput(m.resetsAt)
    }))
  }
  editing.value = true
}
function cancelEdit() {
  editing.value = false
  draft.value = null
}
function addModelRow() {
  draft.value.models.push({ id: '', label: '', usedPercent: 0, resetText: '', resetsAt: '' })
}
function removeModelRow(i) {
  draft.value.models.splice(i, 1)
}
async function saveEdit() {
  if (saving.value || !draft.value) return
  saving.value = true
  const d = draft.value
  const r = await api.saveAccountQuota({
    teamName: d.teamName,
    accountType: d.accountType,
    plan: { name: d.plan.name, multiplier: d.plan.multiplier, expiresAt: fromDateInput(d.plan.expiresAt) },
    weekly: {
      label: d.weekly.label,
      usedPercent: d.weekly.usedPercent,
      resetText: d.weekly.resetText,
      resetsAt: fromLocalInput(d.weekly.resetsAt)
    },
    models: d.models.map((m) => ({
      id: m.id,
      label: m.label,
      usedPercent: m.usedPercent,
      resetText: m.resetText,
      resetsAt: fromLocalInput(m.resetsAt)
    }))
  }).catch(() => null)
  if (r) {
    q.value = r
    editing.value = false
    draft.value = null
  } else {
    err.value = '保存失败，请重试'
  }
  saving.value = false
}

const updatedText = computed(() => {
  const iso = q.value?.updatedAt
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('zh-CN', { hour12: false })
})

async function load() {
  const r = await api.getAccountQuota().catch(() => null)
  if (!r) {
    err.value = '额度数据拉取失败'
    return
  }
  err.value = ''
  q.value = r
}

async function refresh() {
  loading.value = true
  await load()
  loading.value = false
}

async function onTypeChange(e) {
  const v = e?.target?.value
  if (!v || !q.value || v === q.value.accountType) return
  saving.value = true
  const r = await api.saveAccountQuota({ accountType: v }).catch(() => null)
  if (r) q.value = r
  saving.value = false
}

// 丢弃本账号专属配置，回落共用缺省
async function resetToShared() {
  if (saving.value) return
  saving.value = true
  const r = await api.saveAccountQuota({ reset: true }).catch(() => null)
  if (r) q.value = r
  saving.value = false
}

onMounted(() => {
  refresh()
  timer = setInterval(load, 30000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="card">
    <div class="q-head">
      <div class="card-title">账号额度</div>
      <span v-if="q && q.demo" class="demo-tag">示例数据</span>
      <span v-if="q" class="scope-tag" :class="isOwn ? 'own' : 'shared'">
        {{ isOwn ? '本账号专属' : '共用配置' }}
      </span>
      <span v-if="saving" class="saving-tag">保存中…</span>
      <span class="head-meta">更新于 {{ updatedText }}</span>
      <button v-if="q && !editing" class="btn-ghost sm" @click="startEdit" :disabled="saving">编辑</button>
      <button class="btn-ghost sm" @click="refresh" :disabled="loading || editing">
        {{ loading ? '刷新中…' : '刷新' }}
      </button>
    </div>

    <div v-if="err" class="q-err">{{ err }}</div>

    <template v-if="q">
      <!-- 身份 + 订阅 -->
      <div class="q-id">
        <div class="avatar">{{ initial }}</div>
        <div class="id-main">
          <div class="id-name">
            {{ account.name }}
            <span v-if="plan && plan.badge && plan.badge !== '—'" class="plan-badge">{{ plan.badge }}</span>
            <span v-if="planUrgent" class="expire-chip" :class="planUrgent">
              {{ planUrgent === 'rose' ? '订阅已过期' : '订阅 ' + plan.expiresInText }}
            </span>
            <span v-if="q.source === 'realtime'" class="rt-chip" title="用量来自 Codex 上游限流头，真实调用后自动更新">实时同步<span v-if="syncedText"> · {{ syncedText }}</span></span>
            <span v-if="q.sample" class="sample-chip" title="当前是示例数据，点右上角「编辑」填入真实值后保存，此标签自动消失">示例数据</span>
          </div>
          <div class="id-mail">{{ maskedEmail }}</div>
        </div>
      </div>

      <div class="q-meta">
        <div class="meta-item">
          <span class="k">团队</span>
          <span class="v">{{ account.teamName }}</span>
        </div>
        <div class="meta-item">
          <span class="k">账号 ID</span>
          <span class="v mono">{{ account.userId }}</span>
        </div>
        <div class="meta-item">
          <span class="k">订阅到期</span>
          <span class="v" :class="planUrgent">{{ plan.expiresInText }}</span>
        </div>
        <div class="meta-item">
          <span class="k">账号类型</span>
          <select class="type-select" :value="q.accountType" @change="onTypeChange" :disabled="saving">
            <option v-for="t in (q.accountTypes || ['标准'])" :key="t" :value="t">{{ t }}</option>
          </select>
          <button v-if="isOwn" class="link-btn" :disabled="saving" @click="resetToShared">改用共用配置</button>
        </div>
      </div>

      <!-- 编辑态 -->
      <div v-if="editing && draft" class="q-edit">
        <div class="ed-sec">
          <div class="ed-title">订阅</div>
          <div class="ed-row">
            <label class="ed-f"><span>等级</span><input v-model="draft.plan.name" placeholder="PRO" /></label>
            <label class="ed-f"><span>倍率</span><input v-model="draft.plan.multiplier" placeholder="20X" /></label>
            <label class="ed-f"><span>到期日</span><input type="date" v-model="draft.plan.expiresAt" /></label>
            <label class="ed-f"><span>团队</span><input v-model="draft.teamName" placeholder="个人账户" /></label>
          </div>
        </div>

        <div class="ed-sec">
          <div class="ed-title">周用量</div>
          <div class="ed-row">
            <label class="ed-f"><span>名称</span><input v-model="draft.weekly.label" /></label>
            <label class="ed-f wide"><span>已用 {{ draft.weekly.usedPercent }}%</span>
              <span class="pct">
                <input type="range" min="0" max="100" v-model.number="draft.weekly.usedPercent" />
                <input class="num" type="number" min="0" max="100" v-model.number="draft.weekly.usedPercent" />
              </span>
            </label>
          </div>
          <div class="ed-row">
            <label class="ed-f"><span>重置时刻</span><input type="datetime-local" v-model="draft.weekly.resetsAt" /></label>
            <label class="ed-f"><span>兜底文案</span><input v-model="draft.weekly.resetText" placeholder="未设时刻时显示" /></label>
          </div>
        </div>

        <div class="ed-sec">
          <div class="ed-title">模型用量</div>
          <div v-for="(m, i) in draft.models" :key="i" class="ed-model">
            <div class="ed-row">
              <label class="ed-f wide"><span>名称</span><input v-model="m.label" placeholder="如 GPT 5.6 Sol 5h" /></label>
              <label class="ed-f wide"><span>已用 {{ m.usedPercent }}%</span>
                <span class="pct">
                  <input type="range" min="0" max="100" v-model.number="m.usedPercent" />
                  <input class="num" type="number" min="0" max="100" v-model.number="m.usedPercent" />
                </span>
              </label>
            </div>
            <div class="ed-row">
              <label class="ed-f"><span>重置时刻</span><input type="datetime-local" v-model="m.resetsAt" /></label>
              <label class="ed-f"><span>兜底文案</span><input v-model="m.resetText" placeholder="如 4h 59m" /></label>
              <button class="btn-del sm" @click="removeModelRow(i)">删除</button>
            </div>
          </div>
          <button class="btn-ghost sm" @click="addModelRow">+ 添加模型</button>
        </div>

        <div class="ed-actions">
          <button class="btn-primary sm" :disabled="saving" @click="saveEdit">{{ saving ? '保存中…' : '保存' }}</button>
          <button class="btn-ghost sm" :disabled="saving" @click="cancelEdit">取消</button>
          <span class="ed-hint">保存到当前激活账号（{{ q.accountId || '—' }}）</span>
        </div>
      </div>

      <template v-else>
      <!-- 周用量 -->
      <div class="q-block" v-if="weekly">
        <div class="blk-head">
          <span class="blk-label">{{ weekly.label }}</span>
          <span class="blk-remain" :class="weekly.tone">剩余 {{ weekly.remainingPercent }}%</span>
        </div>
        <div class="bar">
          <div class="bar-fill" :class="weekly.tone" :style="{ width: weekly.remainingPercent + '%' }"></div>
        </div>
        <div class="blk-foot">
          <span>已用 {{ weekly.usedPercent }}%</span>
          <span class="dot-sep">·</span>
          <span>{{ weekly.resetIn }}后重置</span>
        </div>
      </div>

      <!-- 模型级用量 -->
      <div class="q-block" v-if="models.length">
        <div class="blk-title">模型用量</div>
        <div v-for="m in models" :key="m.id || m.label" class="m-row">
          <div class="m-head">
            <span class="m-label">{{ m.label }}</span>
            <span class="m-remain" :class="m.tone">剩余 {{ m.remainingPercent }}%</span>
          </div>
          <div class="bar sm">
            <div class="bar-fill" :class="m.tone" :style="{ width: m.remainingPercent + '%' }"></div>
          </div>
          <div class="m-foot">
            <span>已用 {{ m.usedPercent }}%</span>
            <span class="dot-sep">·</span>
            <span>{{ m.resetIn }}后重置</span>
          </div>
        </div>
      </div>
      </template>

      <div class="q-note">
        身份（账号名 / 邮箱 / ID）来自本地登录态；订阅与用量为本地维护数据，ChatGPT 未公开对应接口。
        额度按账号隔离，点「编辑」直接在卡片里改，保存到当前激活账号名下（<code>accounts[账号id]</code>）；
        <code>shared</code> 为所有账号共用缺省。也可直接改 <code>gateway/data/account-quota.json</code>。
      </div>
    </template>

    <div v-else-if="loading" class="q-empty">加载中…</div>
    <div v-else class="q-empty">暂无额度数据</div>
  </div>
</template>

<style scoped>
.q-head { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
.head-meta { margin-left: auto; font-size: 11px; color: var(--text-3); font-family: var(--mono); }
.demo-tag {
  font-size: 10.5px; font-weight: 600; color: var(--amber);
  background: rgba(251, 191, 36, 0.14); border: 1px solid rgba(251, 191, 36, 0.35);
  border-radius: 6px; padding: 1px 7px;
}
.saving-tag { font-size: 10.5px; color: var(--text-3); }
.rt-chip {
  font-size: 10.5px; font-weight: 600; border-radius: 6px; padding: 1px 7px;
  color: #34d399; background: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.35);
}
.sample-chip {
  font-size: 10.5px; font-weight: 600; border-radius: 6px; padding: 1px 7px; cursor: help;
  color: #fbbf24; background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.35);
}
.scope-tag { font-size: 10.5px; font-weight: 600; border-radius: 6px; padding: 1px 7px; }
.scope-tag.own { color: var(--emerald-light); background: rgba(16,185,129,0.12); border: 1px solid rgba(16,185,129,0.3); }
.scope-tag.shared { color: var(--text-2); background: rgba(255,255,255,0.06); border: 1px solid var(--border-strong); }
.link-btn {
  font-family: inherit; font-size: 11px; color: var(--text-3); background: none;
  border: none; padding: 0 2px; cursor: pointer; text-decoration: underline;
}
.link-btn:hover:not(:disabled) { color: var(--emerald-light); }
.link-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-ghost.sm { padding: 5px 10px; font-size: 11.5px; background: var(--card-2); color: var(--text-2); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; }
.btn-ghost.sm:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.q-err { font-size: 12px; color: var(--rose); margin-bottom: 12px; }
.q-empty { font-size: 12.5px; color: var(--text-3); padding: 8px 0; }

/* 身份 */
.q-id { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.avatar {
  width: 42px; height: 42px; border-radius: 12px; flex-shrink: 0;
  background: linear-gradient(135deg, #10b981, #0ea5e9);
  display: flex; align-items: center; justify-content: center;
  font-size: 16px; font-weight: 600; color: #04130d;
}
.id-main { min-width: 0; }
.id-name { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.id-mail { font-size: 11.5px; color: var(--text-3); font-family: var(--mono); margin-top: 2px; }
.plan-badge {
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.02em;
  color: #04130d; background: var(--emerald);
  border-radius: 6px; padding: 1px 7px;
}
.expire-chip {
  font-size: 10.5px; font-weight: 600; border-radius: 6px; padding: 1px 7px;
  color: var(--amber); background: rgba(251, 191, 36, 0.14); border: 1px solid rgba(251, 191, 36, 0.35);
}
.expire-chip.rose { color: var(--rose); background: rgba(244, 63, 94, 0.14); border-color: rgba(244, 63, 94, 0.35); }

/* 元信息 */
.q-meta {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px 18px; padding: 14px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
}
.meta-item { display: flex; align-items: center; gap: 8px; min-width: 0; }
.meta-item .k { font-size: 11.5px; color: var(--text-3); flex: none; }
.meta-item .v { font-size: 12.5px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-item .v.amber { color: var(--amber); }
.meta-item .v.rose { color: var(--rose); }
.mono { font-family: var(--mono); font-size: 11.5px; }
.type-select {
  font-family: inherit; font-size: 12px; color: var(--text);
  background: var(--card-2); border: 1px solid var(--border-strong);
  border-radius: 7px; padding: 3px 8px; outline: none; cursor: pointer;
}
.type-select:focus { border-color: var(--emerald); }
.type-select:disabled { opacity: 0.5; cursor: not-allowed; }

/* 用量块 */
.q-block { padding: 16px 0 0; }
.blk-title { font-size: 12px; color: var(--text-3); margin-bottom: 10px; }
.blk-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
.blk-label { font-size: 13px; font-weight: 600; }
.blk-remain { font-family: var(--mono); font-size: 15px; font-weight: 500; }
.blk-remain.emerald, .m-remain.emerald { color: var(--emerald-light); }
.blk-remain.amber, .m-remain.amber { color: var(--amber); }
.blk-remain.rose, .m-remain.rose { color: var(--rose); }

.bar {
  height: 8px; border-radius: 999px; background: rgba(255, 255, 255, 0.07);
  overflow: hidden;
}
.bar.sm { height: 6px; }
.bar-fill { height: 100%; border-radius: 999px; transition: width 0.4s ease; }
.bar-fill.emerald { background: linear-gradient(90deg, #10b981, #34d399); }
.bar-fill.amber { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
.bar-fill.rose { background: linear-gradient(90deg, #e11d48, #f43f5e); }

.blk-foot, .m-foot {
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; color: var(--text-3); font-family: var(--mono); margin-top: 6px;
}
.dot-sep { opacity: 0.5; }

.m-row { padding: 10px 0 0; }
.m-row + .m-row { border-top: 1px solid var(--border); margin-top: 10px; }
.m-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 7px; }
.m-label { font-size: 12.5px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.m-remain { font-family: var(--mono); font-size: 12.5px; font-weight: 500; flex: none; }

/* 编辑态 */
.q-edit { padding-top: 16px; }
.ed-sec { margin-bottom: 18px; }
.ed-title { font-size: 12px; color: var(--text-3); margin-bottom: 8px; }
.ed-row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
.ed-f { display: flex; flex-direction: column; gap: 5px; flex: 1; min-width: 130px; }
.ed-f.wide { flex: 2; min-width: 200px; }
.ed-f > span { font-size: 11px; color: var(--text-3); font-family: var(--mono); }
.ed-f input {
  width: 100%; background: var(--bg); border: 1px solid var(--border-strong);
  border-radius: 8px; padding: 7px 10px; color: var(--text); font-size: 12.5px;
  font-family: inherit; outline: none; transition: border-color 0.15s;
}
.ed-f input:focus { border-color: var(--emerald); }
.ed-f input[type="date"], .ed-f input[type="datetime-local"] { font-family: var(--mono); font-size: 12px; }
.pct { display: flex; align-items: center; gap: 10px; }
.pct input[type="range"] { flex: 1; accent-color: var(--emerald); }
.pct .num { width: 68px; flex: none; font-family: var(--mono); text-align: center; }
.ed-model {
  padding: 12px; border: 1px solid var(--border); border-radius: 10px;
  background: var(--bg); margin-bottom: 10px;
}
.ed-actions { display: flex; align-items: center; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
.ed-hint { font-size: 11px; color: var(--text-3); font-family: var(--mono); }
.btn-primary.sm {
  background: var(--emerald); color: #04130d; border: none; border-radius: 8px;
  padding: 7px 14px; font-size: 12.5px; font-weight: 600; cursor: pointer;
}
.btn-primary.sm:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-del.sm {
  background: transparent; color: var(--rose); border: 1px solid rgba(244, 63, 94, 0.35);
  border-radius: 8px; padding: 7px 12px; font-size: 12px; cursor: pointer; align-self: flex-end;
}
.btn-del.sm:hover { background: rgba(244, 63, 94, 0.12); }

.q-note {
  font-size: 11px; color: var(--text-3); line-height: 1.6;
  margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border);
}
.q-note code { font-family: var(--mono); color: var(--emerald-light); font-size: 10.5px; }
</style>
