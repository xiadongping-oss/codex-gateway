<script setup>
const props = defineProps({
  account: { type: Object, required: true }
})
const emit = defineEmits(['manage'])

function providerLabel(p) {
  return ({ oauth: 'OAuth', token: 'Token', import: '导入', apikey: 'API Key' }[p]) || 'OAuth'
}
function initials(name) {
  if (!name || name === '—') return '--'
  // 中文取最后一个字；英文取首字母
  const last = [...name]
  return last.length <= 2 ? last.join('').toUpperCase() : last.slice(-2).join('').toUpperCase()
}
</script>

<template>
  <section class="card c-account">
    <div class="card-title">登录账号</div>
    <div class="card-sub" style="margin-bottom: 14px">当前激活账号</div>

    <div v-if="account.loggedIn" class="account-head">
      <div class="avatar">{{ initials(account.name) }}</div>
      <div class="account-head-main">
        <div class="account-name">{{ account.name }}</div>
        <div class="account-mail">{{ account.email || '—' }}</div>
        <div class="account-tags">
          <span class="prov" :class="'prov-' + account.provider">{{ providerLabel(account.provider) }}</span>
          <span v-if="account.expiresAt && account.expiresAt !== '—'" class="exp">Token {{ account.expiresAt }}</span>
        </div>
      </div>
    </div>

    <div v-else class="account-head empty">
      <div class="avatar dim">--</div>
      <div class="account-head-main">
        <div class="account-name">尚未配置账号</div>
        <div class="account-mail">{{ account.detail || '点击下方按钮添加第一个账号' }}</div>
      </div>
    </div>

    <div class="account-row">
      <span class="k">状态</span>
      <span class="v" :class="account.loggedIn ? 'ok' : 'bad'">
        <span class="dot"></span>{{ account.loggedIn ? '登录态有效' : '未登录' }}
      </span>
    </div>
    <div class="account-row" style="border-bottom: none">
      <span class="k">操作</span>
      <button class="btn-ghost" style="padding: 5px 11px; font-size: 12px" @click="emit('manage')">
        {{ account.loggedIn ? '管理账号' : '添加账号' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.c-account { flex: 1; }
.account-head { display: flex; align-items: center; gap: 12px; padding: 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 12px; }
.account-head.empty { border-style: dashed; }
.avatar {
  width: 44px; height: 44px; border-radius: 12px;
  background: linear-gradient(135deg, var(--emerald), #14b8a6); color: #082f23;
  display: grid; place-items: center;
  font-size: 16px; font-weight: 800; letter-spacing: 0.05em;
}
.avatar.dim { background: var(--card-2); color: var(--text-3); }
.account-head-main { flex: 1; min-width: 0; }
.account-name { font-size: 14px; font-weight: 600; color: var(--text); }
.account-mail {
  font-family: var(--mono); font-size: 11.5px; color: var(--text-3);
  margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.account-tags { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
.prov {
  font-size: 10.5px; font-weight: 600;
  padding: 1px 6px; border-radius: 6px;
  color: #9aa0a8; background: rgba(154,160,168,0.12); border: 1px solid rgba(154,160,168,0.25);
}
.prov-oauth   { color: #34d399; background: rgba(16,185,129,0.12);  border-color: rgba(16,185,129,0.3); }
.prov-apikey  { color: #60a5fa; background: rgba(96,165,250,0.12);  border-color: rgba(96,165,250,0.3); }
.prov-token   { color: #f59e0b; background: rgba(245,158,11,0.12);  border-color: rgba(245,158,11,0.3); }
.prov-import  { color: #a78bfa; background: rgba(167,139,250,0.12); border-color: rgba(167,139,250,0.3); }
.exp { font-size: 10.5px; color: var(--text-2); background: rgba(255,255,255,0.04); border: 1px solid var(--border); padding: 1px 6px; border-radius: 6px; }
.account-row { display: flex; align-items: center; justify-content: space-between; padding: 9px 2px; border-bottom: 1px dashed var(--border); margin-top: 12px; }
.account-row .k { font-size: 12px; color: var(--text-3); }
.account-row .v { font-size: 12.5px; display: inline-flex; align-items: center; gap: 6px; color: var(--text); }
.account-row .v .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.account-row .v.ok { color: var(--emerald-light); }
.account-row .v.bad { color: var(--rose); }
</style>
