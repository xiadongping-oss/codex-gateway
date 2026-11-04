<script setup>
defineProps({ title: String, subtitle: String, badge: String })
</script>
<template>
  <section class="card workspace-panel">
    <header class="panel-head"><div class="panel-title"><h2>{{ title }}</h2><span v-if="subtitle" class="panel-help" tabindex="0" :title="subtitle" :aria-label="title + '：' + subtitle">ⓘ</span><span v-if="badge" class="panel-badge">{{ badge }}</span><slot name="title-extra" /></div><div class="panel-actions"><slot name="actions" /></div></header>
    <slot />
  </section>
</template>
<style scoped>
.workspace-panel { min-width:0; }
.panel-title { display:flex; align-items:center; flex-wrap:wrap; gap:10px; min-width:0; }
.panel-help { font-size:12px; color:var(--text-3); cursor:help; }
.panel-help:focus-visible { outline:2px solid var(--primary); outline-offset:3px; border-radius:4px; }
.panel-head { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:20px; }
h2 { font-size:14px; font-weight:650; margin:0; }
.panel-actions { display:flex; align-items:center; flex-wrap:wrap; gap:12px; }
.panel-badge { padding:3px 9px; border-radius:999px; color:var(--primary); background:var(--primary-soft); font-size:11px; white-space:nowrap; }
</style>
