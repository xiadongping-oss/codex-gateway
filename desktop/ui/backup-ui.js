(() => {
  const el = id => document.getElementById('backup-' + id)
  const invoke = request => window.__TAURI__.core.invoke('migration_request', { request })
  let busy = false, allowed = false, canRestore = false, previousPhase
  const reasons = {
    MIGRATION_CONTENT_CHANGED: '现有数据或备份已发生变化，不能直接回退。请保留新增内容；自动合并恢复尚未提供。',
    MIGRATION_SOURCE_MISSING: '当前数据目录缺失，不能执行直接回退，请保留备份进行核查。',
    MIGRATION_PENDING: '有尚未完成的迁移，请先继续或取消该次迁移。',
    MIGRATION_DATA_IN_USE: '数据仍被其他程序使用，请先退出相关程序。',
    MIGRATION_PENDING_LOGIN: '还有未完成的登录，请先完成或取消登录。',
    MIGRATION_GATEWAY_ACTIVE: '请先停止网关，再检查或回退备份。',
    MIGRATION_BACKUP_REVIEW_REQUIRED: '请重新检查所选备份。',
    MIGRATION_STOP_CONFIRMATION_REQUIRED: '请先退出其他写入程序并勾选确认。'
  }
  const message = code => reasons[String(code)] || '无法核对备份，文件已保留。请检查目录和备份完整性。'
  function controls() {
    el('refresh').disabled = busy || !allowed
    for (const button of el('list').querySelectorAll('button')) button.disabled = busy || !allowed
    el('stopped').disabled = busy || !allowed || !canRestore
    el('restore').disabled = busy || !allowed || !canRestore || !el('stopped').checked
  }
  function resetReview() {
    canRestore = false; el('stopped').checked = false; el('review').hidden = true; controls()
  }
  async function perform(request) {
    if (busy || !allowed) return
    busy = true; controls(); el('error').textContent = ''; el('status').textContent = '正在核对备份…'
    try {
      const result = await invoke(request)
      if (request.operation === 'history') {
        resetReview(); el('list').replaceChildren()
        for (const item of result.backups) {
          const row = document.createElement('div'); row.className = 'backup-row'
          const text = document.createElement('p')
          text.textContent = `${new Date(item.recordedAt).toLocaleString()} · ${item.files} 个数据文件 · ${item.galleryFiles} 个图库文件 · ${item.phase === 'aborted' ? '已取消或回退，备份保留' : '迁移已完成'}`
          row.append(text)
          if (item.phase === 'committed') {
            const button = document.createElement('button'); button.className = 'secondary'; button.textContent = '检查能否回退'
            button.onclick = () => perform({ operation: 'backup_review', archiveId: item.id }); row.append(button)
          }
          el('list').append(row)
        }
        el('status').textContent = `找到 ${result.backups.length} 份备份。${result.unavailable ? `另有 ${result.unavailable} 份无法核对，已保留。` : ''}${result.omitted ? `本次仅扫描 50 份，另有 ${result.omitted} 份需从备份目录核查。` : ''}`
      } else if (request.operation === 'backup_review') {
        canRestore = result.canRollback; el('stopped').checked = false
        el('review').hidden = false; el('location').textContent = result.archive
        el('summary').textContent = `${result.inPlace ? '恢复迁移前的原目录' : '撤回此次导入，原来源目录不变'} · ${result.files} 个数据文件 · ${result.galleryFiles} 个图库文件`
        el('decision').textContent = canRestore ? '备份完整，现有数据与迁移完成时一致，可以回退。执行前仍会再次核对。' : message(result.reason)
        el('status').textContent = '检查完成。'; el('review').scrollIntoView({ block: 'center', behavior: 'smooth' })
      } else {
        window.migrationWizard.refreshAfterRestore()
        resetReview(); el('list').replaceChildren(); el('status').textContent = '回退完成，原数据与备份已保留。可刷新列表查看。'
      }
    } catch (error) { resetReview(); el('status').textContent = '检查未完成。'; el('error').textContent = message(error) }
    finally { busy = false; controls() }
  }
  el('refresh').onclick = () => perform({ operation: 'history' })
  el('stopped').onchange = controls
  el('restore').onclick = () => {
    if (canRestore && el('stopped').checked) perform({ operation: 'backup_restore', sourceStopped: true })
  }
  window.backupBrowser = { update(state) {
    allowed = ['setup', 'maintenance', 'migration_complete'].includes(state.phase) || (state.phase === 'failed' && ['DATA_MIGRATION_REQUIRED', 'DATA_MIGRATION_PENDING'].includes(state.code))
    el('panel').hidden = !allowed
    document.body.classList.toggle('backup-mode', state.phase === 'maintenance')
    if (!allowed) resetReview()
    if (state.phase === 'maintenance' && previousPhase !== state.phase) perform({ operation: 'history' })
    previousPhase = state.phase; controls()
  } }
})()
