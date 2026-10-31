<script setup>
// 概览页的「局域网接入」速览条：此前这个能力埋在「模型能力」页第 3 张卡里，
// 想给另一台电脑接网关的人根本找不到入口——现在首屏常驻一条，
// 状态、首个地址、复制一步到位；完整配置（地址列表 / 接入三项 / 安全边界）仍在模型能力页。
import { ref, computed, onMounted } from 'vue'
import * as api from '../api/gateway'
import { copyText } from '../api/client'

const emit = defineEmits(['open'])

const lan = ref({ enabled: false, addresses: [], port: 4173 })
const copied = ref(false)
const copyErr = ref('')

const primary = computed(() => api.primaryLanAddress(lan.value.addresses))
const addrText = computed(() =>
  primary.value ? `http://${primary.value.address}:${lan.value.port}/v1` : ''
)
const kindText = computed(() => api.lanKindLabel(primary.value))
// 机器上还有别的地址（Tailscale / 虚拟网卡）时提示一句，免得用户以为只有这一个
const moreCount = computed(() => Math.max(0, lan.value.addresses.length - 1))

async function copyAddr() {
  copyErr.value = ''
  try {
    await copyText(addrText.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch (e) {
    copyErr.value = e?.message || '复制失败'
    setTimeout(() => (copyErr.value = ''), 3000)
  }
}

onMounted(async () => {
  lan.value = await api.getLanInfo().catch(() => lan.value)
})
</script>

<template>
  <div class="lan-strip">
    <div class="ls-left">
      <div class="ls-title">
        局域网接入
        <span class="ls-badge" :class="lan.enabled ? 'on' : 'off'">{{ lan.enabled ? '已开启' : '未开启' }}</span>
      </div>
      <div class="ls-sub">{{ lan.enabled ? '局域网内其他主机可接入本网关' : '当前仅本机可访问' }}</div>
    </div>

    <code v-if="lan.enabled && addrText" class="ls-addr" :title="addrText">{{ addrText }}</code>
    <span v-if="lan.enabled && kindText" class="ls-kind" :class="primary && primary.kind">
      {{ kindText }}<template v-if="moreCount > 0"> · 另有 {{ moreCount }} 个</template>
    </span>

    <div class="ls-actions">
      <button v-if="lan.enabled && addrText" class="btn-ghost sm" @click="copyAddr">
        {{ copied ? '✓ 已复制' : '复制地址' }}
      </button>
      <button class="btn-ghost sm accent" @click="emit('open')">接入详情 →</button>
    </div>
  </div>
  <div v-if="copyErr" class="ls-err">{{ copyErr }}</div>
</template>

<style scoped>
.lan-strip {
  display: flex; align-items: center; gap: 18px;
  padding: 13px 16px; background: var(--card);
  border: 1px solid var(--border); border-radius: 12px;
}
.ls-left { flex: none; min-width: 170px; }
.ls-title { font-size: 12px; color: var(--text-3); display: flex; align-items: center; gap: 7px; }
.ls-badge { font-size: 10.5px; font-weight: 600; border-radius: 6px; padding: 1px 7px; }
.ls-badge.on { color: var(--primary); background: rgba(139,107,214,0.1); border: 1px solid rgba(139,107,214,0.35); }
.ls-badge.off { color: var(--text-3); background: rgba(255,255,255,0.05); border: 1px solid var(--border); }
.ls-sub { font-size: 13px; font-weight: 600; margin-top: 3px; }
.ls-addr {
  flex: 1; min-width: 0; font-family: var(--mono); font-size: 12px; color: var(--emerald-light);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ls-kind {
  flex: none; font-size: 10.5px; font-weight: 600; border-radius: 6px; padding: 1px 7px;
  color: var(--text-3); background: rgba(255,255,255,0.05); border: 1px solid var(--border);
  white-space: nowrap;
}
.ls-kind.lan { color: var(--primary); background: rgba(139,107,214,0.1); border-color: rgba(139,107,214,0.3); }
.ls-kind.tailscale { color: #a5b4fc; background: rgba(129,140,248,0.12); border-color: rgba(129,140,248,0.35); }
.ls-actions { display: flex; gap: 8px; flex: none; }
.btn-ghost.sm { padding: 6px 12px; font-size: 12px; }
.btn-ghost.sm.accent { color: var(--emerald-light); border-color: rgba(139,107,214,0.35); }
.ls-err { font-size: 12px; color: var(--rose); margin-top: -10px; }
</style>
