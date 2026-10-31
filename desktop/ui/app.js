const $ = id => document.getElementById(id)
const invoke = window.__TAURI__.core.invoke
let busy = false
async function action(name) {
  if (busy) return
  busy = true; $('action-error').textContent = ''
  try { await invoke('gateway_action', { action: name }) }
  catch { $('action-error').textContent = '操作未完成，请稍后重试。' }
  finally { busy = false }
}
$('reopen').onclick = () => action('reopen')
$('retry').onclick = () => action('retry')
$('quit').onclick = () => action('quit')
$('continue').onclick = () => action('continue')
$('force').onclick = () => action('force')
$('restart').onclick = () => action('restart')
$('logs').onclick = () => action('logs')
$('fresh-start').onclick = () => action('fresh-start')
$('maintenance').onclick = () => action('maintenance')
async function refresh() {
  try {
    const s = await invoke('gateway_status')
    $('title').textContent = s.title; $('message').textContent = s.message
    $('badge').textContent = s.badge; $('badge').className = `badge ${s.phase}`
    $('address').textContent = s.port ? `127.0.0.1:${s.port}` : '等待连接'
    $('tasks').textContent = s.active + s.background ? `${s.active + s.background} 项进行中` : '暂无任务'
    const migration = ['DATA_MIGRATION_REQUIRED', 'DATA_MIGRATION_PENDING'].includes(s.code)
    $('retry').hidden = !(['maintenance', 'migration_complete'].includes(s.phase) || (s.phase === 'failed' && !migration))
    $('retry').textContent = s.phase === 'migration_complete' ? '启动网关' : '重新启动'
    $('fresh-start').hidden = s.phase !== 'setup'
    window.migrationWizard.update(s)
    window.backupBrowser.update(s)
    $('maintenance').hidden = s.phase !== 'ready'
    $('restart').hidden = s.phase !== 'unresponsive'
    $('reopen').hidden = s.phase !== 'ready'
    $('continue').hidden = $('force').hidden = !s.waiting
    $('quit').disabled = s.phase === 'stopping'
    $('desktop-notice').textContent = await invoke('desktop_notice')
    await invoke('ui_rendered')
  } catch { $('action-error').textContent = '暂时无法获取状态，请稍候。' }
  setTimeout(refresh, 500)
}
refresh()
