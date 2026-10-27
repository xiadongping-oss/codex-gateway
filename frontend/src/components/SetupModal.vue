<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import * as api from '../api/gateway'
import { copyText as writeClipboard } from '../api/client'

const emit = defineEmits(['close', 'changed'])
const tabs = [
  { key: 'oauth', label: 'OAuth 授权' },
  { key: 'json', label: 'Token / JSON' },
  { key: 'apikey', label: 'API Key' },
  { key: 'import', label: '导入' }
]
const active = ref('oauth')
const loading = ref(false)
const error = ref('')
const okMsg = ref('')

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
const callbackUrl = ref('')
const polling = ref(false)
let pollTimer = null

// Token·JSON
const jsonText = ref('')

// 导入
const importFile = ref(null)

// API Key
const apiKey = ref('')
const showApiKey = ref(false)

async function loadState() {
  try {
    const s = await api.getAuthState()
    if (s) {
      mode.value = s.mode || 'bridge'
      hasApiKey.value = !!s.hasApiKey
    }
  } catch {}
}

onMounted(() => {
  loadState()
  // Electron 内置窗口回调
  if (window.api?.onOAuthCallback) {
    window.api.onOAuthCallback((data) => {
      if (data?.code) {
        // 端口取自本次会话的 redirectUri（1455 被占用时会漂移到其它端口，不能硬编码）
        const base = browser.value?.redirectUri || 'http://localhost:1455/auth/callback'
        callbackUrl.value = `${base}?code=${data.code}&state=${data.state || ''}`
        submitCallback()
      }
    })
  }
})
onUnmounted(() => {
  stopPoll()
  api.cancelBrowserLoginApi().catch(() => {})
  if (window.api?.closeOAuthWindow) window.api.closeOAuthWindow()
})

function setError(e) {
  let msg = ''
  if (e instanceof Error) msg = e.message
  else if (e && typeof e === 'object') msg = e.detail || e.error || e.message || JSON.stringify(e)
  else msg = String(e || '')
  error.value = msg || '操作失败'
  okMsg.value = ''
}
function setOk(m) {
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
    if (r?.ok) {
      pendingId.value = r.accountId
      setOk('待授权卡片已保存，授权完成后会自动归档到该账号')
    } else setError(r)
  } catch (e) {
    setError(e)
  } finally {
    loading.value = false
  }
}

// ---------- 发起授权 ----------
async function startAuth() {
  loading.value = true
  error.value = ''
  try {
    if (authMode.value === 'browser') {
      const info = await api.startBrowserLoginApi()
      browser.value = info
      device.value = null
      // Electron 下用内置无痕窗口，Web 下回退外部浏览器
          // 不再自动打开浏览器/内置窗口：用户手动复制或点击下方「在浏览器中打开」用默认浏览器访问
          setOk(`授权链接已生成，请复制到浏览器打开，或点击下方「在浏览器中打开」`)
          startBrowserPoll()
    } else {
      const info = await api.startDeviceFlowApi()
      device.value = info
      browser.value = null
      setOk('请访问下方链接并输入用户码，完成后点击「我已授权，继续」')
    }
  } catch (e) {
    setError(e)
  } finally {
    loading.value = false
  }
}

function openBrowserLogin() {
  if (!browser.value) return
  // 使用系统默认浏览器打开，不再新建 Electron 内置窗口
  api.openBrowser(browser.value.hostedUrl)
}

function startBrowserPoll() {
  if (polling.value) return
  polling.value = true
  let failCount = 0
  const loop = async () => {
    try {
      const r = await api.pollBrowserLoginApi(currentPayload())
      if (!r) {
        failCount++
        if (failCount >= 5) {
          polling.value = false
          stopPoll()
          setError('轮询授权状态失败，网关无响应或浏览器登录已过期。请重新发起授权。')
        }
        return
      }
      failCount = 0
      if (r.pending) return
      polling.value = false
      stopPoll()
      browser.value = null
      setOk('浏览器授权成功，已建档并设为当前账号')
      emit('changed')
    } catch (e) {
      polling.value = false
      stopPoll()
      setError(e)
    }
  }
  loop()
  pollTimer = setInterval(loop, 2000)
}

function stopPoll() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  polling.value = false
}

// ---------- 手动兜底 ----------
async function submitCallback() {
  if (!callbackUrl.value.trim()) return setError('请粘贴完整的回调地址')
  loading.value = true
  error.value = ''
  try {
    const r = await api.submitBrowserCallbackApi(callbackUrl.value.trim(), currentPayload())
    if (r?.ok) {
      stopPoll()
      browser.value = null
      callbackUrl.value = ''
      setOk('已通过回调地址完成授权，已建档并设为当前账号')
      emit('changed')
    } else setError(r)
  } catch (e) {
    setError(e)
  } finally {
    loading.value = false
  }
}

async function continueAuth() {
  loading.value = true
  error.value = ''
  try {
    const isBrowser = authMode.value === 'browser'
    const r = isBrowser
      ? await api.pollBrowserLoginApi(currentPayload())
      : await api.pollDeviceFlowApi(currentPayload())
    if (!r) {
      return setError('查询授权状态失败：网关无响应或登录会话已过期。建议刷新页面后重新发起授权。')
    }
    if (r.pending) {
      return setError('尚未检测到授权完成。请确认已在浏览器完成授权后重试。')
    }
    if (r.error) {
      return setError(r.detail || r.error || '授权处理失败')
    }
    device.value = null
    browser.value = null
    setOk('OAuth 授权成功，已建档并设为当前账号')
    emit('changed')
  } catch (e) {
    setError(e)
  } finally {
    loading.value = false
  }
}

// ---------- Token·JSON ----------
async function saveJson() {
  loading.value = true
  error.value = ''
  try {
    const parsed = JSON.parse(jsonText.value)
    const r = await api.addAccount({ provider: 'token', json: parsed })
    if (r?.ok) {
      setOk('已添加账号（Token/JSON）并设为当前')
      emit('changed')
    } else setError(r)
  } catch (e) {
    setError('JSON 解析失败或保存出错：' + (e?.message || e))
  } finally {
    loading.value = false
  }
}

// ---------- 导入 ----------
function onFile(e) {
  const f = e.target.files?.[0]
  if (!f) return
  importFile.value = f
  const reader = new FileReader()
  reader.onload = () => {
    jsonText.value = String(reader.result || '')
  }
  reader.readAsText(f)
}
async function importSave() {
  if (!jsonText.value) return setError('请先选择 auth.json 文件')
  loading.value = true
  error.value = ''
  try {
    const parsed = JSON.parse(jsonText.value)
    const r = await api.addAccount({ provider: 'import', json: parsed })
    if (r?.ok) {
      setOk('已导入并添加为账号（设为当前）')
      emit('changed')
    } else setError(r)
  } catch (e) {
    setError('JSON 解析失败或导入出错：' + (e?.message || e))
  } finally {
    loading.value = false
  }
}

// ---------- API Key ----------
async function saveApiKey() {
  if (!apiKey.value) return setError('请输入 API Key')
  loading.value = true
  error.value = ''
  try {
    const r = await api.setAuthMode('openai', apiKey.value)
    if (r?.ok) {
      mode.value = 'openai'
      hasApiKey.value = true
      setOk('已切换为 API Key 模式（直连 api.openai.com）')
      emit('changed')
    } else setError(r)
  } catch (e) {
    setError(e)
  } finally {
    loading.value = false
  }
}
async function switchToBridge() {
  loading.value = true
  error.value = ''
  try {
    const r = await api.setAuthMode('bridge', '')
    if (r?.ok) {
      mode.value = 'bridge'
      setOk('已切换回 Bridge（Codex 登录）模式')
      emit('changed')
    } else setError(r)
  } catch (e) {
    setError(e)
  } finally {
    loading.value = false
  }
}

// 图标（内联 SVG，零依赖）
const icons = {
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
  rotate: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>'
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title">添加 Codex 账号</div>
        <button class="x" @click="emit('close')" aria-label="关闭">×</button>
      </div>

      <div class="tabs">
        <button
          v-for="t in tabs"
          :key="t.key"
          class="tab"
          :class="{ active: active === t.key }"
          @click="active = t.key"
        >
          <span class="tab-icon" v-html="icons[t.key === 'oauth' ? 'globe' : t.key === 'json' ? 'fileText' : t.key === 'apikey' ? 'key' : 'database']"></span>
          {{ t.label }}
        </button>
      </div>

      <div class="modal-body">
        <!-- OAuth -->
        <div v-if="active === 'oauth'" class="pane">
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

          <p class="hint">点击下方按钮，在浏览器中完成 OpenAI 账号 OAuth 授权。</p>

          <div class="seg">
            <button class="seg-item" :class="{ on: authMode === 'browser' }" @click="authMode = 'browser'">
              <span v-html="icons.globe"></span>
              浏览器授权
            </button>
            <button class="seg-item" :class="{ on: authMode === 'device' }" @click="authMode = 'device'">
              <span v-html="icons.terminal"></span>
              设备授权
            </button>
          </div>

          <button v-if="!device && !browser" class="btn-primary" :disabled="loading" @click="startAuth">
            <span v-html="icons.globe"></span>
            发起授权
          </button>

          <!-- 浏览器授权 -->
          <div v-if="browser" class="auth-box">
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
          <div v-if="device" class="auth-box">
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

          <button v-if="device || browser" class="btn-outline wide" :disabled="loading || polling" @click="continueAuth">
            <span v-html="icons.check"></span>
            我已授权，继续
          </button>

          <p class="warn" v-if="mode !== 'bridge'">当前为 API Key 模式，OAuth 写入后仍会保持 Bridge 模式并重启代理。</p>
        </div>

        <!-- Token / JSON -->
        <div v-else-if="active === 'json'" class="pane">
          <p class="hint">粘贴 <code>auth.json</code> 内容（来自 <code>~/.codex/auth.json</code> 或导出）。支持 <code>tokens</code> 包裹或平铺的 <code>access_token/refresh_token</code>。</p>
          <textarea v-model="jsonText" class="ta" placeholder='{"tokens":{"access_token":"...","refresh_token":"..."}}'></textarea>
          <button class="btn-primary" :disabled="loading || !jsonText" @click="saveJson">
            <span v-html="icons.download"></span>
            保存登录态
          </button>
        </div>

        <!-- API Key -->
        <div v-else-if="active === 'apikey'" class="pane">
          <p class="hint">使用 OpenAI 官方 API Key 直连 <code>api.openai.com</code>。此模式不走 Codex 登录态，按 API 计费。</p>
          <div class="link-row">
            <input :type="showApiKey ? 'text' : 'password'" v-model="apiKey" class="inp" placeholder="sk-..." />
            <button class="btn-ghost sm" @click="showApiKey = !showApiKey">
              <span v-html="showApiKey ? icons.eyeOff : icons.eye"></span>
            </button>
          </div>
          <button class="btn-primary" :disabled="loading || !apiKey" @click="saveApiKey">
            <span v-html="icons.key"></span>
            保存并切换为 API Key 模式
          </button>
          <button class="btn-ghost" :disabled="loading || mode === 'bridge'" @click="switchToBridge">
            切回 Bridge（Codex 登录）模式
          </button>
          <p class="warn" v-if="mode === 'bridge'">当前为 Bridge 模式；填入 Key 并保存将停止 bridge、改用 API Key 代理。</p>
        </div>

        <!-- 导入 -->
        <div v-else-if="active === 'import'" class="pane">
          <p class="hint">从本机选择 <code>auth.json</code> 文件，内容与 Token / JSON 等效。</p>
          <input type="file" accept=".json,application/json" @change="onFile" />
          <div v-if="importFile" class="file-name">已选择：{{ importFile.name }}</div>
          <button class="btn-primary" :disabled="loading || !importFile" @click="importSave">
            <span v-html="icons.download"></span>
            导入并保存
          </button>
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
  width: 560px; max-width: 92vw; background: #14161a; border: 1px solid #2a2e36;
  border-radius: 16px; padding: 24px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}
.modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
.modal-title { font-size: 20px; font-weight: 600; color: #f0f1f5; }
.x { background: none; border: none; color: #9ca3af; font-size: 20px; cursor: pointer; line-height: 1; }

.tabs { display: flex; gap: 8px; margin-bottom: 20px; }
.tab {
  background: none; border: none; color: #9ca3af; padding: 12px; height: 40px;
  cursor: pointer; font-size: 13px; font-weight: 500; border-radius: 8px;
  display: inline-flex; align-items: center; gap: 6px;
}
.tab:hover { color: #f0f1f5; }
.tab.active { background: #1a1d23; color: #f0f1f5; }
.tab-icon { display: flex; align-items: center; }

.pane { display: flex; flex-direction: column; gap: 16px; }
.sec-label { font-size: 13px; font-weight: 500; color: #9ca3af; }
/* 说明文字必须用块级流式排版。
   此前用 display:flex：纯文本段与 <code> 各自成为独立 flex 项且不可换行拆分，
   一行放不下时每个文字段被压到 min-content 宽（中文 = 1 个字宽），
   整段说明就变成「一列一个字」的竖排——Token/JSON 等长文案标签页首当其冲。 */
.hint { font-size: 13px; color: #9ca3af; line-height: 1.6; margin: 0; }
.hint code, .warn code { font-family: var(--mono, monospace); color: #34d399; }
.hint > span:first-child { display: inline-flex; vertical-align: -3px; margin-right: 6px; }

.inp, .ta {
  width: 100%; background: #1a1d23; border: 1px solid #272a30; border-radius: 8px;
  padding: 12px; color: #e7e9ec; font-size: 14px; font-family: inherit;
}
.inp::placeholder { color: #6b7280; }
.ta {
  min-height: 120px; font-size: 12.5px; font-family: var(--mono, monospace); resize: vertical;
}
.ta::placeholder { color: #6b7280; }

.row-actions { display: flex; gap: 8px; }
.btn-ghost.sm {
  padding: 8px; font-size: 13px; font-weight: 500;
  display: inline-flex; align-items: center; gap: 6px;
}
.btn-ghost.sm span { display: flex; align-items: center; }

.seg { display: flex; gap: 4px; background: #1a1d23; border-radius: 8px; padding: 4px; }
.seg-item {
  flex: 1; height: 36px; background: none; border: none; border-radius: 6px;
  color: #9ca3af; font-size: 13px; font-weight: 500; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
}
.seg-item.on { background: #272a30; color: #f0f1f5; }

.auth-box {
  background: #1a1d23; border: 1px solid #272a30; border-radius: 8px;
  padding: 16px; display: flex; flex-direction: column; gap: 12px;
}
.link-row { display: flex; align-items: center; gap: 8px; overflow: hidden; }
.link-row .inp { flex: 1; }
.url-input {
  flex: 1; min-width: 0; background: #14161a; border: 1px solid #272a30; border-radius: 8px;
  padding: 10px 12px; color: #e7e9ec; font-size: 12px; font-family: var(--mono, monospace);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; outline: none;
}
.url-input:hover, .url-input:focus { overflow-x: auto; }
.url-input:focus { border-color: #10b981; }
.code { background: #272a30; padding: 4px 8px; border-radius: 6px; color: #34d399; }

.btn-primary {
  background: #10b981; color: #0a0b0e; border: none; border-radius: 8px;
  height: 44px; padding: 0 14px; font-size: 14px; font-weight: 600; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
}
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-ghost {
  background: #1a1d23; color: #9ca3af; border: 1px solid #272a30; border-radius: 8px;
  height: 44px; padding: 0 14px; font-size: 13px; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
}
.btn-outline {
  background: #1a1d23; color: #34d399; border: 1px solid #10b981; border-radius: 8px;
  height: 44px; padding: 0 14px; font-size: 13px; font-weight: 500; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  flex-shrink: 0;
}
.btn-outline.wide { width: 100%; }
.btn-outline:disabled { opacity: 0.5; cursor: not-allowed; }

.file-name { font-size: 12px; color: #9ca3af; }
.warn { font-size: 12px; color: #f59e0b; margin: 0; }
.msg { font-size: 12.5px; padding: 8px 10px; border-radius: 8px; }
.msg.err { background: rgba(239, 68, 68, 0.12); color: #ef4444; }
.msg.ok { background: rgba(16, 185, 129, 0.12); color: #34d399; }
</style>
