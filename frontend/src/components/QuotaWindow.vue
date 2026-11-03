<script setup>
import { computed } from 'vue'
const props = defineProps({ quota: {type:Object,required:true}, compact:Boolean })
const remaining = computed(() => Math.max(0,Math.min(100,Number(props.quota.remainingPercent)||0)))
const label = computed(() => /^weekly$/i.test(props.quota.label || '') ? '每周额度' : props.quota.label || '用量窗口')
const reset = computed(() => !props.quota.resetIn || props.quota.resetIn === '—' ? '重置时间未提供' : props.quota.resetIn === '已重置' ? '已重置' : props.quota.resetIn + '后重置')
</script>
<template>
  <section class="quota-window" :class="[quota.tone,{compact}]" :aria-label="label">
    <div class="window-label">{{ label }}</div>
    <div class="window-reading"><strong>{{ remaining }}<small>%</small></strong><span>剩余额度</span></div>
    <div class="window-track" role="progressbar" :aria-label="label + '剩余额度'" :aria-valuenow="remaining" aria-valuemin="0" aria-valuemax="100"><div class="window-fill" :style="{width:remaining+'%'}"></div></div>
    <div class="window-foot"><span>已用 {{ quota.usedPercent }}%</span><span>{{ reset }}</span></div>
  </section>
</template>
<style scoped>
.quota-window { padding:20px; border:1px solid var(--border); border-radius:12px; background:var(--bg); min-width:0; --quota-tone:var(--primary); }
.window-label { font-size:12px; color:var(--primary); font-weight:650; letter-spacing:.02em; }
.window-reading { display:flex; align-items:baseline; gap:10px; margin:10px 0 16px; }
.window-reading strong { color:var(--quota-tone); font:600 32px/1.15 var(--mono); letter-spacing:-1px; }
.window-reading small { font-size:16px; margin-left:3px; letter-spacing:0; }
.window-reading>span { color:var(--text-3); font-size:11px; }
.window-track { height:6px; background:var(--border-strong); border-radius:999px; overflow:hidden; }
.window-fill { height:100%; background:var(--quota-tone); border-radius:inherit; transition:width .3s; }
.window-foot { display:flex; flex-wrap:wrap; justify-content:space-between; gap:6px 16px; margin-top:10px; font-size:11px; color:var(--text-3); }
.amber { --quota-tone:var(--amber); }.rose { --quota-tone:var(--rose); }
.compact { padding:16px; }.compact .window-reading { margin:8px 0 12px; }.compact .window-reading strong { font-size:25px; }.compact .window-foot { font-size:10.5px; }
@media(prefers-reduced-motion:reduce) { .window-fill { transition:none; } }
</style>
