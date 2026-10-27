<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import Sidebar from './components/Sidebar.vue'
import Topbar from './components/Topbar.vue'
import Overview from './views/Overview.vue'
import Accounts from './views/Accounts.vue'
import Images from './views/Images.vue'
import Logs from './views/Logs.vue'
import Models from './views/Models.vue'
import ApiKeys from './views/ApiKeys.vue'
import Settings from './views/Settings.vue'
import { useLiveData } from './composables/useLiveData'

const activePage = ref('overview')
const { gw } = useLiveData()

// 侧栏折叠状态（记忆到 localStorage）
const sidebarCollapsed = ref(localStorage.getItem('gw.sidebar.collapsed') === '1')
function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
  localStorage.setItem('gw.sidebar.collapsed', sidebarCollapsed.value ? '1' : '0')
}

// 窄屏自动收起侧栏。
// 侧栏样式是 scoped 的，CSS 媒体查询压不过组件内的 width 规则，
// 因此这里用 JS 状态驱动：窗口窄于 900px 时强制图标条，
// 宽屏时恢复用户手动选择的展开/折叠状态。
const NARROW_QUERY = '(max-width: 900px)'
const narrow = ref(typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia(NARROW_QUERY).matches
  : false)
let mql = null
function onNarrowChange(e) { narrow.value = e.matches }
onMounted(() => {
  if (typeof window === 'undefined' || !window.matchMedia) return
  mql = window.matchMedia(NARROW_QUERY)
  narrow.value = mql.matches
  if (mql.addEventListener) mql.addEventListener('change', onNarrowChange)
  else if (mql.addListener) mql.addListener(onNarrowChange)
})
onUnmounted(() => {
  if (!mql) return
  if (mql.removeEventListener) mql.removeEventListener('change', onNarrowChange)
  else if (mql.removeListener) mql.removeListener(onNarrowChange)
  mql = null
})
// 窄屏时切换按钮无意义（已是图标条），直接忽略
const effectiveCollapsed = computed(() => narrow.value || sidebarCollapsed.value)
function onToggleSidebar() {
  if (narrow.value) return
  toggleSidebar()
}

const titles = {
  overview: { title: '网关概览', subtitle: '本地 Codex 网关 · 运行状态与用量' },
  account: { title: '账号管理', subtitle: '多账号 · 登录态 · 网关运行控制' },
  images: { title: '图片素材', subtitle: '生成图库 · 本地与云端素材统一管理' },
  models: { title: '模型能力', subtitle: '模型 · 视觉理解 · OpenAI 兼容接口' },
  apikeys: { title: 'API Key 管理', subtitle: '给外部客户端用的网关层 Token' },
  logs: { title: '调用日志', subtitle: '实时调用记录 · Bridge 运行日志' },
  settings: { title: '设置', subtitle: '代理与接入配置' }
}
</script>

<template>
  <div class="app">
    <Sidebar :active="activePage" :gw-running="gw.running" :collapsed="effectiveCollapsed" @navigate="activePage = $event" @toggle="onToggleSidebar" />

    <main class="main">
      <Topbar :title="titles[activePage].title" :subtitle="titles[activePage].subtitle" :running="gw.running" />

      <Overview v-if="activePage === 'overview'" @navigate="activePage = $event" />
      <Accounts v-else-if="activePage === 'account'" />
      <Images v-else-if="activePage === 'images'" />
      <Logs v-else-if="activePage === 'logs'" />
      <Models v-else-if="activePage === 'models'" @navigate="activePage = $event" />
      <ApiKeys v-else-if="activePage === 'apikeys'" />
      <Settings v-else-if="activePage === 'settings'" />
    </main>
  </div>
</template>

<style scoped>
.app { display: flex; height: 100vh; }
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
</style>
