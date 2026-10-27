<script setup>
defineProps({
  logs: { type: Array, required: true }
})

function statusClass(s) {
  if (s === 200) return 's-200'
  if (s === 429) return 's-429'
  if (s >= 500) return 's-500'
  return 's-401'
}
</script>

<template>
  <section class="card c-logs">
    <div class="card-title">最近调用</div>
    <div style="margin-top: 2px">
      <span class="live-tag"><span class="dot"></span>实时流式</span>
    </div>
    <div class="log-list">
      <div v-for="row in logs" :key="row.id" class="log-row">
        <span class="log-method m-post">{{ row.method }}</span>
        <span class="log-endpoint">{{ row.model }} <span style="color: var(--text-3)">{{ row.endpoint }}</span></span>
        <span class="log-model">{{ row.latency }}ms</span>
        <span class="log-status" :class="statusClass(row.status)">{{ row.status }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.c-logs { flex: 1.65; }
</style>
