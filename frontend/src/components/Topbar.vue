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

const theme = ref(localStorage.getItem('cgw.theme') === 'dark' ? 'dark' : 'light')
document.documentElement.dataset.theme = theme.value
function toggleTheme() {
  theme.value = theme.value === 'light' ? 'dark' : 'light'
  document.documentElement.dataset.theme = theme.value
  localStorage.setItem('cgw.theme', theme.value)
}
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
    const text = formatAccessConfig(cfg.baseUrl, cfg.apiKey, cfg.model)
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
      <button class="theme-toggle" @click="toggleTheme" :aria-label="theme === 'light' ? '切换深色主题' : '切换浅色主题'" :title="theme === 'light' ? '切换深色主题' : '切换浅色主题'">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path v-if="theme === 'light'" d="M20 14A8 8 0 0110 4a8.5 8.5 0 1010 10Z"/><g v-else><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/></g></svg>
      </button>
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

.topbar { height: 96px; border: 0; padding: 0 32px; gap: 16px; }
.topbar h1 { font-size: 23px; font-weight: 650; letter-spacing: -.5px; }
.subtitle { font-family: inherit; margin-top: 5px; }
.ver-chip { border: 0; background: var(--card-2); vertical-align: 3px; }
.topbar-right { gap: 10px; }
.topbar-right .pill, .addr-chip { display: none; }
.theme-toggle { border: 1px solid var(--border); background: var(--card); color: var(--text-2); width: 40px; height: 40px; display: grid; place-items: center; border-radius: 50%; cursor: pointer; }
.copy-err { color: var(--rose); background: var(--card); }
@media(max-width:680px) { .topbar { height: auto; min-height: 96px; padding: 18px; flex-wrap: wrap; } .topbar h1 { font-size: 20px; } .subtitle { font-size: 11px; } }
</style>
