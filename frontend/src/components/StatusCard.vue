<script setup>
defineProps({
  status: { type: Object, required: true }
})
</script>

<template>
  <section class="card c-status">
    <div class="status-head">
      <span class="status-badge">
        <span class="status-dot"></span>
        {{ status.running ? '代理运行中' : '代理已停止' }}
      </span>
    </div>
    <div class="metrics">
      <div class="metric">
        <div class="metric-label">本地接口</div>
        <div class="metric-value">{{ status.host }}</div>
      </div>
      <div class="metric">
        <div class="metric-label">监听端口</div>
        <div class="metric-value">{{ status.port }}</div>
      </div>
      <div class="metric">
        <div class="metric-label">请求 / 秒</div>
        <div class="metric-value">{{ status.qps }}<span class="unit">req/s</span></div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.c-status { flex: 1.65; }
</style>
