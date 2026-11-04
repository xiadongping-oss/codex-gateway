<script setup>
import { useTheme } from '../composables/useTheme'
defineProps({ title: { type: String, default: '网关概览' } })
const { theme, themeError, toggleTheme } = useTheme()
</script>

<template>
  <header class="topbar">
    <div class="page-heading">
      <h1>{{ title }}</h1>
      <div id="page-tabs" class="header-tabs"><slot /></div>
    </div>
    <button class="theme-toggle" @click="toggleTheme" :aria-label="theme === 'light' ? '切换深色主题' : '切换浅色主题'" :title="theme === 'light' ? '切换深色主题' : '切换浅色主题'">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path v-if="theme === 'light'" d="M20 14A8 8 0 0110 4a8.5 8.5 0 1010 10Z"/><g v-else><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/></g></svg>
    </button>
  </header>
  <p v-if="themeError" class="theme-error" role="alert">{{ themeError }}</p>
</template>

<style scoped>
.topbar { display:flex; align-items:center; gap:16px; flex-shrink:0; min-height:68px; padding:12px 24px; }
.page-heading { display:flex; align-items:center; flex-wrap:wrap; gap:12px 24px; flex:1; min-width:0; }
h1 { font-size:19px; line-height:1.5; font-weight:650; letter-spacing:-.3px; white-space:nowrap; margin:0; }
.header-tabs { min-width:0; max-width:100%; }
.header-tabs:empty { display:none; }
.header-tabs :deep(.workspace-sections), .header-tabs :deep(.tabs) { margin:0; }
.theme-toggle { flex:none; width:32px; height:32px; display:grid; place-items:center; border:1px solid var(--border); border-radius:8px; background:var(--card); color:var(--text-2); cursor:pointer; }
.theme-error { margin:0 24px 12px; color:var(--rose); font-size:12px; }
@media(max-width:680px) { .topbar { padding:12px 14px; align-items:flex-start; } h1 { font-size:17px; } .page-heading { gap:8px 16px; } }
</style>
