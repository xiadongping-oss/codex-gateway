(() => {
  const el = id => document.getElementById('migration-' + id)
  const invoke = request => window.__TAURI__.core.invoke('migration_request', { request })
  let context, fingerprint, busy = false, loading = false, recovery = false, completed = false, lastVisible = false, lastCode
  const messages = {
    MIGRATION_SOURCE_MISSING: '找不到旧数据目录，请核对完整路径。', ENOENT: '有文件或目录不存在，请核对所选路径。',
    MIGRATION_ABSOLUTE_PATH_REQUIRED: '请填写完整的绝对路径。', MIGRATION_INVALID_ACCOUNTS: '账号注册表与凭据不一致，请检查原数据；未进行迁移。',
    MIGRATION_INVALID_JSON: '旧数据文件格式不完整，请先修复原文件。', MIGRATION_INVALID_STORE: '旧数据格式不受支持，已保留原文件。',
    MIGRATION_SOURCE_CHANGED: '检查之后旧数据发生变化，请停止写入并重新检查。', MIGRATION_PLAN_CHANGED: '迁移内容已变化，请重新检查。',
    MIGRATION_PLAN_REQUIRED: '请先重新检查迁移内容。', MIGRATION_DATA_IN_USE: '数据目录仍有使用记录，请先从原入口退出网关。不会自动删除未知的使用记录。',
    MIGRATION_GATEWAY_ACTIVE: '本机网关仍在运行或退出中，暂时不能迁移。', MIGRATION_STOP_CONFIRMATION_REQUIRED: '请先退出旧网关和图库写入方，再勾选确认。',
    MIGRATION_PENDING_LOGIN: '原目录还有未完成的登录，请先在旧版中完成或取消登录。', MIGRATION_TARGET_EXISTS: '目标已有其他数据，不能直接合并或覆盖。',
    MIGRATION_LAYOUT_UNSUPPORTED: '旧目录的数据版本不受支持，不能降级迁移。', MIGRATION_CONTENT_CHANGED: '数据或备份发生变化，已拒绝覆盖。请保留文件进行检查。',
    MIGRATION_PATH_REVIEW_REQUIRED: '配置中有需确认的文件位置，请展开“外部文件位置”指定完整路径。',
    MIGRATION_EXTERNAL_PATH_REVIEW_REQUIRED: '发现外部文件位置，请核对后勾选保留，或明确指定新位置。',
    MIGRATION_PATH_NOT_COPIED: '配置引用了本次不会复制的文件，请明确指定其位置。', MIGRATION_INCOMPLETE_SNAPSHOT: '上次复制尚未完成，或回退正在进行。请先取消并恢复，再重新检查。',
    MIGRATION_UNKNOWN_TRANSACTION: '无法验证迁移记录。请保留原目录和备份，不要删除保护目录后强行启动。',
    MIGRATION_INTERRUPTED: '迁移已中断。若留下未完成记录，下次打开可继续或取消。',
    MIGRATION_LINK_REFUSED: '数据中存在链接文件或链接目录，请先核对真实存放位置。',
    MIGRATION_NESTED_BACKUP_REVIEW_REQUIRED: '源目录包含已有备份，需要单独核对，暂不自动迁移。',
    DATA_DIR_INVALID: '数据位置不可用，不能与程序目录重叠或指向链接。', RESOURCES_INVALID: '应用资源校验失败，请重新准备完整应用。'
  }
  const describe = error => messages[String(error)] || '操作未完成，原数据和已有备份已保留。请核对目录后重试。'
  function controls() {
    for (const input of el('form').querySelectorAll('input,select,button')) input.disabled = busy || loading
    for (const name of ['apply', 'resume', 'abort', 'rollback']) el(name).disabled = busy || loading || !el('stopped').checked
    el('stopped').disabled = busy || loading
  }
  function invalidate() {
    fingerprint = undefined
    el('review').hidden = el('apply').hidden = true
    el('stopped').checked = false
    el('confirm').hidden = !recovery && !completed
    controls()
  }
  function renderContext(result) {
    context = result; recovery = result.pending
    el('target').textContent = result.targetRoot
    if (!el('source').value && result.targetExists) el('source').value = result.targetRoot
    el('form').hidden = recovery || completed
    el('recovery').hidden = el('resume').hidden = el('abort').hidden = !recovery
    if (recovery) {
      invalidate(); el('confirm').hidden = false
      const r = result.recovery
      if (r) el('recovery-summary').textContent = `来源：${r.sourceRoot}。已记录 ${r.files} 个数据文件、${r.galleryFiles} 个图库文件。继续将核对备份后完成迁移；若复制未完成，请取消并重新检查。`
    }
  }
  async function loadContext() {
    if (loading || busy) return
    loading = true; controls()
    try { renderContext(await invoke({ operation: 'context' })) }
    catch (error) { el('error').textContent = describe(error) }
    finally { loading = false; controls() }
  }
  async function run(request, label) {
    if (busy || loading) return
    busy = true; controls(); el('error').textContent = ''; el('progress').textContent = label
    try {
      const result = await invoke(request)
      if (request.operation === 'plan') {
        fingerprint = result.fingerprint
        el('summary').textContent = `${result.inPlace ? '在原数据位置升级' : '复制到桌面版数据目录'} · ${result.files} 个数据文件 · ${result.galleryFiles} 个图库文件 · ${(result.bytes / 1048576).toFixed(2)} MB`
        el('path-changes').textContent = `配置调整 ${result.pathChanges.length} 项，保留外部路径 ${result.externalPathCount} 项。${el('gallery-choice').value === 'skip' ? '本次不导入图片，原图库继续保留。' : '图片与归属索引一同复制，原图库保留。'}`
        el('review').hidden = el('apply').hidden = el('confirm').hidden = false
        el('stopped').checked = false; el('step').textContent = '2 · 核对并确认'
        el('review').scrollIntoView({ block: 'center', behavior: 'smooth' })
      } else {
        completed = result.phase === 'committed'; fingerprint = undefined; context = undefined
        el('review').hidden = el('apply').hidden = true
        el('result').hidden = false; el('archive').textContent = result.archive
        el('result-title').textContent = completed ? '迁移完成，备份已保留' : '旧数据已保留，迁移已取消'
        el('rollback').hidden = !completed; el('confirm').hidden = !completed
        el('stopped').checked = false; el('step').textContent = completed ? '3 · 已完成' : '1 · 重新检查'
        el('start').hidden = !completed
        el('result').scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
    } catch (error) {
      invalidate(); context = undefined; el('error').textContent = describe(error)
    } finally {
      busy = false; el('progress').textContent = ''; controls()
      if (!context) await loadContext()
    }
  }
  el('form').addEventListener('input', invalidate)
  el('gallery-choice').onchange = () => {
    const importing = el('gallery-choice').value === 'import'
    el('gallery-field').hidden = !importing; el('gallery').required = importing
    invalidate()
  }
  el('form').onsubmit = event => {
    event.preventDefault()
    if (!el('gallery-choice').value) return
    const pathMappings = {}
    if (el('auth-map').value.trim()) pathMappings.authFilePath = el('auth-map').value.trim()
    if (el('reference-map').value.trim()) pathMappings.referenceRoot = el('reference-map').value.trim()
    run({ operation: 'plan', selection: { sourceRoot: el('source').value.trim(), sourceKind: el('kind').value,
      galleryRoot: el('gallery-choice').value === 'import' ? el('gallery').value.trim() : null,
      keepExternalPaths: el('external').checked, pathMappings } }, '正在检查旧数据，尚未修改文件…')
  }
  el('stopped').onchange = controls
  el('start').onclick = async () => {
    if (busy) return
    try { await window.__TAURI__.core.invoke('gateway_action', { action: 'retry' }) }
    catch (error) { el('error').textContent = describe(error) }
  }
  for (const operation of ['apply', 'resume', 'abort', 'rollback']) el(operation).onclick = () => {
    if (!el('stopped').checked || (operation === 'apply' && !fingerprint)) return
    run({ operation, sourceStopped: true, ...(operation === 'apply' ? { fingerprint } : {}) }, operation === 'apply' ? '正在备份、核对并迁移…' : '正在核对并处理恢复…')
  }
  window.migrationWizard = {
    refreshAfterRestore() {
      completed = false; context = undefined
      el('result').hidden = el('rollback').hidden = el('start').hidden = true
      invalidate(); loadContext()
    },
    update(state) {
      const visible = ['setup', 'migrating', 'migration_complete'].includes(state.phase) || ['DATA_MIGRATION_REQUIRED', 'DATA_MIGRATION_PENDING'].includes(state.code)
      el('panel').hidden = !visible
      document.body.classList.toggle('migration-mode', visible)
      if (visible && (!lastVisible || (state.code === 'DATA_MIGRATION_PENDING' && state.code !== lastCode))) { context = undefined; loadContext() }
      lastVisible = visible
      lastCode = state.code
    }
  }
})()
