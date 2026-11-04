<script setup>
defineProps({ title: String, subtitle: String, badge: String })
</script>
<template>
  <section class="card workspace-panel">
    <header class="panel-head"><div class="panel-title"><h2>{{ title }}</h2><details v-if="subtitle" class="panel-help"><summary :aria-label="title + '说明'">ⓘ</summary><p>{{ subtitle }}</p></details></div><div class="panel-actions"><span v-if="badge" class="panel-badge">{{ badge }}</span><slot name="actions" /></div></header>
    <slot />
  </section>
</template>
<style scoped>
.workspace-panel { min-width:0; }
.panel-title { display:flex; align-items:center; flex-wrap:wrap; gap:10px; }
.panel-help { font-size:11px; color:var(--text-3); }
.panel-help summary { cursor:pointer; list-style:none; }
.panel-help summary::-webkit-details-marker { display:none; }
.panel-help[open] { flex-basis:100%; }
.panel-help p { max-width:65ch; line-height:1.7; margin:6px 0 0; }
.panel-head { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:20px; }
h2 { font-size:14px; font-weight:650; } p { font-size:12px; color:var(--text-3); margin-top:4px; }
.panel-actions { display:flex; align-items:center; flex-wrap:wrap; gap:12px; }
.panel-badge { padding:3px 9px; border-radius:999px; color:var(--primary); background:var(--primary-soft); font-size:11px; white-space:nowrap; }
</style>
