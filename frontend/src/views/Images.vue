<script setup>
import { ref, computed, reactive, onMounted, onBeforeUnmount } from 'vue'
import * as api from '../api/gateway'
import { copyText } from '../api/client'

// ---------- 来源 ----------
const sources = ref([])
const active = ref('generated')
const assets = ref([])
const loaded = ref(false)
const manageMode = ref(false)

const TYPE_META = {
  generated: { label: '生成图库', tag: '内置', cloud: false },
  local: { label: '本地目录', tag: '本地', cloud: false },
  s3: { label: 'S3 兼容存储', tag: '云端', cloud: true },
  lsky: { label: 'Lsky Pro', tag: '云端', cloud: true },
  smms: { label: 'SM.MS', tag: '云端', cloud: true }
}
const typeLabel = (s) => TYPE_META[s.type]?.label || s.type
const isCloud = (s) => !!TYPE_META[s.type]?.cloud
const cloudSources = computed(() => sources.value.filter(isCloud))

const uploadTargetId = ref('')
const uploadTarget = computed(() =>
  cloudSources.value.find((s) => s.id === uploadTargetId.value) || cloudSources.value[0] || null
)

async function loadSources() {
  sources.value = await api.getAssetSources()
  if (!cloudSources.value.some((s) => s.id === uploadTargetId.value)) {
    uploadTargetId.value = cloudSources.value[0]?.id || ''
  }
  if (active.value !== 'generated' && !sources.value.some((s) => s.id === active.value)) {
    active.value = 'generated'
  }
}

async function load() {
  await loadSources()
  assets.value = await api.getAssets(active.value)
  loaded.value = true
}
onMounted(load)

function switchTab(id) {
  if (active.value === id) return
  active.value = id
  loaded.value = false
  assets.value = []
  selected.value = new Set()
  load()
}

// ---------- 通用操作 ----------
const busyCopy = ref('')
const copiedName = ref('')
const deleting = ref('')
const uploading = ref('')
const tip = ref('')
const okTip = ref('')

function flashTip(msg) {
  okTip.value = msg
  setTimeout(() => { if (okTip.value === msg) okTip.value = '' }, 3600)
}

async function copyImg(img) {
  busyCopy.value = img.name
  tip.value = ''
  try {
    await api.copyImageToClipboardImg(active.value, img.name)
    copiedName.value = img.name
    setTimeout(() => { if (copiedName.value === img.name) copiedName.value = '' }, 1800)
  } catch (e) {
    tip.value = '复制失败：' + (e?.message || '剪贴板不可用')
  } finally {
    busyCopy.value = ''
  }
}

async function copyLink(url) {
  try {
    await copyText(url)
    flashTip('直链已复制到剪贴板')
  } catch (e) { tip.value = '复制失败：' + (e?.message || '剪贴板不可用') }
}

async function removeImg(img) {
  if (!window.confirm('删除这张图片？文件将从磁盘移除，不可恢复。')) return
  deleting.value = img.name
  const r = await api.deleteAssets(active.value, [img.name])
  deleting.value = ''
  if (r?.ok) {
    assets.value = assets.value.filter((x) => x.name !== img.name)
    flashTip('已删除')
  } else {
    tip.value = '删除失败，请重试'
  }
}

// ---------- 批量管理（管理模式：勾选 → 批量删除 / 清空；仅本地两类源） ----------
const selected = ref(new Set())
const batchBusy = ref(false)
const isBatchable = computed(() => active.value === 'generated' || activeSource.value?.type === 'local')

function toggleManage() {
  manageMode.value = !manageMode.value
  selected.value = new Set()
}
function toggleSelect(name) {
  const s = new Set(selected.value)
  if (s.has(name)) s.delete(name)
  else s.add(name)
  selected.value = s
}
function selectAll() {
  selected.value = new Set(assets.value.map((i) => i.name))
}
function onCardImgClick(img) {
  if (manageMode.value && isBatchable.value) toggleSelect(img.name)
  else openViewer(img)
}

async function deleteSelected() {
  const n = selected.value.size
  if (!n || batchBusy.value) return
  if (!window.confirm(`删除所选 ${n} 张图片？本地文件将被移除，不可恢复。`)) return
  batchBusy.value = true
  const r = await api.deleteAssets(active.value, [...selected.value])
  batchBusy.value = false
  if (r?.ok) {
    flashTip(`已删除 ${r.deleted} 张图片`)
    selected.value = new Set()
    await load()
  } else tip.value = '批量删除失败，请重试'
}

async function clearSource() {
  if (!assets.value.length || batchBusy.value) return
  const label = active.value === 'generated' ? '生成图库' : `「${activeSource.value.name}」`
  if (!window.confirm(`清空${label}的全部 ${assets.value.length} 张图片？本地文件将被移除，不可恢复。`)) return
  batchBusy.value = true
  const r = await api.deleteAssets(active.value, [], true)
  batchBusy.value = false
  if (r?.ok) {
    flashTip(`已清空 ${r.deleted} 张图片`)
    selected.value = new Set()
    await load()
  } else tip.value = '清空失败，请重试'
}

// ---------- 生成图库轮询（外部生图落盘后自动出现，无需手动刷新） ----------
const newGenCount = ref(0)
let pollTimer = null
let lastGenKeys = '' // 已知生成图的 name|size|mtime 指纹集合

function genFingerprint(list) {
  return list.map((i) => `${i.name}|${i.size}|${i.mtime || i.at || 0}`).join('\n')
}

async function pollTick() {
  if (document.hidden) return
  const list = await api.getAssets('generated').catch(() => null)
  if (!list) return
  const fp = genFingerprint(list)
  if (fp === lastGenKeys) return
  const known = new Set(lastGenKeys ? lastGenKeys.split('\n').map((l) => l.split('|')[0]) : [])
  const fresh = list.filter((i) => !known.has(i.name))
  if (active.value === 'generated') {
    // 当前就在生成图库：就地合并刷新，不打断浏览（新图按 mtime 倒序插在队首）
    assets.value = list
    if (fresh.length && loaded.value) {
      if (viewerOpen.value) viewerIdx.value += fresh.length
      flashTip(`检测到 ${fresh.length} 张新生成图片`)
    }
  } else if (fresh.length) {
    newGenCount.value += fresh.length
  }
  lastGenKeys = fp
}

onMounted(() => {
  pollTimer = setInterval(pollTick, 4000)
  window.addEventListener('keydown', onViewerKey)
})
onBeforeUnmount(() => {
  clearInterval(pollTimer)
  window.removeEventListener('keydown', onViewerKey)
})

// ---------- 页面内图片查看器（Lightbox） ----------
const viewerOpen = ref(false)
const viewerIdx = ref(0)
const viewerImg = computed(() => assets.value[viewerIdx.value] || null)

function openViewer(img) {
  const idx = assets.value.findIndex((x) => x.name === img.name)
  if (idx < 0) return
  viewerIdx.value = idx
  viewerOpen.value = true
}
function closeViewer() { viewerOpen.value = false }
function viewerStep(d) {
  const n = assets.value.length
  if (n > 1) viewerIdx.value = (viewerIdx.value + d + n) % n
}
async function viewerRemove(img) {
  const wasRemote = !!img.remote
  if (wasRemote) {
    await removeRecord(img)
  } else {
    await removeImg(img)
  }
  // 删除成功后 assets 已收缩：越界则收口，空了直接关查看器
  if (viewerIdx.value >= assets.value.length) viewerIdx.value = assets.value.length - 1
  if (!assets.value.length) viewerOpen.value = false
}
function onViewerKey(e) {
  if (!viewerOpen.value) return
  if (e.key === 'Escape') closeViewer()
  else if (e.key === 'ArrowLeft') viewerStep(-1)
  else if (e.key === 'ArrowRight') viewerStep(1)
}

// ---------- 上传到云端 ----------
async function uploadImg(img) {
  const target = uploadTarget.value
  if (!target) { tip.value = '请先添加一个云端素材源'; return }
  uploading.value = img.name
  tip.value = ''
  try {
    const r = await api.uploadAsset(target.id, active.value, img.name)
    if (r?.ok && r.url) {
      // 上传成功但复制失败要分开说，不能让用户以为直链已拿到手
      try {
        await copyText(r.url)
        flashTip(`已上传到「${target.name}」→ 直链已复制`)
      } catch {
        tip.value = `已上传到「${target.name}」，但复制失败：直链为 ${r.url}`
      }
      loadSources()
    } else throw new Error('返回异常')
  } catch (e) {
    tip.value = '上传失败：' + (e?.message || e)
  } finally {
    uploading.value = ''
  }
}

// ---------- 添加 / 管理素材源 ----------
const showAdd = ref(false)
const saving = ref(false)
const testing = ref(false)
const formErr = ref('')
const testResult = ref(null)
const form = reactive({ type: 'local', name: '', dir: '', endpoint: '', bucket: '', region: '', accessKey: '', secretKey: '', prefix: '', publicBase: '', pathStyle: true, api: '', token: '' })

function openAdd() {
  Object.assign(form, { type: form.type, name: '', dir: '', endpoint: '', bucket: '', region: '', accessKey: '', secretKey: '', prefix: '', publicBase: '', pathStyle: true, api: '', token: '' })
  formErr.value = ''
  testResult.value = null
  showAdd.value = true
}
function pickType(t) {
  form.type = t
  formErr.value = ''
  testResult.value = null
}
function formConfig() {
  return {
    local: { dir: form.dir },
    s3: { endpoint: form.endpoint, bucket: form.bucket, region: form.region, accessKey: form.accessKey, secretKey: form.secretKey, prefix: form.prefix, publicBase: form.publicBase, pathStyle: form.pathStyle },
    lsky: { api: form.api, token: form.token },
    smms: { token: form.token }
  }[form.type]
}
async function testSource() {
  testing.value = true
  formErr.value = ''
  testResult.value = null
  try {
    testResult.value = await api.testAssetSource({ type: form.type, config: formConfig() })
  } catch (e) {
    testResult.value = { ok: false, message: e?.message || '测试失败' }
  } finally {
    testing.value = false
  }
}
async function saveSource() {
  saving.value = true
  formErr.value = ''
  try {
    const r = await api.saveAssetSource({ type: form.type, name: form.name, config: formConfig() })
    showAdd.value = false
    await loadSources()
    switchTab(r.source.id)
  } catch (e) {
    formErr.value = e?.message || '保存失败'
  } finally {
    saving.value = false
  }
}

async function removeSource(s) {
  if (!window.confirm(`删除素材源「${s.name}」？云端已上传的文件不受影响，仅移除本地记录。`)) return
  await api.deleteAssetSource(s.id)
  if (active.value === s.id) { active.value = 'generated'; loaded.value = false }
  load()
}

const activeSource = computed(() => sources.value.find((s) => s.id === active.value) || null)

// ---------- 导入图片到本地源（文件选择 + 拖拽） ----------
const importing = ref(0)
const dragOver = ref(false)

async function importFiles(fileList) {
  const src = activeSource.value
  if (!src || src.type !== 'local') return
  const files = Array.from(fileList || []).filter((f) => f.type.startsWith('image/'))
  if (!files.length) return
  importing.value = files.length
  tip.value = ''
  let done = 0
  const errs = []
  for (const f of files) {
    try {
      await api.importAsset(src.id, f)
      done++
    } catch (e) {
      errs.push(`${f.name}: ${e?.message || '失败'}`)
    } finally {
      importing.value--
    }
  }
  if (done) flashTip(`已导入 ${done} 张图片到「${src.name}」`)
  if (errs.length) tip.value = '部分导入失败 —— ' + errs.join('；')
  await load()
}

function onDrop(e) {
  dragOver.value = false
  if (activeSource.value?.type !== 'local') return
  importFiles(e.dataTransfer?.files)
}

// ---------- 云端记录 ----------
async function removeRecord(img) {
  if (!window.confirm(`移除上传记录「${img.name}」？（不会删除云端文件）`)) return
  const r = await api.deleteUploadRecord(active.value, img.name)
  if (r?.ok) assets.value = assets.value.filter((x) => x.name !== img.name)
  else tip.value = '移除失败，请重试'
}

// ---------- 显示 ----------
const fmtSize = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB')
const fmtDate = (ms) => {
  const d = new Date(ms)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const thumbUrl = (img) => (img.remote ? img.url : api.assetFileUrl(active.value, img.name))
const emptyText = computed(() => {
  if (active.value === 'generated') return '在 WorkBuddy / Codex 里让模型生图，图片经网关的 image_generation 工具生成后会自动落盘到这里。'
  const s = sources.value.find((x) => x.id === active.value)
  if (s?.type === 'local') return `目录「${s.config.dir}」里暂无图片（支持 png / jpg / webp / gif / svg）。`
  return '还没有上传记录。到「生成图库」或「本地目录」选择图片，点「上传」推送到该云端源。'
})
</script>

<template>
  <div class="content">
    <div class="page-head">
      <div class="live-tag"><span class="dot"></span>图片素材 · 多来源统一管理 · 共 {{ assets.length }} 项</div>
      <div class="head-actions">
        <select v-if="cloudSources.length > 1" class="target-select" v-model="uploadTargetId" title="上传目标">
          <option v-for="s in cloudSources" :key="s.id" :value="s.id">上传到 {{ s.name }}</option>
        </select>
        <button
          v-if="activeSource?.type === 'local'"
          class="refresh primary"
          :disabled="importing > 0"
          @click="$refs.fileInput.click()"
        >{{ importing > 0 ? `导入中（剩 ${importing}）…` : '导入图片' }}</button>
        <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="importFiles($event.target.files); $event.target.value = ''" />
        <button class="refresh" :class="{ warn: manageMode }" @click="toggleManage">{{ manageMode ? '完成' : '管理' }}</button>
        <button class="refresh primary" @click="openAdd">+ 添加素材源</button>
        <button class="refresh" @click="load">刷新</button>
      </div>
    </div>

    <!-- 来源 Tabs -->
    <div class="tabs">
      <button class="tab" :class="{ on: active === 'generated' }" @click="switchTab('generated')">
        生成图库<span v-if="newGenCount > 0 && active !== 'generated'" class="new-badge">+{{ newGenCount }}</span>
      </button>
      <button
        v-for="s in sources"
        :key="s.id"
        class="tab"
        :class="{ on: active === s.id, cloud: isCloud(s) }"
        @click="switchTab(s.id)"
      >
        {{ s.name }}<span class="ttag">{{ TYPE_META[s.type]?.tag }}</span>
        <span v-if="manageMode && isCloud(s)" class="tdelete" title="删除素材源" @click.stop="removeSource(s)">✕</span>
      </button>
    </div>

    <!-- 批量操作栏（管理模式 + 本地两类源：批量删除 / 清空） -->
    <div class="manage-bar" v-if="manageMode && isBatchable">
      <span class="mb-count mono">已选 {{ selected.size }} / {{ assets.length }}</span>
      <button class="refresh" @click="selectAll">全选</button>
      <button class="refresh" :disabled="!selected.size" @click="selected = new Set()">取消选择</button>
      <button class="refresh danger" :disabled="!selected.size || batchBusy" @click="deleteSelected">{{ batchBusy ? '处理中…' : '删除所选' }}</button>
      <button class="refresh danger" :disabled="!assets.length || batchBusy" @click="clearSource">清空</button>
      <span class="mb-note">点击图片勾选 / 取消勾选</span>
    </div>

    <!-- 素材网格（本地源支持拖拽导入） -->
    <div
      class="grid drop-zone"
      :class="{ over: dragOver }"
      :data-srcname="activeSource?.name || ''"
      v-if="assets.length"
      @dragover.prevent="activeSource?.type === 'local' && (dragOver = true)"
      @dragleave="dragOver = false"
      @drop.prevent="onDrop"
    >
      <div class="card" v-for="img in assets" :key="img.name" :class="{ sel: manageMode && isBatchable && selected.has(img.name) }">
        <div class="thumb">
          <img :src="thumbUrl(img)" :alt="img.name" draggable="true" loading="lazy" @click="onCardImgClick(img)" />
          <div class="sel-dot" v-if="manageMode && isBatchable" :class="{ on: selected.has(img.name) }">✓</div>
          <div class="overlay" v-if="!manageMode">
            <template v-if="!img.remote">
              <button class="act primary" :class="{ done: copiedName === img.name }" @click="copyImg(img)" :disabled="busyCopy === img.name">
                {{ busyCopy === img.name ? '复制中…' : copiedName === img.name ? '✓ 已复制' : '复制图片' }}
              </button>
              <a class="act" :href="thumbUrl(img)" :download="img.name" @click.stop>下载</a>
              <button
                v-if="cloudSources.length"
                class="act up"
                @click="uploadImg(img)"
                :disabled="uploading === img.name"
                :title="'上传到 ' + (uploadTarget?.name || '云端')"
              >{{ uploading === img.name ? '上传中…' : '上传' }}</button>
              <button class="act danger" @click="removeImg(img)" :disabled="deleting === img.name">
                {{ deleting === img.name ? '删除中…' : '删除' }}
              </button>
            </template>
            <template v-else>
              <button class="act primary" @click="copyLink(img.url)">复制直链</button>
              <a class="act" :href="img.url" target="_blank" @click.stop>打开</a>
              <button class="act danger" @click="removeRecord(img)">移除记录</button>
            </template>
          </div>
        </div>
        <div class="meta">
          <span class="name mono" :title="img.name">{{ img.name }}</span>
          <span class="sub mono">
            {{ fmtSize(img.size) }} · {{ fmtDate(img.mtime || img.at) }}
            <template v-if="img.remote"> · {{ TYPE_META[sources.find((s) => s.id === active)?.type]?.tag }}</template>
          </span>
        </div>
      </div>
    </div>

    <div
      class="card empty drop-zone"
      :class="{ over: dragOver }"
      :data-srcname="activeSource?.name || ''"
      v-else-if="loaded"
      @dragover.prevent="activeSource?.type === 'local' && (dragOver = true)"
      @dragleave="dragOver = false"
      @drop.prevent="onDrop"
    >
      <div class="empty-title">{{ active === 'generated' ? '生成图库还是空的' : '这里还没有素材' }}</div>
      <div class="empty-sub">{{ emptyText }}</div>
      <div class="empty-hint" v-if="activeSource?.type === 'local'">把图片拖到这里，或点右上角「导入图片」</div>
    </div>
    <div class="card empty" v-else>
      <div class="empty-sub">载入中…</div>
    </div>

    <div class="tips">
      <div class="error-tip" v-if="tip">{{ tip }}</div>
      <div class="ok-tip" v-if="okTip">{{ okTip }}</div>
    </div>

    <!-- 添加素材源弹窗 -->
    <div class="modal-mask" v-if="showAdd" @click.self="showAdd = false">
      <div class="modal">
        <div class="card-title">添加素材源</div>
        <div class="type-row">
          <button
            v-for="t in ['local', 's3', 'lsky', 'smms']"
            :key="t"
            class="type-pick"
            :class="{ on: form.type === t }"
            @click="pickType(t)"
          >
            <b>{{ TYPE_META[t].label }}</b>
            <i>{{ TYPE_META[t].tag }}</i>
          </button>
        </div>

        <label class="f-label">名称（可选）</label>
        <input class="f-input" v-model="form.name" maxlength="40" placeholder="默认按类型命名" />

        <template v-if="form.type === 'local'">
          <label class="f-label">目录路径</label>
          <input class="f-input mono" v-model="form.dir" placeholder="例如 C:\Users\你的用户名\Pictures\assets" />
        </template>

        <template v-else-if="form.type === 's3'">
          <label class="f-label">Endpoint（S3 兼容，兼容 R2 / OSS / COS / MinIO）</label>
          <input class="f-input mono" v-model="form.endpoint" placeholder="https://<accountid>.r2.cloudflarestorage.com" />
          <div class="f-grid">
            <div><label class="f-label">Bucket</label><input class="f-input mono" v-model="form.bucket" /></div>
            <div><label class="f-label">Region</label><input class="f-input mono" v-model="form.region" placeholder="us-east-1 / auto" /></div>
          </div>
          <div class="f-grid">
            <div><label class="f-label">Access Key</label><input class="f-input mono" v-model="form.accessKey" /></div>
            <div><label class="f-label">Secret Key</label><input class="f-input mono" type="password" v-model="form.secretKey" /></div>
          </div>
          <div class="f-grid">
            <div><label class="f-label">目录前缀（可选）</label><input class="f-input mono" v-model="form.prefix" placeholder="assets/" /></div>
            <div><label class="f-label">公开访问域名（可选）</label><input class="f-input mono" v-model="form.publicBase" placeholder="https://cdn.example.com" /></div>
          </div>
          <div class="f-note">未填公开域名时返回 7 天有效的预签名 URL。</div>
        </template>

        <template v-else-if="form.type === 'lsky'">
          <label class="f-label">站点地址</label>
          <input class="f-input mono" v-model="form.api" placeholder="https://your-lsky-site.com" />
          <label class="f-label">API Token（个人中心生成）</label>
          <input class="f-input mono" type="password" v-model="form.token" />
        </template>

        <template v-else-if="form.type === 'smms'">
          <label class="f-label">API Token（sm.ms → API → Token）</label>
          <input class="f-input mono" type="password" v-model="form.token" />
        </template>

        <div class="form-err" v-if="formErr">{{ formErr }}</div>
        <div :class="testResult?.ok ? 'test-ok' : 'form-err'" v-if="testResult">{{ testResult.ok ? '✓ ' : '✗ ' }}{{ testResult.message }}</div>
        <div class="modal-actions">
          <button class="refresh" @click="showAdd = false">取消</button>
          <button class="refresh" :disabled="testing || saving" @click="testSource">{{ testing ? '测试中…' : '测试连接' }}</button>
          <button class="btn-primary" :disabled="saving" @click="saveSource">{{ saving ? '保存中…' : '保存并切换' }}</button>
        </div>
      </div>
    </div>

    <!-- 图片查看器（页面内 Lightbox，Esc 关闭 / ←→ 切换；两侧空白点击同样翻页） -->
    <div class="lightbox" v-if="viewerOpen && viewerImg" @wheel.prevent>
      <button class="lb-close" title="关闭 (Esc)" @click="closeViewer">✕</button>
      <button v-if="assets.length > 1" class="lb-nav prev" title="上一张 (←)" @click="viewerStep(-1)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
      </button>
      <div class="lb-zone" :class="{ multi: assets.length > 1 }" title="上一张" @click="viewerStep(-1)"></div>
      <div class="lb-stage">
        <img :src="thumbUrl(viewerImg)" :alt="viewerImg.name" @dragstart.prevent />
        <div class="lb-bar">
          <div class="lb-info">
            <span class="lb-name mono" :title="viewerImg.name">{{ viewerImg.name }}</span>
            <span class="lb-sub mono">{{ fmtSize(viewerImg.size) }} · {{ fmtDate(viewerImg.mtime || viewerImg.at) }}<template v-if="viewerImg.remote"> · 云端</template> · {{ viewerIdx + 1 }} / {{ assets.length }}</span>
          </div>
          <div class="lb-actions">
            <template v-if="!viewerImg.remote">
              <button class="act primary" :class="{ done: copiedName === viewerImg.name }" @click="copyImg(viewerImg)" :disabled="busyCopy === viewerImg.name">
                {{ busyCopy === viewerImg.name ? '复制中…' : copiedName === viewerImg.name ? '✓ 已复制' : '复制图片' }}
              </button>
              <a class="act" :href="thumbUrl(viewerImg)" :download="viewerImg.name">下载</a>
              <button
                v-if="cloudSources.length"
                class="act up"
                @click="uploadImg(viewerImg)"
                :disabled="uploading === viewerImg.name"
                :title="'上传到 ' + (uploadTarget?.name || '云端')"
              >{{ uploading === viewerImg.name ? '上传中…' : '上传' }}</button>
              <button class="act danger" @click="viewerRemove(viewerImg)" :disabled="deleting === viewerImg.name">
                {{ deleting === viewerImg.name ? '删除中…' : '删除' }}
              </button>
            </template>
            <template v-else>
              <button class="act primary" @click="copyLink(viewerImg.url)">复制直链</button>
              <a class="act" :href="viewerImg.url" target="_blank">原始页打开</a>
              <button class="act danger" @click="viewerRemove(viewerImg)">移除记录</button>
            </template>
          </div>
        </div>
      </div>
      <div class="lb-zone" :class="{ multi: assets.length > 1 }" title="下一张" @click="viewerStep(1)"></div>
      <button v-if="assets.length > 1" class="lb-nav next" title="下一张 (→)" @click="viewerStep(1)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6" /></svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.page-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.live-tag { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--emerald-light); font-family: var(--mono); }
.live-tag .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--emerald-light); animation: pulse 1.5s infinite; }
.head-actions { display: flex; gap: 8px; align-items: center; }
.target-select {
  background: var(--card); color: var(--emerald-light); border: 1px solid var(--border);
  border-radius: 7px; padding: 5px 8px; font-size: 11.5px; font-family: var(--mono); outline: none;
}
.refresh {
  background: var(--card); color: var(--text-2); border: 1px solid var(--border);
  border-radius: 7px; padding: 5px 14px; font-size: 12px; cursor: pointer; transition: all 0.15s ease;
}
.refresh:hover { color: var(--text); border-color: var(--emerald); }
.refresh.primary { background: var(--emerald); color: #04130d; font-weight: 550; border-color: transparent; }
.refresh.warn { color: var(--amber); border-color: var(--amber); }

.tabs { display: flex; gap: 8px; flex-wrap: wrap; margin: 4px 0 14px; }
.tab {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--card); color: var(--text-2); border: 1px solid var(--border);
  border-radius: 999px; padding: 6px 14px; font-size: 12.5px; cursor: pointer; transition: all 0.15s ease;
}
.tab:hover { color: var(--text); border-color: rgba(16, 185, 129, 0.4); }
.tab.on { background: var(--emerald-dim); color: var(--emerald-light); border-color: rgba(16, 185, 129, 0.5); }
.ttag { font-size: 10px; padding: 1px 6px; border-radius: 6px; background: rgba(154, 160, 168, 0.12); color: var(--text-3); }
.tab.on .ttag { background: rgba(16, 185, 129, 0.16); color: var(--emerald-light); }
.tdelete { font-size: 11px; color: var(--rose); padding: 0 2px; }
.tdelete:hover { text-decoration: underline; }
.new-badge {
  font-size: 10px; padding: 1px 7px; border-radius: 999px;
  background: var(--emerald); color: #04130d; font-weight: 600;
  animation: pulse 1.5s infinite;
}

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
.grid.drop-zone { position: relative; border-radius: 12px; }
.grid.drop-zone.over { outline: 2px dashed var(--emerald); outline-offset: 6px; }
.grid.drop-zone.over::after {
  content: '松开导入到「' attr(data-srcname) '」';
  position: absolute; inset: 0; z-index: 5; pointer-events: none;
  display: flex; align-items: center; justify-content: center;
  background: rgba(4, 19, 13, 0.72); color: var(--emerald-light);
  font-size: 14px; font-weight: 550; border-radius: 12px;
}
.card {
  background: var(--card); border: 1px solid var(--border); border-radius: 12px; overflow: hidden;
  transition: border-color 0.15s ease;
}
.card:hover { border-color: rgba(16, 185, 129, 0.45); }
.card.sel { border-color: var(--emerald); box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.35); }
.sel-dot {
  position: absolute; top: 8px; left: 8px; z-index: 3;
  width: 22px; height: 22px; border-radius: 50%;
  border: 1.5px solid rgba(255, 255, 255, 0.65); background: rgba(0, 0, 0, 0.35);
  color: transparent; font-size: 12px; font-weight: 700; line-height: 19px; text-align: center;
  transition: all 0.12s ease;
}
.sel-dot.on { background: var(--emerald); border-color: var(--emerald); color: #04130d; }
.thumb { position: relative; height: 168px; background: #0b0d10; }
.thumb img {
  width: 100%; height: 100%; object-fit: cover; display: block; cursor: zoom-in;
  transition: transform 0.2s ease;
}
.card:hover .thumb img { transform: scale(1.03); }
.overlay {
  position: absolute; inset: auto 0 0 0; padding: 26px 8px 8px;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.78));
  display: flex; gap: 6px; align-items: center; justify-content: center; flex-wrap: wrap;
  opacity: 0; transition: opacity 0.15s ease;
}
.card:hover .overlay { opacity: 1; }
.act {
  background: rgba(255, 255, 255, 0.12); color: #fff; border: none; border-radius: 7px;
  padding: 6px 10px; font-size: 11px; cursor: pointer; text-decoration: none;
  transition: all 0.15s ease; backdrop-filter: blur(4px); white-space: nowrap;
}
.act:hover { background: rgba(255, 255, 255, 0.22); }
.act.primary { background: var(--emerald); color: #04130d; font-weight: 550; }
.act.primary:hover { background: var(--emerald-light); }
.act.primary.done { background: #059669; color: #fff; }
.act.up { background: rgba(96, 165, 250, 0.85); color: #0a1626; font-weight: 550; }
.act.up:hover { background: #60a5fa; }
.act.danger:hover { background: rgba(244, 63, 94, 0.85); }
.meta { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px 12px; }
.name { font-size: 11.5px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub { font-size: 10.5px; color: var(--text-3); }
.mono { font-family: var(--mono); }

.empty { padding: 42px 8px; text-align: center; }
.empty-hint { margin-top: 10px; font-size: 11.5px; color: var(--emerald-light); }
.drop-zone.over { outline: 2px dashed var(--emerald); outline-offset: 4px; }
.empty-title { font-size: 13.5px; color: var(--text-2); margin-bottom: 8px; }
.empty-sub { font-size: 12px; color: var(--text-3); line-height: 1.7; max-width: 480px; margin: 0 auto; word-break: break-all; }

.tips { min-height: 20px; }
.error-tip { font-size: 12px; color: var(--rose); }
.ok-tip { font-size: 12px; color: var(--emerald-light); }

.modal-mask {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); z-index: 60;
  display: flex; align-items: center; justify-content: center;
}
.modal {
  width: 480px; max-width: calc(100vw - 40px); max-height: 86vh; overflow-y: auto;
  background: var(--card); border: 1px solid var(--border-strong); border-radius: 14px; padding: 18px;
  display: flex; flex-direction: column; gap: 6px;
}
.type-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 10px 0 4px; }
.type-pick {
  background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
  padding: 8px 4px; cursor: pointer; text-align: center; color: var(--text-2); transition: all 0.15s ease;
  display: flex; flex-direction: column; gap: 2px; align-items: center;
}
.type-pick b { font-size: 11.5px; font-weight: 550; }
.type-pick i { font-style: normal; font-size: 10px; color: var(--text-3); }
.type-pick.on { border-color: var(--emerald); background: var(--emerald-dim); color: var(--emerald-light); }
.f-label { font-size: 11.5px; color: var(--text-2); margin-top: 8px; display: block; }
.f-input {
  width: 100%; box-sizing: border-box; margin-top: 4px;
  font-size: 12.5px; color: var(--text); background: var(--bg);
  border: 1px solid var(--border-strong); border-radius: 8px; padding: 8px 10px; outline: none;
}
.f-input:focus { border-color: var(--emerald); }
.f-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.f-note { font-size: 11px; color: var(--text-3); margin-top: 8px; }
.form-err { margin-top: 10px; font-size: 12px; color: var(--rose); }
.test-ok { margin-top: 10px; font-size: 12px; color: var(--emerald-light); }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
.btn-primary {
  background: var(--emerald); color: #04130d; font-weight: 600; border: none;
  border-radius: 8px; padding: 8px 18px; font-size: 12.5px; cursor: pointer;
}
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

/* ---------- 图片查看器（Lightbox） ---------- */
.lightbox {
  position: fixed; inset: 0; z-index: 70;
  background: rgba(2, 6, 10, 0.86); backdrop-filter: blur(6px);
  display: flex; align-items: center; justify-content: center;
  padding: 30px 20px;
}
/* 两侧空白热区：点击即翻页，不再误触退出 */
.lb-zone { flex: 1; align-self: stretch; cursor: default; }
.lb-zone.multi { cursor: pointer; }
.lb-zone.multi:hover { background: rgba(16, 185, 129, 0.05); }
.lb-close {
  position: absolute; top: 16px; right: 18px;
  width: 34px; height: 34px; border-radius: 9px; border: 1px solid var(--border-strong);
  background: rgba(255, 255, 255, 0.06); color: var(--text-2); font-size: 14px; cursor: pointer;
  transition: all 0.15s ease;
}
.lb-close:hover { color: var(--text); background: rgba(255, 255, 255, 0.14); }
/* 翻页按钮：固定吸附屏幕左右两侧、垂直居中，热区加大 —— 连点不用重新瞄准，也碰不到遮罩 */
.lb-nav {
  position: absolute; top: 50%; transform: translateY(-50%); z-index: 72;
  width: 52px; height: 72px; border-radius: 12px; border: 1px solid var(--border-strong);
  background: rgba(255, 255, 255, 0.08); color: var(--text-2); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s ease;
}
.lb-nav.prev { left: 22px; }
.lb-nav.next { right: 22px; }
.lb-nav:hover { color: var(--text); background: rgba(255, 255, 255, 0.16); border-color: rgba(16, 185, 129, 0.5); }
.lb-nav:active { transform: translateY(-50%) scale(0.94); }
.lb-nav svg { width: 20px; height: 20px; }
.lb-stage {
  min-width: 0; max-width: min(1100px, calc(100vw - 180px));
  max-height: calc(100vh - 60px);
  display: flex; flex-direction: column; gap: 0;
  background: var(--card); border: 1px solid var(--border-strong); border-radius: 14px;
  overflow: hidden;
}
.lb-stage img {
  display: block; min-height: 0; flex: 1;
  max-width: 100%; max-height: calc(100vh - 170px);
  object-fit: contain; margin: 0 auto; background: #0b0d10;
}
.lb-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;
  padding: 10px 14px; border-top: 1px solid var(--border);
  background: var(--card);
}
.lb-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.lb-name { font-size: 12px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 360px; }
.lb-sub { font-size: 10.5px; color: var(--text-3); }
.lb-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.lb-actions .act { background: rgba(255, 255, 255, 0.08); color: var(--text-2); border: 1px solid var(--border); }
.lb-actions .act:hover { background: rgba(255, 255, 255, 0.16); color: var(--text); }
.lb-actions .act.primary { background: var(--emerald); color: #04130d; font-weight: 550; border-color: transparent; }
.lb-actions .act.primary:hover { background: var(--emerald-light); }
.lb-actions .act.primary.done { background: #059669; color: #fff; }
.lb-actions .act.up { background: rgba(96, 165, 250, 0.85); color: #0a1626; font-weight: 550; border-color: transparent; }
.lb-actions .act.up:hover { background: #60a5fa; }
.lb-actions .act.danger:hover { background: rgba(244, 63, 94, 0.85); color: #fff; }
</style>
