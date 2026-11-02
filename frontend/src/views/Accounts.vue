<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import * as api from '../api/gateway'
import SetupModal from '../components/SetupModal.vue'
import AccountQuotaCard from '../components/AccountQuotaCard.vue'
import { useLiveData } from '../composables/useLiveData'
import { connectionStatus } from '../utils/connection-status'

const { gw } = useLiveData()
const account = ref({ loggedIn: false })
const health = ref(null)
const loading = ref(false)
const error = ref('')
const fetchErr = ref('')
const showSetup = ref(false)
const reauthorizing = ref(false)
function openSetup(reauth = false) { reauthorizing.value = reauth; showSetup.value = true }
const mode = ref('')
const hasApiKey = ref(false)
const accounts = ref([])
const activeId = ref(null)
const editingId = ref(null)
const editName = ref('')
const editNote = ref('')
const status = computed(() => connectionStatus({ mode: mode.value, running: gw.value.running,
  health: gw.value.health || health.value, loggedIn: account.value.loggedIn, hasApiKey: hasApiKey.value }))
const pageError = computed(() => error.value || fetchErr.value)
function openSettings() { window.dispatchEvent(new CustomEvent('cgw:navigate', { detail: { page: 'settings' } })) }
let refreshSeq = 0
let timer
const isStale = seq => seq !== refreshSeq
async function diagnose() { await refresh() }
async function refresh() {
  const seq = ++refreshSeq
  loading.value = true
  try {
    const [s, list, h] = await Promise.all([api.getAuthState(), api.getAccounts(), api.diagnose()])
    if (isStale(seq)) return
    if (!s || !list || !Array.isArray(list.accounts)) throw new Error('暂时无法读取账号，请重试。')
    mode.value = s.mode
    hasApiKey.value = !!s.hasApiKey
    account.value = s.account || { loggedIn: false }
    accounts.value = list.accounts
    activeId.value = list.activeId
    health.value = h
    fetchErr.value = ''
  } catch (e) {
    if (!isStale(seq)) fetchErr.value = e?.message || '账号加载失败，请重试。'
  } finally { if (!isStale(seq)) loading.value = false }
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


onMounted(() => { refresh(); timer = setInterval(() => { if (!document.hidden && !loading.value) refresh() }, 8000) })
onUnmounted(() => { clearInterval(timer); refreshSeq++ })
</script>
<template>
  <div class="content">
    <!-- 账号列表与补充诊断 -->
    <div class="grid-top">
    <div class="card">
      <div class="acc-title-row">
        <div class="account-heading"><h2 class="card-title">账号 <span class="count">{{ accounts.length }}</span></h2><span v-if="status?.tone === 'success'" class="connection-pill" role="status"><i></i>{{ status.title }}</span></div>
        <div class="acc-head-actions">
          <button class="btn-ghost" @click="diagnose" :disabled="loading">{{ loading ? '检测中…' : '检测连接' }}</button>
          <button class="btn-primary" @click="openSetup()">添加账号</button>
        </div>
      </div>

      <div v-if="status && status.tone !== 'success'" class="connection-notice" :class="status.tone" :role="status.tone === 'error' ? 'alert' : 'status'">
        <span class="notice-symbol" aria-hidden="true">{{ status.tone === 'error' ? '!' : '•' }}</span>
        <div class="notice-copy"><strong>{{ status.title }}</strong><p v-if="status.description">{{ status.description }}</p></div>
        <button v-if="status.action === 'reauth'" class="btn-ghost" @click="openSetup(true)">重新授权</button>
        <button v-if="status.action === 'settings'" class="btn-ghost" @click="openSettings">检查出网代理</button>
      </div>
      <p v-if="pageError" class="page-error" role="alert">{{ pageError }}</p>

      <div v-if="!accounts.length" class="empty">
        <template v-if="!fetchErr">尚无账号，点击「添加账号」创建第一个。</template>
      </div>

      <div v-for="a in accounts" :key="a.id" class="acc-row" :class="{ active: a.id === activeId }">
        <span class="acc-avatar" aria-hidden="true">{{ (a.name || '?').slice(0,1).toUpperCase() }}</span>
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
              <span class="acc-auth" :class="a.hasAuth ? 'ok' : 'bad'">{{ a.hasAuth ? '凭据已保存' : '待授权' }}</span>
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

    </div>

    <AccountQuotaCard :key="activeId || 'none'" :connection-blocked="status?.tone === 'error'" />

    <SetupModal
      v-if="showSetup"
      :reauthorizing="reauthorizing"
      @close="showSetup = false"
      @changed="refresh"
    />
  </div>
</template>

<style scoped>
.account-heading { display:flex; align-items:center; flex-wrap:wrap; gap:12px; }
.account-heading h2 { margin:0; font-size:14px; }
.connection-pill { display:inline-flex; align-items:center; gap:6px; font-size:11px; color:var(--primary); background:var(--primary-soft); border-radius:999px; padding:4px 9px; }
.connection-pill i { width:5px; height:5px; border-radius:50%; background:currentColor; }
.acc-avatar { display:grid; place-items:center; width:42px; height:42px; border-radius:12px; background:var(--primary-soft); color:var(--primary); font-size:15px; font-weight:650; flex:none; }

.grid-top { display: grid; grid-template-columns: minmax(0, 1fr); }
.connection-notice { display:flex; align-items:center; gap:12px; padding:16px; margin-bottom:20px; border:1px solid var(--border); border-radius:12px; background:var(--bg); }
.connection-notice.error { border-color:color-mix(in srgb,var(--rose) 30%,transparent); background:color-mix(in srgb,var(--rose) 5%,var(--card)); }
.notice-symbol { display:grid; place-items:center; width:28px; height:28px; flex:none; border-radius:50%; color:var(--primary); background:var(--emerald-dim); font-weight:700; }
.error .notice-symbol { color:var(--rose); background:color-mix(in srgb,var(--rose) 10%,transparent); }
.notice-copy { flex:1; min-width:0; }
.notice-copy strong { font-size:13px; font-weight:600; }
.notice-copy p { color:var(--text-2); font-size:12px; line-height:1.65; margin-top:4px; }
.connection-notice button { flex:none; white-space:nowrap; }
.page-error { color:var(--rose); font-size:13px; margin-bottom:16px; }
@media(max-width:680px) { .connection-notice { flex-wrap:wrap; } .connection-notice button { margin-left:40px; } }
/* ---- 账号卡标题行：标题 + 操作按钮同行 ---- */
.acc-title-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.acc-head-actions { display: flex; gap: 10px; flex-shrink: 0; }
/* ---- 账号列表行 ---- */
.count {
  font-size: 12px; color: var(--text-3); background: var(--bg);
  border: 1px solid var(--border-strong); border-radius: 999px; padding: 0 8px; margin-left: 6px;
}
.empty { font-size: 12.5px; color: var(--text-3); padding: 10px 0; }
.acc-row {
  display: flex; align-items: center; gap:16px; padding:20px;
  border: 1px solid var(--border); border-radius: 12px; margin-bottom: 10px;
  background: var(--card);
}
.acc-row:last-child { margin-bottom: 0; }
.acc-row.active { border-color:var(--border-strong); background:var(--card); box-shadow:inset 3px 0 0 var(--primary); }
.acc-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--emerald); flex: none; }
.acc-dot.off { background: var(--text-3); }
.acc-main { flex: 1; min-width: 0; }
.acc-name-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.acc-name { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.acc-meta {
  display: flex; align-items: center; gap: 6px; margin-top: 3px;
  font-size:12px; min-width:0;
}
.acc-auth { flex-shrink: 0; }
.acc-auth.ok { color: var(--emerald-light); }
.acc-auth.bad { color: var(--amber); }
.acc-note { color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.acc-actions { display: flex; gap: 8px; flex: none; }
@media (max-width: 680px) {
  .acc-row { flex-wrap: wrap; }
  .acc-main { flex-basis:calc(100% - 58px); }
  .acc-actions { margin-left:58px; flex-wrap: wrap; }
  .acc-name-row { flex-wrap: wrap; }
  .acc-name { flex-basis: 100%; }
  :deep(.q-head) { flex-wrap: wrap; }
  :deep(.q-head .card-title) { white-space: nowrap; }
  :deep(.q-head button) { white-space: nowrap; }
}
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
.prov-oauth { color: var(--primary); background: rgba(139,107,214, 0.12); border-color: rgba(139,107,214, 0.3); }
.prov-apikey { color: #60a5fa; background: rgba(96, 165, 250, 0.12); border-color: rgba(96, 165, 250, 0.3); }
.cur {
  font-size: 10.5px; font-weight: 600; color: var(--primary); flex-shrink: 0;
  background:var(--primary-soft); border:1px solid transparent;
  border-radius: 6px; padding: 1px 6px;
}
.btn-del {
  background: transparent; color: var(--rose); border: 1px solid color-mix(in srgb, var(--rose) 35%, transparent);
  border-radius: 8px; padding: 6px 10px; font-size: 11.5px; cursor: pointer;
}
.btn-del:hover:not(:disabled) { background: color-mix(in srgb, var(--rose) 12%, transparent); }
.btn-del:disabled { opacity: 0.4; cursor: not-allowed; }


</style>
