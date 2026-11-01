<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import * as api from '../api/gateway'
import { copyText } from '../api/client'
import { vModalFocus } from '../composables/modalFocus'
import { usePagination } from '../composables/usePagination'
import Pagination from '../components/Pagination.vue'

const keys = ref([])
const accounts = ref([])
const activeId = ref(null)
const loading = ref(false)
const loadErr = ref('')
let pollTimer = null

// 按调用次数排序（null=按创建顺序 / desc / asc）
const sortDir = ref(null)
function toggleSortCalls() {
  sortDir.value = sortDir.value === 'desc' ? 'asc' : sortDir.value === 'asc' ? null : 'desc'
}
// 显示用列表：排序只改变派生视图，不改动 keys 源顺序（轮询刷新不引发重排抖动）
const displayKeys = computed(() => {
  if (!sortDir.value) return keys.value
  const arr = keys.value.slice()
  arr.sort((a, b) =>
    sortDir.value === 'desc'
      ? (b.callCount || 0) - (a.callCount || 0)
      : (a.callCount || 0) - (b.callCount || 0)
  )
  return arr
})
// 调用量最高的 Key（>0 才标「最活跃」）
const topCallKeyId = computed(() => {
  let best = null
  let max = 0
  for (const k of keys.value) {
    const c = k.callCount || 0
    if (c > max) {
      max = c
      best = k.id
    }
  }
  return max > 0 ? best : null
})
const {page,pages,visible}=usePagination(displayKeys,20)

// 创建流程状态
const showCreate = ref(false)
const creating = ref(false)
const newName = ref('')
const scope = ref('all') // 'all' | 'specific'
const selectedIds = ref([])
const justCreated = ref(null)   // 创建后弹窗：{ name, token, mask, accountIds, scopeLabel }

const activeAccountName = computed(() => {
  const a = accounts.value.find((x) => x.id === activeId.value)
  return a ? a.name : '当前激活账号'
})

async function refresh() {
  loading.value = true
  loadErr.value = ''
  try {
    const [ks, a] = await Promise.all([api.listApiKeys(), api.getAccounts()])
    keys.value = ks || []
    accounts.value = (a && a.accounts) || []
    activeId.value = (a && a.activeId) || null
  } catch (e) {
    loadErr.value = e?.message || '拉取失败'
  } finally {
    loading.value = false
  }
}

// 静默刷新：轮询 Key 列表，让「调用次数」随真实请求实时滚动（不触发整页 loading 闪烁）
let silentLoading = false
async function silentRefresh() {
  // in-flight 守卫：慢响应时不重复发起，避免请求量翻倍与旧响应覆盖新响应
  if (silentLoading) return
  silentLoading = true
  try {
    const [ks, a] = await Promise.all([api.listApiKeys(), api.getAccounts()])
    keys.value = ks || []
    accounts.value = (a && a.accounts) || []
    activeId.value = (a && a.activeId) || null
  } catch {
    /* 轮询失败静默，下一轮重试 */
  } finally {
    silentLoading = false
  }
}

onMounted(() => {
  refresh()
  loadLanBase()
  pollTimer = setInterval(silentRefresh, 3000)
})

function fmtTime(s) {
  if (!s) return '—'
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// token 量精简显示：1234 → 1.2K，1234567 → 1.2M
function fmtTok(n) {
  n = Number(n) || 0
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

// 作用域展示：全部账号 / N 个账号 / 账号名
function scopeLabel(key) {
  const ids = key.accountIds
  if (!ids || ids.length === 0) return '全部账号'
  if (ids.length === 1) {
    const a = accounts.value.find((x) => x.id === ids[0])
    return a ? a.name : ids[0]
  }
  const names = ids
    .map((id) => accounts.value.find((x) => x.id === id)?.name || id)
    .slice(0, 2)
  const more = ids.length - names.length
  return names.join('、') + (more > 0 ? ` 等 ${ids.length} 个账号` : '')
}

async function onDelete(k) {
  if (typeof window !== 'undefined' && !window.confirm(`确定删除 Key「${k.name}」？持有该 Key 的客户端将立即失效。`)) return
  loading.value = true
  try {
    const r = await api.deleteApiKey(k.id)
    if (r && r.ok) {
      await refresh()
    } else {
      loadErr.value = (r && (r.error || r.msg)) || '删除失败'
    }
  } finally {
    loading.value = false
  }
}

function startCreate() {
  showCreate.value = true
  justCreated.value = null
  newName.value = ''
  scope.value = 'all'
  selectedIds.value = []
}

function toggleScope(val) {
  scope.value = val
  if (val === 'all') selectedIds.value = []
}

function toggleAccount(id) {
  const set = new Set(selectedIds.value)
  if (set.has(id)) set.delete(id)
  else set.add(id)
  selectedIds.value = Array.from(set)
  if (selectedIds.value.length > 0) scope.value = 'specific'
}

function accountIdsForSubmit() {
  if (scope.value === 'all') return null
  const ids = selectedIds.value.filter((id) => accounts.value.find((a) => a.id === id))
  return ids.length > 0 ? ids : null
}

async function submitCreate() {
  if (!newName.value.trim()) {
    loadErr.value = '请填写 Key 名称（如：WorkBuddy-主账号）'
    return
  }
  if (scope.value === 'specific' && selectedIds.value.length === 0) {
    loadErr.value = '请至少选择一个账号，或切换为「全部账号」'
    return
  }
  creating.value = true
  loadErr.value = ''
  try {
    const accountIds = accountIdsForSubmit()
    const k = await api.createApiKey({ name: newName.value.trim(), accountIds })
    if (k && k.token) {
      justCreated.value = {
        name: k.name,
        token: k.token,
        mask: k.mask,
        accountIds: k.accountIds,
        scopeLabel: scopeLabel({ accountIds: k.accountIds })
      }
      await refresh()
    } else {
      loadErr.value = (k && (k.error || k.detail)) || '创建失败'
    }
  } catch (e) {
    loadErr.value = e?.message || '创建失败'
  } finally {
    creating.value = false
  }
}

const copiedToken = ref('')
const copiedId = ref('')
const copyErr = ref('')
// 【按需取明文】列表接口不再返回明文（此前每 3 秒轮询都会把密钥摊进 DOM）。
// 点「复制」时才向 /__gw/apikeys/reveal 单条取一次。
async function copyKey(k) {
  copyErr.value = ''
  try {
    const rv = await api.revealApiKey(k.id)
    if (!rv || !rv.token) throw new Error('取不到该 Key 的明文')
    await copyText(rv.token)
    copiedId.value = k.id
    setTimeout(() => (copiedId.value = ''), 1800)
  } catch (e) {
    copyErr.value = e?.message || '复制失败'
    setTimeout(() => (copyErr.value = ''), 4000)
  }
}
const showToken = ref(true)
async function copyToken() {
  copyErr.value = ''
  try {
    if (!justCreated.value?.token) throw new Error('没有可复制的 Token')
    await copyText(justCreated.value.token)
    copiedToken.value = '✓ 已复制到剪贴板'
    setTimeout(() => (copiedToken.value = ''), 1800)
  } catch (e) {
    copyErr.value = e?.message || '复制失败'
    setTimeout(() => (copyErr.value = ''), 4000)
  }
}

// ---- 局域网接入邀请：一键复制「接入页 /setup + 该 Key」给同事（全程网页配置，免命令行） ----
const lanBase = ref('')
async function loadLanBase() {
  try {
    // 必须走 primaryLanAddress()：addresses[0] 是网卡枚举顺序的第一条，
    // 装了 Tailscale / Docker 的机器上它往往是 100.x 或虚拟网卡 —— 把这种地址
    // 复制给同事，对方永远连不上。后端已按「真实内网 → 虚拟网卡 → Tailscale」
    // 排序并标出 preferred，前端只认那个。
    // 同时改走 api.getLanInfo()：裸 fetch 没有超时，网关假死时这里会永久 pending。
    const s = await api.getLanInfo()
    const addr = api.primaryLanAddress(s?.addresses)
    lanBase.value = addr?.address ? `http://${addr.address}:${s?.port || 4173}` : ''
  } catch {
    lanBase.value = ''
  }
}
const inviteCopiedId = ref('')
async function copyInvite(k) {
  copyErr.value = ''
  // 拿不到局域网地址就别生成半截邀请文本（"/setup" 这种发给同事是错的）
  if (!lanBase.value) {
    copyErr.value = '未取到局域网地址，请确认网关已用局域网模式启动'
    setTimeout(() => (copyErr.value = ''), 4000)
    return
  }
  try {
    const rv = await api.revealApiKey(k.id)
    if (!rv || !rv.token) throw new Error('取不到该 Key 的明文')
    const text = [
      '【codex-gateway 局域网接入】',
      `1) 浏览器打开接入页：${lanBase.value}/setup`,
      `2) 输入你的 API Key：${rv.token}`,
      `3) 按页面提示复制 MCP / 模型配置即可；素材站：${lanBase.value}/gallery`
    ].join('\n')
    await copyText(text)
    inviteCopiedId.value = k.id
    setTimeout(() => (inviteCopiedId.value = ''), 1800)
  } catch (e) {
    copyErr.value = e?.message || '复制失败'
    setTimeout(() => (copyErr.value = ''), 4000)
  }
}

function closeCreate() {
  showCreate.value = false
  justCreated.value = null
}

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
  closeCreate()
})
</script>

<template>
  <div class="content">
    <!-- 主卡片 -->
    <div class="card">
      <div class="card-title-row">
        <div class="card-title">API Key</div>
        <span class="card-meta">{{ keys.length }} 个 Key</span>
        <button class="btn-primary sm" @click="startCreate">
          <span>+ 新建 Key</span>
        </button>
      </div>
      <details class="help-details"><summary>API Key 与账号绑定说明</summary><div class="card-sub" style="margin-bottom: 14px">
        给 WorkBuddy 等外部客户端用的「网关层」API Key —— 鉴权走 <code>Authorization: Bearer</code>，
        默认不锁定单一账号；指定账号后请求会被限制在所选账号内。
      </div></details>

      <div v-if="loadErr" class="msg err">{{ loadErr }}</div>

      <div v-if="!keys.length && !loading" class="empty">
        还没有 API Key。点「+ 新建 Key」创建第一个。
      </div>

      <div class="k-row head">
        <span class="c-name">名称</span>
        <span class="c-token">Token（掩码）</span>
        <span class="c-acc">绑定账号</span>
        <span class="c-time">创建 / 最近使用</span>
        <span class="c-call sortable" @click="toggleSortCalls()" title="按调用次数排序">
          调用 / Token<span class="sort-ar" :class="sortDir">{{ sortDir === 'desc' ? '▼' : sortDir === 'asc' ? '▲' : '↕' }}</span>
        </span>
        <span class="c-act"></span>
      </div>

      <div v-for="k in visible" :key="k.id" class="k-row">
        <div class="c-name">
          <div class="kn">{{ k.name }}</div>
          <div class="kid">{{ k.id }}</div>
        </div>
        <div class="c-token">
          <code>{{ k.mask }}</code>
          <span class="prefix" v-if="k.prefix">{{ k.prefix }}…</span>
        </div>
        <div class="c-acc">
          <span class="scope-pill" :class="{ all: !k.accountIds || k.accountIds.length === 0 }">
            {{ scopeLabel(k) }}
          </span>
        </div>
        <div class="c-time">
          <div class="t1">建：{{ fmtTime(k.createdAt) }}</div>
          <div class="t2">用：{{ fmtTime(k.lastUsedAt) }}</div>
        </div>
        <div class="c-call">
          <span class="call-n">{{ k.callCount ? k.callCount.toLocaleString() : '—' }}</span>
          <span class="call-tok" v-if="k.tokens">{{ fmtTok(k.tokens) }} tok</span>
          <span v-if="k.id === topCallKeyId" class="call-tag">最活跃</span>
        </div>
        <div class="c-act">
          <button class="btn-copy sm" :class="{ copied: copiedId === k.id }" @click="copyKey(k)">
            {{ copiedId === k.id ? '✓ 已复制' : '复制' }}
          </button>
          <button
            class="btn-invite sm"
            :class="{ copied: inviteCopiedId === k.id }"
            title="复制「接入页地址 + 该 Key」发给同事：对方打开 /setup 输入 Key，全程网页完成配置"
            @click="copyInvite(k)"
          >
            {{ inviteCopiedId === k.id ? '✓ 已发出' : '接入' }}
          </button>
          <button class="btn-del sm" :disabled="loading" @click="onDelete(k)">删除</button>
        </div>
      </div>
      <div v-if="copyErr" class="msg err">{{ copyErr }}</div>
    </div>

    <Pagination v-model="page" :pages="pages" :total="displayKeys.length" />
    <!-- 创建/一次性展示弹窗 -->
    <div v-if="showCreate" class="modal-mask" @click.self="closeCreate">
      <div class="modal" role="dialog" aria-modal="true" :aria-label="justCreated ? '已创建 Key' : '新建 API Key'" v-modal-focus="closeCreate">
        <div class="modal-head">
          <div class="modal-title">
            <template v-if="justCreated">已创建 Key</template>
            <template v-else>新建 API Key</template>
          </div>
          <button class="x" @click="closeCreate" aria-label="关闭">×</button>
        </div>

        <!-- 创建表单 -->
        <div v-if="!justCreated" class="modal-body">
          <label class="form-row">
            <span class="form-lbl">名称</span>
            <input v-model="newName" class="inp" maxlength="40" placeholder="例如：WorkBuddy-主账号" />
          </label>

          <div class="form-row">
            <span class="form-lbl">绑定账号</span>

            <!-- 全部账号 -->
            <div
              class="scope-option"
              :class="{ active: scope === 'all' }"
              role="radio" :aria-checked="scope === 'all'" tabindex="0"
              @keydown.enter.prevent="toggleScope('all')" @keydown.space.prevent="toggleScope('all')"
              @click="toggleScope('all')"
            >
              <span class="radio">
                <span v-if="scope === 'all'" class="radio-dot"></span>
              </span>
              <div class="scope-text">
                <div class="scope-title">全部账号</div>
                <div class="scope-desc">该 Key 跟随当前激活账号，切换账号后自动生效</div>
              </div>
            </div>

            <!-- 指定账号 -->
            <div
              class="scope-option"
              :class="{ active: scope === 'specific' }"
              role="radio" :aria-checked="scope === 'specific'" tabindex="0"
              @keydown.enter.prevent="toggleScope('specific')" @keydown.space.prevent="toggleScope('specific')"
              @click="toggleScope('specific')"
            >
              <span class="radio">
                <span v-if="scope === 'specific'" class="radio-dot"></span>
              </span>
              <div class="scope-text">
                <div class="scope-title">指定账号</div>
                <div class="scope-desc">仅允许 Key 访问选中的账号，请求时会自动切换</div>
              </div>
            </div>

            <!-- 账号多选 -->
            <div v-if="scope === 'specific'" class="account-grid">
              <label
                v-for="a in accounts"
                :key="a.id"
                class="account-chip"
                :class="{ checked: selectedIds.includes(a.id) }"
              >
                <input
                  type="checkbox"
                  :value="a.id"
                  :checked="selectedIds.includes(a.id)"
                  @change="toggleAccount(a.id)"
                />
                <span class="check"></span>
                <span class="aname">{{ a.name }}</span>
                <span class="aid">{{ a.id }}</span>
              </label>
              <div v-if="!accounts.length" class="account-empty">暂无账号可绑定</div>
            </div>
          </div>

          <div class="hint">
            <b>全部账号</b>表示 Key 不锁定单一账号；指定账号时请求会被限制在所选账号内。
          </div>
          <div class="hint warn">
            创建后 Token 会立刻显示在这里。出于安全考虑，明文不会出现在列表接口的返回里——
            之后随时可以点列表行的「复制」按钮重新取一次（仅本机可用）。
          </div>

          <div v-if="loadErr" class="msg err" role="alert" style="margin-top: 8px">{{ loadErr }}</div>

          <div class="btn-row">
            <button class="btn-primary" :disabled="creating" @click="submitCreate">
              {{ creating ? '创建中…' : '创建' }}
            </button>
            <button class="btn-ghost" @click="closeCreate">取消</button>
          </div>
        </div>

        <!-- 一次性明文展示 -->
        <div v-else class="modal-body">
          <div class="hint ok">
            <b>成功创建</b>「{{ justCreated.name }}」 · 绑定范围：{{ justCreated.scopeLabel }}
          </div>
          <div class="form-row">
            <span class="form-lbl">API Key（仅此一次）</span>
            <div class="token-box">
              <code :class="{ hidden: !showToken }">{{ showToken ? justCreated.token : justCreated.mask }}</code>
              <button class="btn-ghost sm" @click="showToken = !showToken">{{ showToken ? '隐藏' : '显示' }}</button>
              <button class="btn-primary sm" @click="copyToken">{{ copiedToken || '复制' }}</button>
            </div>
          </div>

          <div class="hint">
            把这个 <code>Bearer</code> Token 粘到 WorkBuddy 等客户端的「API Key」字段，
            baseUrl 填 <code>{{ typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:4173' }}/v1</code>，
            模型选「模型能力」页可用的即可。
          </div>

          <div class="btn-row">
            <button class="btn-primary" @click="closeCreate">已完成，关闭</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.content { flex: 1; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 18px; }

.card-title-row { display: flex; align-items: center; gap: 12px; }
.card-meta { font-size: 11.5px; color: var(--text-3); margin-left: auto; }
.card-title { font-size: 14px; font-weight: 600; color: var(--text); }
.card-sub { font-size: 12.5px; color: var(--text-3); line-height: 1.6; }
.card-sub code { font-family: var(--mono); color: var(--emerald-light); padding: 1px 5px; background: rgba(139,107,214,0.10); border-radius: 4px; font-size: 11.5px; }

.btn-primary.sm {
  background: var(--emerald); color: var(--on-accent); border: none; border-radius: 8px;
  padding: 7px 13px; font-size: 12.5px; font-weight: 600; cursor: pointer;
}
/* 行内操作按钮：默认安静（灰调、低存在感），hover / 成功态才亮出语义色。
   此前「复制」是常绿实底、「删除」是常红描边，两个高饱和按钮并排挤在行尾，
   视觉权重压过了行内数据本身。 */
.btn-copy.sm {
  background: transparent; color: var(--text-2); border: 1px solid var(--border-strong);
  border-radius: 8px; padding: 6px 11px; font-size: 11.5px; cursor: pointer;
  transition: all 0.15s; white-space: nowrap;
}
.btn-copy.sm:hover { color: var(--emerald-light); border-color: rgba(139,107,214,0.4); background: rgba(139,107,214,0.08); }
.btn-copy.sm.copied {
  color: var(--emerald-light); border-color: rgba(139,107,214,0.45); background: rgba(139,107,214,0.12);
}
.btn-del.sm {
  background: transparent; color: var(--text-3); border: 1px solid transparent;
  border-radius: 8px; padding: 6px 11px; font-size: 11.5px; cursor: pointer;
  transition: all 0.15s; white-space: nowrap;
}
.btn-del.sm:hover:not(:disabled) { color: #ef4444; border-color: rgba(239,68,68,0.35); background: rgba(239,68,68,0.08); }
.btn-del.sm:disabled { opacity: 0.4; cursor: not-allowed; }
/* 「接入」：复制 /setup 接入页邀请（蓝色系以区分纯复制） */
.btn-invite.sm {
  background: transparent; color: var(--text-2); border: 1px solid var(--border-strong);
  border-radius: 8px; padding: 6px 11px; font-size: 11.5px; cursor: pointer;
  transition: all 0.15s; white-space: nowrap;
}
.btn-invite.sm:hover { color: #60a5fa; border-color: rgba(96,165,250,0.4); background: rgba(96,165,250,0.08); }
.btn-invite.sm.copied { color: #60a5fa; border-color: rgba(96,165,250,0.45); background: rgba(96,165,250,0.12); }
.c-act { display: flex; gap: 6px; justify-content: flex-end; }

.msg { font-size: 12.5px; padding: 8px 10px; border-radius: 8px; margin-top: 10px; }
.msg.err { background: rgba(239, 68, 68, 0.12); color: #ef4444; }

.empty { font-size: 13px; color: var(--text-3); padding: 18px 4px; text-align: center; }

/* Key 列表 */
.k-row {
  display: grid;
  grid-template-columns: 1.2fr 1.5fr 1.1fr 1.4fr 0.9fr 172px;
  align-items: center; gap: 12px;
  padding: 12px 10px; border-bottom: 1px solid var(--border);
}
.k-row.head { font-size: 11.5px; color: var(--text-3); padding: 8px 10px; border-bottom-color: var(--border-strong); }
.k-row.head > span { font-weight: 500; }
.c-name .kn { font-size: 13.5px; font-weight: 600; color: var(--text); }
.c-name .kid { font-size: 11px; color: var(--text-3); font-family: var(--mono); margin-top: 2px; }
.c-token code { font-family: var(--mono); font-size: 12px; color: var(--emerald-light); }
.c-token .prefix { font-size: 11px; color: var(--text-3); margin-left: 6px; }
.c-acc { font-size: 12.5px; color: var(--text-2); }
.scope-pill {
  display: inline-flex; align-items: center;
  font-size: 11.5px; color: var(--text);
  background: rgba(139,107,214,0.10); border: 1px solid rgba(139,107,214,0.25);
  border-radius: 999px; padding: 3px 10px;
}
.scope-pill.all { background: rgba(139,107,214,0.10); border-color: rgba(139,107,214,0.25); color: var(--emerald-light); }
.c-time .t1, .c-time .t2 { font-size: 11.5px; color: var(--text-3); font-family: var(--mono); }
.c-time .t2 { color: var(--text-2); margin-top: 2px; }
.c-call { text-align: left; display: flex; flex-direction: column; gap: 4px; }
.c-call.sortable { cursor: pointer; user-select: none; flex-direction: row; align-items: center; gap: 5px; }
.c-call.sortable:hover { color: var(--text-2); }
.sort-ar { font-size: 9px; color: var(--emerald-light); opacity: 0.45; }
.sort-ar.desc, .sort-ar.asc { opacity: 1; }
.c-call .call-n { font-size: 14px; font-weight: 700; color: var(--text); font-family: var(--mono); }
.c-call .call-tok { font-size: 10.5px; color: var(--text-3); font-family: var(--mono); }
.call-tag { font-size: 10px; color: var(--primary); background: rgba(139,107,214,0.12); border: 1px solid rgba(139,107,214,0.3); border-radius: 999px; padding: 1px 7px; align-self: flex-start; }
.c-act { text-align: right; }

/* 弹窗 */
.modal-mask {
  position: fixed; inset: 0; background: rgba(0,0,0,0.55);
  display: flex; align-items: center; justify-content: center; z-index: 60;
}
.modal {
  width: 580px; max-width: 92vw; background: var(--card); border: 1px solid var(--border-strong);
  border-radius: 16px; padding: 22px; box-shadow: 0 20px 60px rgba(0,0,0,0.5);
}
.modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.modal-title { font-size: 18px; font-weight: 600; color: var(--text); }
.scope-option:focus-visible { outline: 3px solid var(--primary); outline-offset: 2px; }
.x { background: none; border: none; color: #9ca3af; font-size: 22px; cursor: pointer; line-height: 1; }
.modal-body { display: flex; flex-direction: column; gap: 14px; }

.form-row { display: flex; flex-direction: column; gap: 6px; }
.form-row .form-lbl { font-size: 12.5px; color: var(--text-3); }
.inp {
  width: 100%; background: var(--card-2); border: 1px solid var(--border-strong); border-radius: 8px;
  padding: 10px 12px; color: var(--text); font-size: 13.5px; font-family: inherit;
}
.inp:focus { border-color: var(--emerald); outline: none; }
.hint { font-size: 12.5px; color: var(--text-3); line-height: 1.6; margin: 0; }
.hint code { font-family: var(--mono); color: var(--emerald-light); padding: 1px 5px; background: rgba(139,107,214,0.10); border-radius: 4px; font-size: 11.5px; }
.hint b { color: var(--text); font-weight: 600; }
.hint.ok b { color: var(--primary); }
.hint.warn b { color: #f59e0b; }

/* 作用域选择 */
.scope-option {
  display: flex; align-items: flex-start; gap: 10px;
  background: var(--card-2); border: 1px solid var(--border-strong); border-radius: 8px;
  padding: 12px; cursor: pointer; transition: background .15s, border-color .15s;
}
.scope-option:hover { background: var(--bg); }
.scope-option.active { background: rgba(139,107,214,0.08); border-color: var(--emerald); }
.radio {
  width: 16px; height: 16px; border-radius: 50%; border: 2px solid #6b7280;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 2px;
}
.scope-option.active .radio { border-color: var(--emerald); }
.radio-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--emerald); }
.scope-text { display: flex; flex-direction: column; gap: 2px; }
.scope-title { font-size: 13.5px; font-weight: 500; color: var(--text); }
.scope-desc { font-size: 11.5px; color: var(--text-3); }

/* 账号多选 */
.account-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(min(220px, 100%), 1fr)); gap: 8px;
  margin-top: 4px;
}
.account-chip {
  display: flex; align-items: center; gap: 8px;
  background: var(--card-2); border: 1px solid var(--border-strong); border-radius: 8px;
  padding: 8px 10px; cursor: pointer; transition: background .15s, border-color .15s;
}
.account-chip:hover { background: var(--bg); }
.account-chip:focus-within { outline: 3px solid var(--primary); outline-offset: 2px; }
.account-chip.checked { background: rgba(139,107,214,0.08); border-color: var(--emerald); }
.account-chip input { position: absolute; opacity: 0; pointer-events: none; }
.check {
  width: 14px; height: 14px; border-radius: 4px; border: 1px solid #4b5563;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.account-chip.checked .check { background: var(--emerald); border-color: var(--emerald); }
.account-chip.checked .check::after {
  content: ''; width: 5px; height: 9px; border: solid #0a0b0e; border-width: 0 2px 2px 0;
  transform: rotate(45deg) translate(-1px, -1px);
}
.aname { font-size: 12.5px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.aid { font-size: 10.5px; color: var(--text-3); font-family: var(--mono); margin-left: auto; }
.account-empty { font-size: 12px; color: var(--text-3); padding: 8px; }

.token-box {
  display: flex; align-items: center; gap: 8px;
  background: #0a0b0e; border: 1px solid var(--border-strong); border-radius: 10px;
  padding: 8px 10px;
}
.token-box code {
  flex: 1; font-family: var(--mono); font-size: 13px; color: var(--primary);
  word-break: break-all; user-select: all;
}
.token-box code.hidden { color: var(--text-3); }
.btn-ghost.sm {
  background: var(--card-2); color: var(--text-2); border: 1px solid var(--border-strong); border-radius: 8px;
  padding: 7px 11px; font-size: 12px; cursor: pointer;
}

.btn-row { display: flex; gap: 10px; justify-content: flex-end; margin-top: 4px; }
.btn-primary {
  background: var(--emerald); color: var(--on-accent); border: none; border-radius: 8px;
  height: 40px; padding: 0 16px; font-size: 13px; font-weight: 600; cursor: pointer;
}
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-ghost {
  background: var(--card-2); color: var(--text-2); border: 1px solid var(--border-strong); border-radius: 8px;
  height: 40px; padding: 0 14px; font-size: 13px; cursor: pointer;
}
</style>
