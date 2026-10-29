<script setup>
import { ref, computed, onMounted } from 'vue'
import { loadAccessConfig, loadAccessConfigWithKey, formatAccessConfig } from '../api/access-config'
import { copyText } from '../api/client'

// 构建时由 vite define 注入（根 package.json 的 version）。
// 双保险判空：测试环境 / 直接引源码跑 dev 时未 define 也不炸。
const gwVersion = typeof __GW_VERSION__ !== 'undefined' ? __GW_VERSION__ : ''

const props = defineProps({
  title: { type: String, default: '网关概览' },
  subtitle: { type: String, default: '本地 Codex 网关' },
  address: { type: String, default: '' },
  running: { type: Boolean, default: true }
})

const copied = ref(false)
const copyErr = ref('')
const access = ref({ baseUrl: props.address, apiKey: null })
onMounted(() => { loadAccessConfig().then((c) => (access.value = { ...access.value, ...c })) })

// 展示地址：优先用控制面返回的真实启动器地址（启动器端口），
// 回退到 props.address。此前硬编码默认 10531（bridge 内部端口）——
// 外部客户端访问不到，且局域网用户按它填会直接连不上。
const shownAddress = computed(() => access.value?.baseUrl || props.address || '')

// 复制时才取明文密钥：地址常驻展示，密钥不进入轮询与 DOM 常驻态
async function copyConfig() {
  copyErr.value = ''
  try {
    const cfg = await loadAccessConfigWithKey()
    access.value = { ...access.value, ...cfg }
    const text = formatAccessConfig(cfg.baseUrl, cfg.apiKey)
    await copyText(text)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch (e) {
    copyErr.value = e?.message || '复制失败'
  }
}
</script>

<template>
  <header class="topbar">
    <div>
      <h1>{{ title }}<span v-if="gwVersion" class="ver-chip" :title="'网关版本 ' + gwVersion">v{{ gwVersion }}</span></h1>
      <div class="subtitle">{{ subtitle }}</div>
    </div>
    <div class="topbar-right">
      <span class="addr-chip">{{ shownAddress }}</span>
      <span class="pill" :class="{ off: !running }">
        <span class="dot" :class="{ off: !running }"></span>{{ running ? '运行中' : '已停止' }}
      </span>
      <button class="btn-primary" @click="copyConfig">
        {{ copied ? '已复制 ✓' : '复制接入配置' }}
      </button>
    </div>
  </header>
  <div v-if="copyErr" class="copy-err">{{ copyErr }}</div>
</template>

<style scoped>
.topbar {
  height: 64px; flex-shrink: 0; border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between; padding: 0 24px;
}
.topbar h1 { font-size: 17px; font-weight: 600; letter-spacing: 0.2px; }
.ver-chip {
  margin-left: 10px; vertical-align: 2px;
  font-size: 11px; font-weight: 500; font-family: var(--mono);
  color: var(--text-3); border: 1px solid var(--border);
  padding: 1px 7px; border-radius: 999px; letter-spacing: 0.3px;
}
.subtitle { font-size: 12px; color: var(--text-3); font-family: var(--mono); margin-top: 2px; }
.topbar-right { display: flex; align-items: center; gap: 12px; }
.pill.off { color: var(--rose); background: rgba(244,63,94,0.12); }
.pill.off .dot.off { background: var(--rose); }
.copy-err {
  position: absolute; top: 56px; right: 24px; z-index: 40;
  background: rgba(244,63,94,0.14); border: 1px solid rgba(244,63,94,0.35);
  color: #fda4af; font-size: 12px; padding: 6px 10px; border-radius: 8px;
}
</style>
