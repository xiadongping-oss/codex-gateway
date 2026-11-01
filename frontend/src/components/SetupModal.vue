<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import * as api from '../api/gateway'
import { PROVIDER_PRESETS, CUSTOM_PROVIDER_ID } from '../api/providerPresets'
import { copyText as writeClipboard } from '../api/client'
import { vModalFocus } from '../composables/modalFocus'

const emit = defineEmits(['close', 'changed'])
const tabs = [
  { key: 'tempLogin', label: '官方登录' },
  { key: 'oauth', label: 'OAuth 授权' },
  { key: 'json', label: 'Token / JSON' },
  { key: 'apikey', label: 'API Key' },
  { key: 'import', label: '导入' }
]
const active = ref('oauth')
const loading = ref(false)
const error = ref('')
const okMsg = ref('')
let disposed = false
let actionGeneration = 0
const actionCurrent = generation => !disposed && generation === actionGeneration

const mode = ref('bridge')
const hasApiKey = ref(false)

// 待授权卡片
const email = ref('')
const note = ref('')
const showNote = ref(false)
const pendingId = ref('')

// OAuth 两种授权方式
const authMode = ref('browser')
const browser = ref(null)
const device = ref(null)
const pendingOAuthImport = computed(() => !!(browser.value?.pendingImport || device.value?.pendingImport))
let startingOAuthSource = ''
const callbackUrl = ref('')
const polling = ref(false)
let pollTimer = null
let authPollGeneration = 0

// Token·JSON（多格式文本，见 parseAuthTokenText）
const jsonText = ref('')
const showExamples = ref(false)

// 导入
const importFile = ref(null)

// API Key（供应商快选 + Key）
const savedProviders = ref([])
const providerPresetId = ref(CUSTOM_PROVIDER_ID)
const providerBaseUrl = ref('')
const apiKey = ref('')
const showApiKey = ref(false)
const activePreset = computed(() => PROVIDER_PRESETS.find((p) => p.id === providerPresetId.value) || null)

// ---------- 官方客户端临时登录（6 步骤流程） ----------
const TEMP_STEPS = [
  { key: 'preparing', label: '准备临时配置' },
  { key: 'launching', label: '打开官方客户端' },
  { key: 'waiting-login', label: '等待登录完成' },
  { key: 'closing', label: '关闭官方客户端' },
  { key: 'importing', label: '读取登录信息' },
  { key: 'cleaning', label: '完成导入' }
]
const tempSession = ref(null) // { sessionId, clientPath }
const tempPhase = ref('idle') // idle | running | completed | failed
const tempError = ref('')
const tempDoneSteps = ref(0) // 已完成的步骤数（0-6）
const tempHint = ref('')
const tempRunning = computed(() => tempPhase.value === 'running')
let tempTimer = null
let tempGeneration = 0
let tempPolling = false
const tempImporting = ref(false)
const tempRetryable = ref(false)

function tempStepState(i) {
  // i: 0-5；已完成 = index < tempDoneSteps；当前活跃 = index === tempDoneSteps && running
  if (tempDoneSteps.value > i) return 'done'
  if (tempRunning.value && tempDoneSteps.value === i) return 'active'
  return 'pending'
}

async function startTempLogin() {
  if (tempImporting.value || loading.value) return
  loading.value = true
  error.value = ''; tempError.value = ''; okMsg.value = ''
  if (tempSession.value?.sessionId && !await cancelTempLogin()) { loading.value = false; return }
  if (disposed) return
  const generation = ++tempGeneration
  error.value = ''
  okMsg.value = ''
  tempError.value = ''
  tempDoneSteps.value = 0
  tempHint.value = ''
  tempRetryable.value = false
  loading.value = true
  try {
    const r = await api.officialLoginStart()
    if (generation !== tempGeneration) {
      if (r?.sessionId) api.officialLoginCancel(r.sessionId).catch(() => {})
      return
    }
    if (!r?.ok || !r.sessionId) return setError(r?.detail || '启动失败：未获得登录会话')
    tempSession.value = r
    tempPhase.value = 'running'
    tempDoneSteps.value = 2 // preparing + launching 已由后端完成
    tempHint.value = '已发出启动命令，等待官方客户端登录。'
    pollTempLogin()
  } catch (e) {
    if (generation === tempGeneration) setError(e)
  } finally {
    loading.value = false
  }
}

function pollTempLogin() {
  stopTempPoll()
  tempTimer = setInterval(async () => {
    if (tempPolling) return
    if (!tempSession.value?.sessionId) return stopTempPoll()
    const generation = tempGeneration
    tempPolling = true
    try {
    const st = await api.officialLoginStatus(tempSession.value.sessionId)
    if (generation !== tempGeneration) return
    tempError.value = ''
    if (!st) return // 网络抖动，下轮再看
    if (st.phase === 'waiting-login') {
      tempDoneSteps.value = 2
      // 桌面版是常驻单实例：新进程交接退出后，登录发生在已打开的客户端里，
      // 凭据写进默认 profile —— 提示用户去那个窗口操作，而不是干等
      tempHint.value = st.watchDefaultProfile
        ? `等待官方客户端登录（${st.elapsedSec || 0}s）。已登录的账号可选择「从本地导入」。`
        : `等待登录中…（${st.elapsedSec || 0}s）在打开的官方客户端里完成 OpenAI 登录。`
    } else if (st.phase === 'logged-in') {
      tempDoneSteps.value = 3
      tempHint.value = st.credSource === 'default-profile'
        ? '已检测到官方客户端的新登录凭据（默认 Codex 目录）。'
        : '已检测到登录信息，请关闭官方客户端窗口。'
    } else if (st.phase === 'ready') {
      stopTempPoll()
      await finishTempLogin()
    } else if (st.phase === 'importing') {
      tempDoneSteps.value = 4
      tempHint.value = '正在导入账号，请稍候…'
    } else if (['failed', 'cancelled', 'unknown'].includes(st.phase)) {
      stopTempPoll()
      tempPhase.value = 'failed'
      tempRetryable.value = false
      tempError.value = st.error || (st.phase === 'unknown' ? '登录会话不存在或已过期，请重新开始' : st.phase === 'cancelled' ? '本次登录已取消，请重新开始' : '登录流程失败')
    }
    } catch (e) {
      if (generation !== tempGeneration) return
      tempError.value = e?.message || '无法获取登录进度，请检查网关。'
      if ([400, 401, 403, 404, 410].includes(e?.status)) {
        stopTempPoll()
        tempPhase.value = 'failed'
        tempRetryable.value = false
      }
    } finally { tempPolling = false }
  }, 2000)
}
function stopTempPoll() {
  if (tempTimer) { clearInterval(tempTimer); tempTimer = null }
}
async function finishTempLogin() {
  const sessionId = tempSession.value?.sessionId
  if (!sessionId || tempImporting.value) return
  const generation = tempGeneration
  tempImporting.value = true
  tempRetryable.value = false
  tempDoneSteps.value = 4
  tempHint.value = '正在读取登录信息…'
  try {
    const r = await api.officialLoginFinish(sessionId)
    if (disposed || generation !== tempGeneration) return
    if (!r?.ok) {
      tempPhase.value = 'failed'
      tempRetryable.value = true
      tempError.value = r?.detail || '导入失败（登录信息已保留，可点击重试导入）'
      return
    }
    tempDoneSteps.value = 6
    tempPhase.value = 'completed'
    tempSession.value = null
    tempHint.value = r.cleaned
      ? '登录信息已导入，临时配置已清理。'
      : '登录信息已导入。临时配置可能仍由客户端使用，已保留；可自行关闭官方客户端。'
    okMsg.value = `官方登录导入成功${r.email ? '（' + r.email + '）' : ''}${r.isExisting ? '，已有账号凭据已更新' : ''}`
    emit('changed')
  } catch (e) {
    if (disposed || generation !== tempGeneration) return
    tempPhase.value = 'failed'
    tempError.value = e?.message || '导入失败'
    tempRetryable.value = ![400, 401, 403, 404, 410].includes(e?.status)
    if (e?.status === 400) {
      // Both an expired session and a failed persistence operation use HTTP 400.
      // Only a retained server session can safely offer retry with the same credentials.
      try {
        const st = await api.officialLoginStatus(sessionId)
        if (disposed || generation !== tempGeneration) return
        tempRetryable.value = ['ready', 'logged-in', 'importing'].includes(st?.phase)
      } catch {}
    }
  } finally {
    if (generation === tempGeneration) tempImporting.value = false
  }
}
async function retryTempImport() {
  if (!tempRetryable.value || tempImporting.value) return
  tempPhase.value = 'running'
  tempError.value = ''
  await finishTempLogin()
}
async function cancelTempLogin({ detaching = false } = {}) {
  const generation = ++tempGeneration
  stopTempPoll()
  const sessionId = tempSession.value?.sessionId
  if (sessionId) {
    try { await api.officialLoginCancel(sessionId) }
    catch (e) {
      if (!detaching && !disposed && generation === tempGeneration) {
        tempError.value = e?.message || '无法取消本次登录，请重试'
        if (tempRunning.value) pollTempLogin()
        return false
      }
    }
  }
  if (generation !== tempGeneration) return true
  tempSession.value = null
  tempPhase.value = 'idle'
  tempDoneSteps.value = 0
  tempHint.value = ''
  tempRetryable.value = false
  tempImporting.value = false
  return true
}
function closeTempLogin() {
  // 登录进行中关闭弹窗：先取消会话，避免留下无人接管的临时配置
  cancelTempLogin({ detaching: true })
  emit('close')
}

// ---------- 本地状态 ----------
async function loadState() {
  try {
    const s = await api.getAuthState()
    if (s) {
      mode.value = s.mode || 'bridge'
      hasApiKey.value = !!s.hasApiKey
    }
  } catch {}
}
async function loadProviders() {
  const r = await api.getProviders()
  if (r?.ok) savedProviders.value = r.saved || []
}

// 删除已保存供应商。此前模板里裸调 deleteProvider(...) —— 它既没导入也没定义，
// 点击「×」直接 ReferenceError；同时那行还把 ref 当普通数组赋值
// （savedProviders = ... 而不是 .value = ...），界面根本不会更新。
async function removeProvider(id) {
  const before = savedProviders.value
  savedProviders.value = before.filter((x) => x.id !== id) // 先乐观移除，交互不卡顿
  const r = await api.deleteProvider(id)
  if (!r?.ok) {
    savedProviders.value = before // 失败回滚，不要留下「删了又回来」的错觉
    setError('删除供应商失败，请重试')
  }
}

onMounted(() => {
  loadState()
  loadProviders()
  // Electron 内置窗口回调
  if (window.api?.onOAuthCallback) {
    window.api.onOAuthCallback((data) => {
      if (data?.code) {
        // 端口取自本次会话的 redirectUri（1455 被占用时会漂移到其它端口，不能硬编码）
        const base = browser.value?.redirectUri || 'http://localhost:1455/auth/callback'
        // code / state 必须编码：它们会出现在查询串里，未编码会让回调解析拿到半个值
        const q = new URLSearchParams()
        q.set('code', String(data.code))
        if (data.state) q.set('state', String(data.state))
        callbackUrl.value = `${base}?${q.toString()}`
        submitCallback()
      }
    })
  }
})
onUnmounted(() => {
  disposed = true
  ++actionGeneration
  cancelTempLogin({ detaching: true })
  stopPoll()
  stopTempPoll()
  cancelActiveOAuth().catch(() => {})
  if (window.api?.closeOAuthWindow) window.api.closeOAuthWindow()
})

function setError(e) {
  if (disposed) return
  let msg = ''
  if (e instanceof Error) msg = e.message
  else if (e && typeof e === 'object') msg = e.detail || e.error || e.message || JSON.stringify(e)
  else msg = String(e || '')
  error.value = msg || '操作失败'
  okMsg.value = ''
}
function setOk(m) {
  if (disposed) return
  okMsg.value = m
  error.value = ''
}
// 复制到剪贴板：此前静默失败（http 非安全上下文 / 权限被拒时用户毫无反馈）
async function copyText(t) {
  if (!t) return
  try {
    await writeClipboard(t)
    setOk('已复制到剪贴板')
  } catch (e) {
    setError('复制失败：' + (e?.message || '剪贴板不可用'))
  }
}
function currentPayload() {
  return {
    pendingId: pendingId.value || undefined,
    name: email.value.trim() || undefined
  }
}

// ---------- 待授权卡片 ----------
async function savePendingCard() {
  const generation = actionGeneration
  if (!email.value.trim() && !note.value.trim()) {
    return setError('请至少填写账号邮箱或备注')
  }
  loading.value = true
  error.value = ''
  try {
    const r = await api.addPendingAccount({
      name: email.value.trim(),
      email: email.value.trim(),
      note: note.value.trim()
    })
    if (!actionCurrent(generation)) return
    if (r?.ok) {
      pendingId.value = r.accountId
      setOk('待授权卡片已保存，授权完成后会自动归档到该账号')
    } else setError(r)
  } catch (e) {
    if (actionCurrent(generation)) setError(e)
  } finally {
    loading.value = false
  }
}

// ---------- OAuth ----------
// 注意函数名：api 层导出的是 *Api 后缀（startBrowserLoginApi / pollBrowserLoginApi /
// submitBrowserCallbackApi / startDeviceFlowApi）。此前这里调用的是不带后缀的名字，
// 运行时直接 TypeError: api.startBrowserLogin is not a function，
// 被 catch 吞成一句「操作失败」—— OAuth 与设备授权两条路一度完全不可用。
async function startAuth() {
  const generation = actionGeneration
  const source = authMode.value
  startingOAuthSource = source
  loading.value = true
  error.value = ''
  try {
    if (source === 'device') {
      const r = await api.startDeviceFlowApi()
      if (!actionCurrent(generation)) { cancelOAuthSource(source).catch(() => {}); return }
      if (r?.ok || r?.verification_uri || r?.user_code) { device.value = r; setOk(r.pendingImport ? '' : '设备授权已发起：打开链接并输入用户码') }
      else setError(r)
    } else {
      const r = await api.startBrowserLoginApi()
      if (!actionCurrent(generation)) {
        cancelOAuthSource(source).catch(() => {})
        return
      }
      if (r?.ok || r?.hostedUrl) {
        browser.value = r
        setOk(r.pendingImport ? '' : '浏览器授权已发起，请在打开的页面完成登录')
        // 自动检测回调。此前 pollTimer 从未被赋值，界面上「正在等待回调…
        // （每 2 秒检测一次）」是一句假提示 —— 实际没有任何轮询在跑。
        if (!r.pendingImport) startPolling()
      } else setError(r)
    }
  } catch (e) {
    if (actionCurrent(generation)) setError(e)
  } finally {
    if (startingOAuthSource === source) startingOAuthSource = ''
    loading.value = false
  }
}

// 每 2 秒问一次后端「授权完成了吗」，完成后自动收尾。
// 上一轮没回来就跳过这一轮，避免慢响应时请求叠加。
function startPolling() {
  stopPoll()
  const generation = actionGeneration
  const pollGeneration = authPollGeneration
  let inFlight = false
  polling.value = true
  pollTimer = setInterval(async () => {
    if (loading.value || !polling.value || inFlight) return
    inFlight = true
    try {
      const r = await api.pollBrowserLoginApi(currentPayload())
      if (!actionCurrent(generation) || pollGeneration !== authPollGeneration || !polling.value || active.value !== 'oauth') return
      if (r?.ok) {
        stopPoll()
        browser.value = null
        setOk('授权完成，账号已就绪')
        emit('changed')
      } else if (r?.pending) {
        // 继续等
      } else {
        stopPoll()
        setError(r)
      }
    } catch (e) {
      if (!actionCurrent(generation) || pollGeneration !== authPollGeneration || !polling.value || active.value !== 'oauth') return
      stopPoll()
      setError(e)
    } finally { inFlight = false }
  }, 2000)
}
function stopPoll() {
  ++authPollGeneration
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  polling.value = false
}
function cancelOAuthSource(source) {
  return source === 'device' ? api.cancelDeviceFlowApi() : api.cancelBrowserLoginApi()
}
function cancelActiveOAuth() {
  const source = startingOAuthSource || (device.value ? 'device' : browser.value ? 'browser' : '')
  return source ? cancelOAuthSource(source) : Promise.resolve()
}
async function openBrowserLogin() {
  if (browser.value?.hostedUrl) api.openBrowser(browser.value.hostedUrl)
}
async function submitCallback() {
  const generation = actionGeneration
  stopPoll()
  loading.value = true
  error.value = ''
  try {
    // 签名是 (callbackUrl, payload)，不是 ({ callbackUrl, pendingId })
    const r = await api.submitBrowserCallbackApi(callbackUrl.value, { pendingId: pendingId.value || undefined, name: email.value.trim() || undefined })
    if (!actionCurrent(generation)) return
    if (r?.ok) {
      stopPoll()
      browser.value = null
      setOk('授权完成，账号已就绪')
      emit('changed')
    } else setError(r)
  } catch (e) {
    if (actionCurrent(generation)) setError(e)
  } finally {
    loading.value = false
  }
}
async function continueAuth() {
  const generation = actionGeneration
  stopPoll()
  loading.value = true
  error.value = ''
  try {
    const r = authMode.value === 'device'
      ? await api.pollDeviceFlowApi(currentPayload())
      : await api.pollBrowserLoginApi(currentPayload())
    if (!actionCurrent(generation)) return
    // 后端成功时返回的是 { ok: true, accountId, path }，**没有** done 字段。
    // 此前判 `r?.ok && r.done` 恒为假，于是即使授权真的完成了也走不到成功分支 ——
    // 用户点「我已授权，继续」永远只会看到「还没检测到授权完成」。
    if (r?.ok) {
      stopPoll()
      browser.value = null
      device.value = null
      setOk('授权完成，账号已就绪')
      emit('changed')
    } else if (r?.pending) {
      setOk(pendingOAuthImport.value ? '授权正在保存，请稍后重试' : '还没检测到授权完成，完成授权后稍等片刻再点一次')
    } else setError(r)
  } catch (e) {
    if (actionCurrent(generation)) setError(e)
  } finally {
    loading.value = false
  }
}

// ---------- Token / JSON（多格式文本） ----------
async function onFile(e) {
  const f = e.target.files?.[0]
  if (!f) return
  importFile.value = f
  const generation = actionGeneration
  const reader = new FileReader()
  reader.onload = () => {
    if (!actionCurrent(generation)) return
    jsonText.value = String(reader.result || '')
    active.value = 'json'
  }
  reader.onerror = () => { if (actionCurrent(generation)) setError('无法读取所选文件，请重试') }
  reader.readAsText(f)
}
async function importSave() {
  const generation = actionGeneration
  if (!jsonText.value.trim()) return setError('请先粘贴凭据内容或选择文件')
  loading.value = true
  error.value = ''
  try {
    const r = await api.importTokenText(jsonText.value, email.value.trim() || undefined)
    if (!actionCurrent(generation)) return
    if (r?.ok) {
      setOk((r.warning ? r.warning + '；' : '') + '已导入并添加为账号（设为当前）')
      jsonText.value = ''
      emit('changed')
    } else setError(r)
  } catch (e) {
    if (actionCurrent(generation)) setError(e)
  } finally {
    loading.value = false
  }
}

// ---------- 本机登录导入 ----------
const localBusy = ref(false)
async function importExistingLocal() {
  loading.value = true
  if (!await cancelTempLogin()) { loading.value = false; return }
  if (disposed) return
  active.value = 'import'
  await nextTick()
  loading.value = false
  if (!disposed) await getLocalAccount()
}
async function getLocalAccount() {
  const generation = actionGeneration
  localBusy.value = true
  error.value = ''
  try {
    const info = await api.inspectCodexLocal()
    if (!actionCurrent(generation)) return
    if (!info || info.error === 'not_found') {
      return setError('未找到可导入的本地登录文件。若官方客户端已登录，可改用 OAuth 或 Token / JSON。')
    }
    if (info.error) {
      const text = { parse_error: '本机 auth.json 无法解析（文件损坏）', read_error: '本机 auth.json 无法读取（权限不足）', unsupported: '本机登录缺少续期凭据（refresh_token），请重新 codex login' }[info.error] || info.detail || info.error
      return setError(text)
    }
    const r = await api.importCodexLocal()
    if (!actionCurrent(generation)) return
    if (r?.ok) {
      setOk(`已导入本机登录${r.email ? '（' + r.email + '）' : ''}${r.isExisting ? '，凭据已更新' : '并设为当前账号'}`)
      emit('changed')
    } else setError(r?.detail || r?.error || '导入失败')
  } catch (e) {
    if (actionCurrent(generation)) setError(e)
  } finally {
    localBusy.value = false
  }
}

// ---------- API Key（供应商 + 直连） ----------
function selectPreset(id) {
  providerPresetId.value = id
  const p = PROVIDER_PRESETS.find((x) => x.id === id)
  if (p) providerBaseUrl.value = p.baseUrl
}
async function saveApiKey() {
  const generation = actionGeneration
  if (!apiKey.value.trim()) return setError('请输入 API Key')
  const baseUrl = providerBaseUrl.value.trim()
  if (providerPresetId.value === CUSTOM_PROVIDER_ID && !baseUrl) return setError('自定义供应商需要填写接口地址（BaseUrl）')
  loading.value = true
  error.value = ''
  try {
    const presetName = activePreset.value?.name
    const r = await api.setAuthMode('openai', apiKey.value.trim(), baseUrl || undefined)
    if (!actionCurrent(generation)) return
    if (r?.ok) {
      mode.value = 'openai'
      hasApiKey.value = true
      // 记住这个供应商供下次快选（失败不影响切换）
      if (baseUrl) {
        await api.saveProvider(presetName || baseUrl.replace(/^https?:\/\//, '').split('/')[0], baseUrl).catch(() => {})
        if (!actionCurrent(generation)) return
        loadProviders()
      }
      setOk(`已切换为 API Key 模式${baseUrl ? '（上游：' + baseUrl + '）' : '（直连 api.openai.com）'}`)
      emit('changed')
    } else setError(r)
  } catch (e) {
    if (actionCurrent(generation)) setError(e)
  } finally {
    loading.value = false
  }
}
async function switchToBridge() {
  const generation = actionGeneration
  loading.value = true
  error.value = ''
  try {
    const r = await api.setAuthMode('bridge', '')
    if (!actionCurrent(generation)) return
    if (r?.ok) {
      mode.value = 'bridge'
      setOk('已切换回 Bridge（Codex 登录）模式')
      emit('changed')
    } else setError(r)
  } catch (e) {
    if (actionCurrent(generation)) setError(e)
  } finally {
    loading.value = false
  }
}

// 切到 apikey 标签时刷新已保存供应商
let revertingTab = false
watch(active, async (v, previous) => {
  if (revertingTab) { revertingTab = false; return }
  ++actionGeneration
  if (previous === 'tempLogin' && tempSession.value) cancelTempLogin()
  error.value = ''; okMsg.value = ''; tempError.value = ''
  if (v !== 'oauth') {
    stopPoll()
    if (previous === 'oauth') {
      loading.value = true
      try { await cancelActiveOAuth() }
      catch (e) {
        if (!disposed) { revertingTab = true; active.value = previous; setError(e) }
        return
      } finally { loading.value = false }
    }
    browser.value = null
    device.value = null
  }
  if (v === 'apikey') loadProviders()
})
let revertingAuthMode = false
watch(authMode, async (_, previous) => {
  if (revertingAuthMode) { revertingAuthMode = false; return }
  ++actionGeneration
  stopPoll()
  loading.value = true
  try { await cancelActiveOAuth() }
  catch (e) {
    if (!disposed) { revertingAuthMode = true; authMode.value = previous; setError(e) }
    return
  } finally { loading.value = false }
  browser.value = null
  device.value = null
  callbackUrl.value = ''
  error.value = ''; okMsg.value = ''
})

// 图标（内联 SVG，零依赖）
const icons = {
  monitor: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>',
  globe: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  fileText: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
  key: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3-3.5 3.5Z"/></svg>',
  database: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/></svg>',
  terminal: '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>',
  external: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15,3 21,3 21,9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  copy: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
  check: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  info: '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  filePlus: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6"/><path d="M12 18V12"/></svg>',
  eye: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7c.78 0 1.53-.09 2.24-.26"/><path d="M2 2l20 20"/></svg>',
  alert: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  download: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  rotate: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>',
  fileUp: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M12 12v6"/><path d="m9 15 3-3 3 3"/></svg>'
}
const tabIcon = (k) => icons[{ tempLogin: 'monitor', oauth: 'globe', json: 'fileText', apikey: 'key', import: 'database' }[k]]
</script>

<template>
  <div class="modal-mask" @click.self="closeTempLogin">
    <div class="modal" role="dialog" aria-modal="true" aria-label="添加 Codex 账号" v-modal-focus="closeTempLogin">
      <div class="modal-head">
        <div class="modal-title">添加 Codex 账号</div>
        <button class="x" @click="closeTempLogin" aria-label="关闭">×</button>
      </div>

      <div class="tabs">
        <button
          v-for="t in tabs"
          :key="t.key"
          class="tab"
          :class="{ active: active === t.key }"
          :disabled="tempRunning || loading || localBusy"
          @click="active = t.key"
        >
          <span class="tab-icon" v-html="tabIcon(t.key)"></span>
          {{ t.label }}
        </button>
      </div>

      <div class="modal-body">
        <!-- 官方登录 -->
        <div v-if="active === 'tempLogin'" class="pane">
          <p class="hint">
            由官方客户端打开浏览器完成登录并处理授权回调。网关在临时客户端关闭后读取最终凭据并导入。
          </p>

          <div class="steps">
            <div
              v-for="(s, i) in TEMP_STEPS"
              :key="s.key"
              class="step"
              :class="tempStepState(i)"
            >
              <span class="step-num">{{ tempStepState(i) === 'done' ? '✓' : i + 1 }}</span>
              <span class="step-label">{{ s.label }}</span>
            </div>
          </div>

          <p v-if="tempHint" class="hint live">{{ tempHint }}</p>
          <p v-if="tempError" class="hint err-hint">
            <span v-html="icons.alert"></span>
            {{ tempError }}
          </p>

          <button v-if="!tempRunning && tempPhase !== 'completed'" class="btn-primary" :disabled="loading" @click="startTempLogin">
            <span v-html="icons.monitor"></span>
            打开官方客户端并登录
          </button>
          <button v-if="tempRunning" class="btn-outline wide" :disabled="tempImporting" @click="cancelTempLogin">
            取消本次官方登录
          </button>
          <button v-if="tempRetryable" class="btn-primary" @click="retryTempImport">
            <span v-html="icons.rotate"></span>
            重试导入登录信息
          </button>
          <button v-if="tempPhase !== 'completed'" class="btn-outline wide" :disabled="loading || localBusy || tempImporting" @click="importExistingLocal">
            从本地导入
          </button>

          <details class="examples"><summary>未弹出客户端或已登录？</summary><p class="hint dim">
            可自行打开官方客户端完成新登录；已有本机登录可点「从本地导入」。
            取消只停止本次导入，不会关闭已打开的官方客户端。无法确认客户端已退出时会保留临时配置；导入失败时保留凭据供重试。
          </p></details>
        </div>

        <!-- OAuth -->
        <div v-else-if="active === 'oauth'" class="pane">
          <div class="sec-label">待授权账号</div>
          <input v-model="email" class="inp" placeholder="输入 OpenAI 账号邮箱" />

          <div class="row-actions">
            <button class="btn-ghost sm" @click="showNote = !showNote">
              <span v-html="icons.fileText"></span>
              {{ showNote ? '收起备注' : '加备注' }}
            </button>
            <button class="btn-ghost sm" :disabled="loading" @click="savePendingCard">
              <span v-html="icons.filePlus"></span>
              {{ pendingId ? '已保存卡片' : '保存待授权卡片' }}
            </button>
          </div>

          <input v-if="showNote" v-model="note" class="inp" placeholder="备注（选填，便于区分多个账号）" />

          <p class="hint">{{ pendingOAuthImport ? '授权已完成，继续保存即可添加账号。' : '点击下方按钮，在浏览器中完成 OpenAI 账号 OAuth 授权。' }}</p>
          <p v-if="pendingOAuthImport" class="hint live" role="status">上次授权待保存</p>

          <div class="seg">
            <button class="seg-item" :disabled="loading" :class="{ on: authMode === 'browser' }" @click="authMode = 'browser'">
              <span v-html="icons.globe"></span>
              浏览器授权
            </button>
            <button class="seg-item" :disabled="loading" :class="{ on: authMode === 'device' }" @click="authMode = 'device'">
              <span v-html="icons.terminal"></span>
              设备授权
            </button>
          </div>

          <button v-if="!device && !browser" class="btn-primary" :disabled="loading" @click="startAuth">
            <span v-html="icons.globe"></span>
            发起授权
          </button>

          <!-- 浏览器授权 -->
          <div v-if="browser && !browser.pendingImport" class="auth-box">
            <div class="sec-label">授权链接</div>
            <div class="link-row">
              <input type="text" readonly :value="browser.hostedUrl" class="url-input" />
              <button class="btn-ghost sm" @click="copyText(browser.hostedUrl)">
                <span v-html="icons.copy"></span>
                复制
              </button>
            </div>

            <button class="btn-primary" @click="openBrowserLogin">
              <span v-html="icons.external"></span>
              在浏览器中打开
            </button>

            <p class="hint">
              <span v-html="icons.info"></span>
              授权完成后会跳回 <code>{{ browser.redirectUri }}</code>，本窗自动检测并完成。
            </p>
            <p v-if="browser.warning" class="hint warn">
              <span v-html="icons.info"></span>
              {{ browser.warning }}
            </p>
            <p v-if="polling" class="hint">正在等待回调…（每 2 秒检测一次）</p>

            <div class="sec-label">手动输入回调地址</div>
            <div class="link-row">
              <input
                v-model="callbackUrl"
                class="inp"
                :placeholder="`粘贴完整回调地址，例如：${browser.redirectUri}?code=...&state=...`"
              />
              <button class="btn-outline" :disabled="loading || !callbackUrl.trim()" @click="submitCallback">
                <span v-html="icons.check"></span>
                我已授权，继续
              </button>
            </div>
          </div>

          <!-- 设备授权 -->
          <div v-if="device && !device.pendingImport" class="auth-box">
            <div class="sec-label">授权链接</div>
            <div class="link-row">
              <input type="text" readonly :value="device.verification_uri_complete || device.verification_uri" class="url-input" />
              <button class="btn-ghost sm" @click="copyText(device.verification_uri_complete || device.verification_uri)">
                <span v-html="icons.copy"></span>
                复制
              </button>
            </div>
            <button class="btn-primary" @click="api.openBrowser(device.verification_uri_complete || device.verification_uri)">
              <span v-html="icons.external"></span>
              在浏览器中打开
            </button>

            <div class="sec-label">用户码</div>
            <div class="link-row">
              <code class="code">{{ device.user_code }}</code>
              <button class="btn-ghost sm" @click="copyText(device.user_code)">
                <span v-html="icons.copy"></span>
                复制
              </button>
            </div>
            <p class="hint">在浏览器打开上方链接并输入此用户码完成授权。</p>
          </div>

          <button v-if="device || browser" :class="pendingOAuthImport ? 'btn-primary wide' : 'btn-outline wide'" :disabled="loading || polling" @click="continueAuth">
            <span v-html="icons.check"></span>
            {{ pendingOAuthImport ? '继续保存' : '我已授权，继续' }}
          </button>

          <p class="hint dim">
            <span v-html="icons.info"></span>
            授权流量走「设置 → 出网代理」里配置的代理；需要弹窗登录时可在设置里临时清空代理。
          </p>

          <p class="hint dim" v-if="mode !== 'bridge'">当前为 API Key 模式；保存账号不会自动切换连接模式。</p>
        </div>

        <!-- Token / JSON -->
        <div v-else-if="active === 'json'" class="pane">
          <p class="hint">粘贴 <code>auth.json</code>、账号 JSON、Sub2API JSON、<code>accessToken</code>、个人访问令牌 <code>at-…</code> 或 <code>refresh_token</code>。</p>

          <details class="examples" :open="showExamples" @toggle="showExamples = $event.target.open">
            <summary>必填字段与示例（点击展开）</summary>
            <div class="examples-body">
              <p class="hint">
                支持 session JSON、完整 tokens（id_token + access_token + refresh_token）、
                Sub2API 导出 JSON、仅 <code>accessToken</code>、个人访问令牌 <code>at-…</code>（按
                personal_access_token 落盘），或仅 <code>refresh_token</code>——仅 refresh_token
                会先联网换取完整凭据。
              </p>
              <pre class="code-block">示例（session / accessToken / at- / refresh_token）：

{"tokens":{"id_token":"eyJ…","access_token":"eyJ…","refresh_token":"rt…","account_id":"acct-…"}}

{"accessToken":"eyJ…","refreshToken":"rt…"}

at-xxxxxxxxxxxxxxxx

{"refresh_token":"rt…"}</pre>
            </div>
          </details>

          <textarea v-model="jsonText" class="ta" placeholder="示例：auth.json 内容、session JSON、accessToken、at-… 个人访问令牌、Sub2API JSON，或仅 refresh_token"></textarea>
          <button class="btn-primary" :disabled="loading || !jsonText.trim()" @click="importSave">
            <span v-html="icons.download"></span>
            导入
          </button>
        </div>

        <!-- API Key -->
        <div v-else-if="active === 'apikey'" class="pane">
          <div class="sec-label">已保存供应商</div>
          <p class="hint" v-if="!savedProviders.length">暂无已保存供应商，可直接填写后自动保存。</p>
          <div v-else class="chips">
            <button
              v-for="p in savedProviders"
              :key="p.id"
              class="chip"
              :class="{ active: providerBaseUrl === p.baseUrl }"
              @click="providerPresetId = CUSTOM_PROVIDER_ID; providerBaseUrl = p.baseUrl"
            >
              {{ p.name }}
              <span class="chip-x" @click.stop="removeProvider(p.id)">×</span>
            </button>
          </div>

          <div class="sec-label">供应商</div>
          <div class="chips">
            <button class="chip" :class="{ active: providerPresetId === CUSTOM_PROVIDER_ID }" @click="selectPreset(CUSTOM_PROVIDER_ID)">
              自定义
            </button>
            <button
              v-for="p in PROVIDER_PRESETS"
              :key="p.id"
              class="chip"
              :class="{ active: providerPresetId === p.id }"
              @click="selectPreset(p.id)"
            >
              {{ p.name }}
            </button>
          </div>

          <div v-if="providerPresetId === CUSTOM_PROVIDER_ID" class="field">
            <div class="sec-label">接口地址（BaseUrl）</div>
            <input v-model="providerBaseUrl" class="inp" placeholder="https://your-relay.example.com/v1" />
          </div>
          <div v-else class="field">
            <div class="sec-label">接口地址（由供应商预设带入，可改）</div>
            <input v-model="providerBaseUrl" class="inp" placeholder="https://…" />
          </div>

          <div class="field">
            <div class="sec-label">API Key</div>
            <div class="link-row">
              <input :type="showApiKey ? 'text' : 'password'" v-model="apiKey" class="inp" placeholder="sk-… / at-…" />
              <button class="btn-ghost sm" @click="showApiKey = !showApiKey">
                <span v-html="showApiKey ? icons.eyeOff : icons.eye"></span>
              </button>
            </div>
          </div>

          <button class="btn-primary" :disabled="loading || !apiKey.trim()" @click="saveApiKey">
            <span v-html="icons.key"></span>
            添加账号
          </button>
          <p class="hint dim">此模式不走 Codex 登录态，按所选供应商计费；出网代理同样生效。</p>
          <button class="btn-ghost" :disabled="loading || mode === 'bridge'" @click="switchToBridge">
            切回 Bridge（Codex 登录）模式
          </button>
        </div>

        <!-- 导入 -->
        <div v-else-if="active === 'import'" class="pane">
          <p class="hint">从本机已登录的会话中导入 Codex 账号。</p>

          <button class="btn-primary" :disabled="localBusy" @click="getLocalAccount">
            <span v-html="icons.database"></span>
            {{ localBusy ? '正在读取本机登录…' : '获取本地账号' }}
          </button>

          <p class="hint dim">选择 JSON 文件导入账号（支持多种格式，与 Token / JSON 等效）。</p>
          <button class="btn-outline wide" @click="$refs.fileInput.click()">
            <span v-html="icons.fileUp"></span>
            从本地文件导入
          </button>
          <input ref="fileInput" type="file" accept=".json,application/json,.txt" style="display: none" @change="onFile" />
          <div v-if="importFile" class="file-name">已选择：{{ importFile.name }}（已带入 Token / JSON，点「导入」完成）</div>
        </div>

        <div v-if="error" class="msg err">{{ error }}</div>
        <div v-if="okMsg" class="msg ok">{{ okMsg }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-mask {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center; z-index: 50;
}
.modal {
  width: 620px; max-width: 94vw; max-height: 88vh; overflow-y: auto;
  background: var(--card); border: 1px solid var(--border-strong);
  border-radius: 16px; padding: 24px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}
.modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
.modal-title { font-size: 20px; font-weight: 600; color: var(--text); }
.x { background: none; border: none; color: var(--text-2); font-size: 20px; cursor: pointer; line-height: 1; }

.tabs { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
.tab {
  background: none; border: none; color: var(--text-2); padding: 12px; height: 40px;
  cursor: pointer; font-size: 13px; font-weight: 500; border-radius: 8px;
  display: inline-flex; align-items: center; gap: 6px;
}
.tab:hover { color: var(--text); }
.tab.active { background: var(--card-2); color: var(--text); }
.tab:disabled { opacity: 0.5; cursor: not-allowed; }
.tab-icon { display: flex; align-items: center; }

.pane { display: flex; flex-direction: column; gap: 16px; }
.sec-label { font-size: 13px; font-weight: 500; color: var(--text-2); }
/* 说明文字必须用块级流式排版。
   此前用 display:flex：纯文本段与 <code> 各自成为独立 flex 项且不可换行拆分，
   一行放不下时每个文字段被压到 min-content 宽（中文 = 1 个字宽），
   整段说明就变成「一列一个字」的竖排——Token/JSON 等长文案标签页首当其冲。 */
.hint { font-size: 13px; color: var(--text-2); line-height: 1.6; margin: 0; }
.hint code, .warn code { font-family: var(--mono, monospace); color: var(--primary); }
.hint > span:first-child { display: inline-flex; vertical-align: -3px; margin-right: 6px; }
.hint.dim { color: #6b7280; font-size: 12.5px; }
.hint.live { color: var(--primary); }
.hint.err-hint { color: var(--rose); }
.hint.warn { color: var(--amber); }

/* 官方登录 6 步骤条 */
.steps { display: flex; flex-direction: column; gap: 8px; }
.step {
  display: flex; align-items: center; gap: 10px; padding: 10px 14px;
  border: 1px solid var(--border-strong); border-radius: 10px; font-size: 13px; color: #6b7280;
}
.step-num {
  width: 20px; height: 20px; border-radius: 50%; flex: none;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-family: var(--mono, monospace);
  border: 1px solid #3a3f48; color: #6b7280;
}
.step.active { color: var(--text); border-color: var(--primary); }
.step.active .step-num { border-color: var(--primary); color: var(--primary); }
.step.done { color: var(--text-2); }
.step.done .step-num { background: rgba(139,107,214,0.15); border-color: var(--primary); color: var(--primary); }

/* 供应商 chip 墙 */
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip {
  background: var(--card-2); border: 1px solid var(--border-strong); color: var(--text-2);
  padding: 6px 12px; border-radius: 999px; font-size: 12.5px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
}
.chip:hover { border-color: #3a3f48; }
.chip.active { border-color: var(--primary); color: var(--primary); background: rgba(139,107,214,0.08); }
.chip-x { color: #6b7280; font-size: 14px; line-height: 1; }
.chip-x:hover { color: var(--rose); }

/* Token/JSON 示例折叠 */
.examples { border: 1px solid var(--border-strong); border-radius: 10px; padding: 10px 14px; }
.examples summary { cursor: pointer; font-size: 13px; color: var(--text-2); user-select: none; }
.examples-body { margin-top: 10px; display: flex; flex-direction: column; gap: 10px; }
.code-block {
  margin: 0; padding: 12px; background: var(--bg); border: 1px solid var(--border-strong);
  border-radius: 8px; font-family: var(--mono, monospace); font-size: 12px;
  color: var(--primary); white-space: pre-wrap; word-break: break-all; line-height: 1.55;
}

.field { display: flex; flex-direction: column; gap: 6px; }
.row-actions { display: flex; gap: 10px; flex-wrap: wrap; }
.inp {
  width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 13px;
  color: var(--text); background: var(--bg); border: 1px solid var(--border-strong); border-radius: 10px;
}
.inp:focus { outline: none; border-color: var(--primary); }
.ta {
  min-height: 120px; resize: vertical; padding: 12px; font-size: 12.5px;
  font-family: var(--mono, monospace); color: var(--text); background: var(--bg);
  border: 1px solid var(--border-strong); border-radius: 10px; line-height: 1.5;
}
.ta:focus { outline: none; border-color: var(--primary); }
.seg { display: flex; background: var(--bg); border: 1px solid var(--border-strong); border-radius: 10px; overflow: hidden; }
.seg-item {
  flex: 1; background: none; border: none; color: var(--text-2); padding: 11px;
  font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
}
.seg-item.on { color: var(--primary); background: rgba(139,107,214,0.08); }
.auth-box { display: flex; flex-direction: column; gap: 12px; padding: 14px; border: 1px solid var(--border-strong); border-radius: 12px; }
.link-row { display: flex; gap: 8px; align-items: center; }
.url-input {
  flex: 1; min-width: 0; padding: 9px 12px; font-size: 12px; font-family: var(--mono, monospace);
  color: var(--text-2); background: var(--bg); border: 1px solid var(--border-strong); border-radius: 10px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.code {
  flex: 1; padding: 9px 12px; font-family: var(--mono, monospace); font-size: 14px;
  letter-spacing: 2px; color: var(--primary); background: var(--bg); border: 1px solid var(--border-strong); border-radius: 10px;
}
.file-name { font-size: 12.5px; color: var(--text-2); }
.btn-primary {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  background: var(--primary); border: none; color: var(--on-primary); font-weight: 600; font-size: 14px;
  padding: 12px 16px; border-radius: 12px; cursor: pointer;
}
.btn-primary:hover { background: var(--primary); }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-outline {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  background: none; border: 1px solid var(--border-strong); color: var(--text); font-size: 13.5px;
  padding: 11px 16px; border-radius: 12px; cursor: pointer;
}
.btn-outline:hover { border-color: #3a3f48; }
.btn-outline:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-ghost {
  background: none; border: none; color: var(--text-2); font-size: 13px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px; padding: 8px 10px; border-radius: 8px;
}
.btn-ghost:hover { color: var(--text); background: var(--card-2); }
.btn-ghost.sm { padding: 6px 10px; font-size: 12px; }
.wide { width: 100%; }
.msg { padding: 10px 14px; border-radius: 10px; font-size: 13px; line-height: 1.5; }
.msg.err { background: rgba(244,63,94,0.1); border: 1px solid rgba(244,63,94,0.3); color: var(--rose); }
.msg.ok { background: rgba(139,107,214,0.1); border: 1px solid rgba(139,107,214,0.3); color: var(--primary); }
.warn { font-size: 12.5px; color: var(--amber); margin: 0; line-height: 1.5; }
</style>
