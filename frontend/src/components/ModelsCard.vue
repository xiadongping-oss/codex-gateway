<script setup>
const props = defineProps({
  capabilities: { type: Object, required: true },
  // 上游真实支持的能力（未隐藏前的原始值）。
  // 用于区分「该能力存在但被本机隐藏」与「上游本就不提供」——
  // 后者的开关应置灰不可点，避免出现「点了没反应」的错觉。
  supported: { type: Object, default: null }
})
const emit = defineEmits(['toggle'])

const list = [
  { key: 'text', name: 'Codex 文本', desc: '/v1/chat · /v1/responses' },
  { key: 'image', name: '图片生成', desc: '/v1/images/generations' },
  { key: 'vision', name: '视觉理解', desc: '多模态输入' }
]

function isSupported(key) {
  if (!props.supported) return true
  return !!props.supported[key]
}
</script>

<template>
  <section class="card c-models">
    <div class="card-title">模型能力 <span class="capability-help" tabindex="0" title="开关只影响本机界面的显示与隐藏，不会改变网关实际开放的接口。" aria-label="开关只影响本机界面的显示与隐藏，不会改变网关实际开放的接口。">ⓘ</span></div>
    <div class="card-sub">OpenAI 兼容接口</div>
    <div style="margin-top: 14px">
      <div v-for="item in list" :key="item.key" class="toggle-row">
        <div class="toggle-info">
          <div class="t-name">
            {{ item.name }}
            <span v-if="!isSupported(item.key)" class="t-tag off">上游未提供</span>
            <span v-else-if="!capabilities[item.key]" class="t-tag hidden">已隐藏</span>
          </div>
          <div class="t-desc">{{ item.desc }}</div>
        </div>
        <div
          class="switch"
          :class="{ on: capabilities[item.key], disabled: !isSupported(item.key) }"
          :title="isSupported(item.key) ? (capabilities[item.key] ? '点击隐藏' : '点击显示') : '当前模型目录未提供该能力'"
          @click="isSupported(item.key) && emit('toggle', item.key)"
        ></div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.c-models { flex: 1; }
.t-tag {
  display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 999px;
  font-size: 10px; font-weight: 600; vertical-align: middle;
}
.t-tag.off { background: rgba(255,255,255,0.06); color: var(--text-3); border: 1px solid var(--border); }
.t-tag.hidden { background: rgba(245,158,11,0.12); color: #fbbf24; border: 1px solid rgba(245,158,11,0.28); }
.switch.disabled { opacity: 0.35; cursor: not-allowed; }
.capability-help { display: inline-flex; align-items: center; justify-content: center; margin-left: 4px; color: var(--text-3); font-size: 13px; font-weight: 400; cursor: help; border-radius: 4px; }
.capability-help:hover, .capability-help:focus-visible { color: var(--primary); }
.capability-help:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
</style>
