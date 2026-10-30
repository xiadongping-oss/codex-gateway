// 实时数据 composable（模块级单例）：轮询驱动界面实时刷新。
//
// 设计为单例，供多个页面共享同一份状态与定时器，避免额度计数 / 网关状态分裂。
//
// 数据源：
//   - 网关运行状态、当前账号、代理配置：gateway/launcher.mjs 的 /__gw/*
//   - 模型列表与能力：/__gw/models（服务端 60s 缓存 + 本地目录兜底）
//   - 真实调用计数 / Token 用量：/__gw/status 的 metrics.tokensTotal（后端实算，跨页共享）
//   - 最近调用明细：/__gw/call-logs（网关反代层逐笔记录）
//
// 【性能约束】
//   1. 同一时刻只允许一轮 refresh 在飞（in-flight 守卫），
//      否则慢响应会让请求量翻倍并出现「旧响应覆盖新响应」的竞态。
//   2. 能力（capabilities）由模型列表派生，不再单独发一次 /__gw/models——
//      此前 getCapabilities() 内部又调了一遍 getModels()，每轮多打一次请求。
//   3. 调用日志独立轮询（2s），不与主状态轮询（1.5s）耦合。

import { ref, computed } from 'vue'
import * as api from '../api/gateway'
import { parseBase } from '../api/client'

function settle(p) {
  return Promise.resolve(p).then(
    (v) => ({ ok: true, value: v }),
    (e) => ({ ok: false, error: e?.message || String(e) })
  )
}

// 能力显示开关的本地偏好：只记「关掉哪些」，不允许凭空开启
const CAP_OFF_KEY = 'cgw.capability.off'
function loadCapOff() {
  try {
    const j = JSON.parse(localStorage.getItem(CAP_OFF_KEY) || '{}')
    return { text: !!j.text, image: !!j.image, vision: !!j.vision }
  } catch {
    return { text: false, image: false, vision: false }
  }
}
function saveCapOff(v) {
  try { localStorage.setItem(CAP_OFF_KEY, JSON.stringify(v)) } catch {}
}

function createLiveData() {
  const initBase = parseBase()

  // ---- 基础状态（空态填默认值，请求成功后覆盖） ----
  const status = ref({ running: false, host: initBase.host, port: initBase.port, version: '—', qps: 0, uptime: '00:00:00', metrics: { requests: 0, rateLimited: 0 } })
  const account = ref({ loggedIn: false, accountId: null, name: '—', provider: '—', method: '—', email: '—', expiresAt: '—', detail: '' })
  const models = ref([])
  const health = ref(null)

  // ---- 能力：base 来自上游模型目录，capOff 是本机的「隐藏」偏好 ----
  const capabilitiesBase = ref({ text: false, image: false, vision: false })
  const capOff = ref(loadCapOff())
  const capabilities = computed(() => ({
    text: capabilitiesBase.value.text && !capOff.value.text,
    image: capabilitiesBase.value.image && !capOff.value.image,
    vision: capabilitiesBase.value.vision && !capOff.value.vision
  }))

  // 切换某个能力的显示。
  //   - 上游本就不支持的能力：不可开启（点击无效果，UI 侧已置灰）
  //   - 上游支持的能力：可在「显示 / 隐藏」之间切换，偏好落 localStorage
  function toggleCapability(key) {
    if (!key) return
    if (!capabilitiesBase.value[key]) return
    const next = { ...capOff.value, [key]: !capOff.value[key] }
    capOff.value = next
    saveCapOff(next)
  }

  // ---- 错误位与时间戳（用于 UI 显示"X 秒前拉取 / 失败"） ----
  const lastFetchAt = ref(0)
  const lastError = ref('')
  const errFlags = ref({ status: 0, account: 0, models: 0, capabilities: 0 })

  // ---- 网关生命周期 ----
  const gw = ref({ running: false, pid: null, startedAt: null, uptimeSec: 0, health: null, config: {} })
  const gwLogs = ref([])
  const gwBusy = ref(false)
  const gwConnected = ref(null)
  const gwActionError = ref('')

  // ---- 刷新策略 ----
  let refreshing = false
  async function refresh() {
    // in-flight 守卫：慢响应时不重复发起，避免请求量与竞态同时恶化
    if (refreshing) return
    refreshing = true
    try {
      lastError.value = ''
      const [r1, r2, r3] = await Promise.all([
        settle(api.getProxyStatus()),
        settle(api.getAccount()),
        settle(api.getModels())
      ])
      if (r1.ok) { status.value = r1.value; errFlags.value.status = 0 }
      else { errFlags.value.status = Date.now() }
      if (r2.ok) { account.value = r2.value; errFlags.value.account = 0 }
      else { errFlags.value.account = Date.now() }
      if (r3.ok) { models.value = r3.value || []; errFlags.value.models = 0 }
      else { errFlags.value.models = Date.now() }

      // 能力由模型列表就地派生：不额外发请求
      const derived = api.deriveCapabilities(models.value)
      capabilitiesBase.value = derived
      errFlags.value.capabilities = 0

      const anyErr = [r1, r2, r3].find((r) => !r.ok)
      if (anyErr) lastError.value = anyErr.error
      lastFetchAt.value = Date.now()
    } finally {
      refreshing = false
    }
  }

  let gwRefreshing = false
  async function refreshGateway() {
    if (gwRefreshing) return
    gwRefreshing = true
    try {
      const [r1, r2] = await Promise.all([
        settle(api.getGatewayStatus()),
        settle(api.getGatewayLogs())
      ])
      gwConnected.value = !!(r1.ok && r1.value && typeof r1.value.running === 'boolean')
      if (gwConnected.value) gw.value = r1.value
      if (r2.ok && r2.value && r2.value.lines) gwLogs.value = r2.value.lines
    } finally {
      gwRefreshing = false
    }
  }

  // ---- 最近调用（概览页「最近调用」卡片） ----
  const logs = ref([])
  let logsLoading = false
  async function refreshLogs() {
    if (logsLoading) return
    logsLoading = true
    try {
      const r = await settle(api.getLogs())
      if (r.ok && Array.isArray(r.value)) logs.value = r.value
    } finally {
      logsLoading = false
    }
  }

  // 业务层可主动塞入一条调用记录（例如本地发起的一次探测）
  function addLog(entry) {
    const wrapped = {
      id: 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      createdAt: new Date().toISOString(),
      ...entry
    }
    logs.value = [wrapped, ...logs.value].slice(0, 200)
  }

  async function diagnose() {
    const r = await settle(api.diagnose())
    if (r.ok) health.value = r.value
    await refresh()
    return r.ok
  }

  async function gwStart() {
    if (gwBusy.value) return
    gwActionError.value = ''
    gwBusy.value = true
    try {
      const result = await api.startGateway()
      if (!result || result.ok === false) throw new Error('启动失败')
      setTimeout(refreshGateway, 600)
      await refreshGateway()
    } catch {
      gwActionError.value = '启动失败，请检查控制台登录状态与运行日志。'
    } finally {
      gwBusy.value = false
    }
  }
  async function gwStop() {
    if (gwBusy.value) return
    gwActionError.value = ''
    gwBusy.value = true
    try {
      const result = await api.stopGateway()
      if (!result || result.ok === false) throw new Error('停止失败')
      await refreshGateway()
    } catch {
      gwActionError.value = '操作未完成，请检查控制台登录状态与运行日志。'
    } finally {
      gwBusy.value = false
    }
  }
  async function gwRestart() {
    if (gwBusy.value) return
    gwActionError.value = ''
    gwBusy.value = true
    try {
      const result = await api.restartGateway()
      if (!result || result.ok === false) throw new Error('重启失败')
      setTimeout(refreshGateway, 1200)
      await refreshGateway()
    } catch {
      gwActionError.value = '操作未完成，请检查控制台登录状态与运行日志。'
    } finally {
      gwBusy.value = false
    }
  }

  // 首屏拉一次 → 后续定时刷新
  refresh()
  refreshGateway()
  refreshLogs()
  setInterval(refresh, 1500)
  setInterval(refreshGateway, 3000)
  setInterval(refreshLogs, 2000)

  return {
    status, account, capabilities, capabilitiesBase, models, health, logs,
    lastFetchAt, lastError, errFlags,
    gw, gwLogs, gwBusy, gwConnected, gwActionError,
    diagnose, gwStart, gwStop, gwRestart, addLog, toggleCapability,
    refresh, refreshLogs
  }
}

let instance = null
export function useLiveData() {
  if (!instance) instance = createLiveData()
  return instance
}
