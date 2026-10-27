<script setup>
import { computed } from 'vue'
import { parseBase } from '../api/client'

const props = defineProps({
  active: { type: String, default: 'overview' },
  gwRunning: { type: Boolean, default: true },
  collapsed: { type: Boolean, default: false }
})
const emit = defineEmits(['navigate', 'toggle'])

// 对外端口：此前硬编码 127.0.0.1:10531（bridge 内部端口），
// 外部客户端连不到、局域网用户按它填必然连不上。改为真实启动器端口。
const endpoint = computed(() => {
  const { host, port } = parseBase()
  return `${host}:${port}`
})

const nav = [
  { key: 'overview', label: '概览', icon: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z' },
  { key: 'account', label: '账号管理', icon: 'M12 8a4 4 0 100-8 4 4 0 000 8zM4 21c0-4 4-6 8-6s8 2 8 6' },
  { key: 'images', label: '图片素材', icon: 'M4 5h16v14H4zM4 15l4-4 3 3 4-5 5 6M8.5 9a1.2 1.2 0 100-2.4 1.2 1.2 0 000 2.4z' },
  { key: 'models', label: '模型能力', icon: 'M12 2l9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 17l9 5 9-5' },
  { key: 'apikeys', label: 'API Key', icon: 'M21 2l-2 2m0 0l-9 9-2-2 9-9 2 2zM7.5 15.5L5 18l3 3 2.5-2.5' },
  { key: 'logs', label: '调用日志', icon: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01' },
  { key: 'settings', label: '设置', icon: 'M12 12a3 3 0 100-6 3 3 0 000 6z' }
]
</script>

<template>
  <aside class="sidebar" :class="{ collapsed }">
    <div class="logo">
      <div class="logo-mark">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#04130D" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" /></svg>
      </div>
      <div v-if="!collapsed" class="logo-text-wrap">
        <div class="logo-text">Codex 网关</div>
        <div class="logo-sub">local · bridge</div>
      </div>
      <button
        class="collapse-btn inline"
        :title="collapsed ? '展开侧栏' : '收起侧栏'"
        @click="emit('toggle')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path v-if="!collapsed" d="M15 6l-6 6 6 6" />
          <path v-else d="M9 6l6 6-6 6" />
        </svg>
      </button>
    </div>

    <nav class="nav">
      <div
        v-for="item in nav"
        :key="item.key"
        class="nav-item"
        :class="{ active: active === item.key }"
        :title="collapsed ? item.label : ''"
        @click="emit('navigate', item.key)"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path :d="item.icon" /></svg>
        <span v-if="!collapsed">{{ item.label }}</span>
      </div>
    </nav>

    <div class="nav-spacer"></div>

    <div class="status-box" :title="collapsed ? ('本地代理 · ' + (gwRunning ? '运行中' : '已停止')) : ''">
      <div class="status-dot" :class="{ off: !gwRunning }"></div>
      <div v-if="!collapsed">
        <div class="status-label">本地代理 · {{ gwRunning ? '运行中' : '已停止' }}</div>
        <div class="status-meta" style="font-family: var(--mono); font-size: 11px; color: var(--text-3)">{{ endpoint }}</div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 248px; flex-shrink: 0; background: var(--sidebar);
  border-right: 1px solid var(--border);
  display: flex; flex-direction: column; padding: 20px 14px;
  transition: width 0.2s ease;
}
.sidebar.collapsed { width: 64px; padding: 20px 10px; }
.logo { display: flex; align-items: center; gap: 10px; padding: 6px 4px 20px; }
.sidebar.collapsed .logo { flex-direction: column; gap: 8px; padding: 6px 0 20px; }
.logo-mark {
  width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0;
  background: linear-gradient(135deg, var(--emerald), #059669);
  display: flex; align-items: center; justify-content: center;
}
.logo-text-wrap { min-width: 0; flex: 1; }
.logo-text { font-weight: 600; font-size: 15px; letter-spacing: 0.2px; white-space: nowrap; }
.logo-sub { font-size: 11px; color: var(--text-3); font-family: var(--mono); white-space: nowrap; }
.collapse-btn {
  background: transparent; color: var(--text-3); border: 1px solid transparent; border-radius: 7px;
  width: 26px; height: 26px; flex-shrink: 0; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s ease;
}
.collapse-btn:hover { color: var(--text); background: rgba(255, 255, 255, 0.06); }
.collapse-btn svg { width: 15px; height: 15px; }
.nav { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; }
.nav-item {
  display: flex; align-items: center; gap: 11px; padding: 9px 10px; border-radius: 8px;
  color: var(--text-2); font-size: 13.5px; font-weight: 450; cursor: pointer;
  transition: all 0.15s ease; user-select: none; white-space: nowrap;
}
.sidebar.collapsed .nav-item { justify-content: center; padding: 9px 0; }
.nav-item:hover { background: rgba(255, 255, 255, 0.04); color: var(--text); }
.nav-item.active { background: var(--emerald-dim); color: var(--emerald-light); }
.nav-item svg { width: 17px; height: 17px; flex-shrink: 0; }
.nav-spacer { flex: 1; }
.status-box {
  margin-top: 14px; padding: 12px 13px; background: var(--card);
  border: 1px solid var(--border); border-radius: 10px; display: flex; align-items: center; gap: 10px;
}
.sidebar.collapsed .status-box { justify-content: center; padding: 10px 0; }
.status-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--emerald); flex-shrink: 0; }
.status-dot.off { background: var(--rose); }
.status-label { font-size: 12.5px; font-weight: 500; white-space: nowrap; }
</style>
