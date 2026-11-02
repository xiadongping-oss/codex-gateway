<script setup>
defineProps({ title: String, subtitle: String, badge: String })
</script>
<template>
  <section class="card workspace-panel">
    <header class="panel-head"><div><h2>{{ title }}</h2><p v-if="subtitle">{{ subtitle }}</p></div><div class="panel-actions"><span v-if="badge" class="panel-badge">{{ badge }}</span><slot name="actions" /></div></header>
    <slot />
  </section>
</template>
<style scoped>
.workspace-panel { min-width:0; }
.panel-head { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:20px; }
h2 { font-size:14px; font-weight:650; } p { font-size:12px; color:var(--text-3); margin-top:4px; }
.panel-actions { display:flex; align-items:center; flex-wrap:wrap; gap:12px; }
.panel-badge { padding:3px 9px; border-radius:999px; color:var(--primary); background:var(--primary-soft); font-size:11px; white-space:nowrap; }
</style>
