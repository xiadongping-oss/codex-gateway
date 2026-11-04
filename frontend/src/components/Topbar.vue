<script setup>
import { useTheme } from '../composables/useTheme'

// 构建时由 vite define 注入（根 package.json 的 version）。
// 双保险判空：测试环境 / 直接引源码跑 dev 时未 define 也不炸。
const gwVersion = typeof __GW_VERSION__ !== 'undefined' ? __GW_VERSION__ : ''

defineProps({
  title: { type: String, default: '网关概览' },
  subtitle: { type: String, default: '本地 Codex 网关' },
  address: { type: String, default: '' },
  running: { type: Boolean, default: true }
})

const { theme, themeError, toggleTheme } = useTheme()
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
      <span class="pill" :class="{ off: !running }">
        <span class="dot" :class="{ off: !running }"></span>{{ running ? '运行中' : '已停止' }}
      </span>

    </div>
  </header>
  <div v-if="themeError" class="copy-err" role="alert">{{ themeError }}</div>
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
.topbar{height:78px;min-height:78px;padding:12px 24px;gap:16px}.topbar h1{font-size:19px;font-weight:650;letter-spacing:-.3px}.subtitle{font-size:11px;margin-top:4px}.theme-toggle{width:32px;height:32px;border-radius:8px}.topbar-right .btn-primary{font-size:12px;padding:8px 12px;border-radius:8px}.ver-chip{font-size:10px;vertical-align:2px}
@media(max-width:680px){.topbar{height:auto;min-height:78px;padding:14px;align-items:flex-start;flex-wrap:wrap;gap:10px}.topbar h1{font-size:17px}.topbar-right{margin-left:auto}.subtitle{max-width:250px}}
</style>
