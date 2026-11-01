const $ = id => document.getElementById(id)
const invoke = window.__TAURI__.core.invoke
window.applyWorkspaceTheme = value => {
  const theme = value === 'dark' ? 'dark' : 'light'
  document.documentElement.dataset.theme = theme
  $('desktop-theme-label').textContent = theme === 'dark' ? '深色' : '浅色'
  try { localStorage.setItem('gw.theme',theme) } catch { /* Theme still applies when storage is unavailable. */ }
}
let savedTheme = 'light'
try { savedTheme = localStorage.getItem('gw.theme') || 'light' } catch { /* Use the workspace default. */ }
window.applyWorkspaceTheme(savedTheme)
window.applyWorkspaceCollapsed = collapsed => {
  document.querySelector('.sidebar').classList.toggle('collapsed', collapsed === true)
  try { localStorage.setItem('gw.sidebar.collapsed', collapsed === true ? '1' : '0') } catch { /* Apply the layout even without storage. */ }
}
let savedCollapsed = false
try { savedCollapsed = localStorage.getItem('gw.sidebar.collapsed') === '1' } catch { /* Use the expanded default. */ }
window.applyWorkspaceCollapsed(savedCollapsed)
const icons = {
  overview:'M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z',
  account:'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a7 7 0 0 1 14 0v2M19 4h3m-1.5-1.5v3',
  images:'M3 4h18v16H3zM3 15l5-5 5 5 3-3 5 5M15 8h.01',
  models:'m12 2 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 17l9 5 9-5',
  apikeys:'M14 9a5 5 0 1 1-3-4M11 10 3 18v3h3v-3h3v-3l3-3M17 5h.01',
  logs:'M5 3h14v18H5zM8 7h8M8 11h5M8 15h8M8 18h4',
  service:'M3 5h18v5H3zM3 14h18v5H3zM6 7.5h.01M6 16.5h.01M15 7.5h3M15 16.5h3',
  data:'M20 6c0 2-16 2-16 0s16-2 16 0ZM4 6v12c0 3 16 3 16 0V6M4 12c0 3 16 3 16 0',
  settings:'M4 7h16M4 17h16M9 4v6M15 14v6'
}
for (const holder of document.querySelectorAll('[data-icon]')) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  for (const [key, value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'})) svg.setAttribute(key,value)
  const shape = document.createElementNS('http://www.w3.org/2000/svg','path')
  shape.setAttribute('d',icons[holder.dataset.icon] || icons.overview); svg.append(shape); holder.append(svg)
}
let busy = false, autostartBusy = false, autostartAvailable = false, pendingConfirmation
const errorMessage = error => typeof error === 'string' && error.length < 180 ? error : '操作未完成，请稍后重试。'
// 启动、停止、退出这类操作要几百毫秒到几秒才有回音。不把按钮锁住，用户唯一能看到
// 的反馈就是「点了没反应」，于是再点一次——所以这是必要的交互，不是装饰。
const ACTION_IDS = ['reopen','retry','quit','continue','force','restart','logs','fresh-start','maintenance','service-stop']
function setActionsBusy(value) {
  for (const id of ACTION_IDS) $(id).disabled = value
  $('service-card').setAttribute('aria-busy', value ? 'true' : 'false')
}
async function action(name) {
  if (busy) return
  busy = true; $('action-error').textContent = ''; setActionsBusy(true)
  try { await invoke('gateway_action', { action:name }) }
  catch (error) { $('action-error').textContent = errorMessage(error) }
  finally { busy = false; setActionsBusy(false) }
}
async function navigate(page) {
  $('action-error').textContent = ''
  try { await invoke('workspace_navigate', { page }) }
  catch (error) { $('action-error').textContent = errorMessage(error) }
}
function showPage(page) {
  const current = ['service','data','desktop'].includes(page) ? page : 'service'
  for (const section of document.querySelectorAll('[data-local-page]')) section.hidden = section.dataset.localPage !== current
  for (const button of document.querySelectorAll('.nav-item')) {
    const selected = button.dataset.page === current
    button.classList.toggle('active',selected)
    if (selected) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current')
  }
  $('page-title').textContent = {service:'服务与诊断',data:'数据与备份',desktop:'设置'}[current]
  $('page-subtitle').textContent = {service:'管理本机服务与运行状态',data:'迁移旧数据与恢复历史备份',desktop:'连接配置与应用偏好'}[current]
}
for (const button of document.querySelectorAll('[data-page]')) button.onclick = () => navigate(button.dataset.page)
function confirmAction(name, title, message, label) {
  pendingConfirmation = name
  $('confirm-title').textContent = title; $('confirm-message').textContent = message; $('confirm-submit').textContent = label
  $('confirm-action').showModal()
}
$('confirm-cancel').onclick = () => { pendingConfirmation = undefined; $('confirm-action').close() }
$('confirm-action').onclose = () => { pendingConfirmation = undefined }
$('confirm-submit').onclick = () => { const name = pendingConfirmation; $('confirm-action').close(); if (name) action(name) }
$('reopen').onclick = () => navigate('overview')
$('retry').onclick = () => action('retry')
$('quit').onclick = () => action('quit')
$('continue').onclick = () => action('continue')
$('force').onclick = () => confirmAction('force','结束任务并退出？','进行中的任务会被中断。确认后将停止网关并退出应用。','结束并退出')
$('restart').onclick = () => confirmAction('restart','结束任务并重启？','进行中的任务会被中断。确认后将重新启动网关。','结束并重启')
$('logs').onclick = () => action('logs')
$('fresh-start').onclick = () => action('fresh-start')
$('maintenance').onclick = () => action('maintenance')
$('service-stop').onclick = () => action('stop')
$('desktop-autostart').onchange = async event => {
  if (autostartBusy) return
  autostartBusy = true; event.target.disabled = true; $('action-error').textContent = ''
  try { await invoke('workspace_autostart', { enabled:event.target.checked }) }
  catch (error) { event.target.checked = !event.target.checked; $('action-error').textContent = errorMessage(error) }
  finally { autostartBusy = false; event.target.disabled = !autostartAvailable }
}
// 状态刷新：一轮拉取 + 幂等写 DOM。
//
// 两处省下来的开销都不是微优化：
//   · 轮询节奏跟着状态走。启动/停止/迁移这种真正在变的阶段需要快，稳定阶段两秒
//     一次足够；窗口不可见时干脆不轮询，回到前台立刻补一次。
//   · 所有写入先比一次再赋值。每 500ms 给几十个节点写同样的字符串，等于持续让
//     排版引擎为没有任何变化的结果做失效与重算。
const FAST_POLL = 400
const SLOW_POLL = 2000
const CHANGING_PHASES = ['starting', 'stopping', 'migrating']
const setText = (node, value) => { if (node.textContent !== String(value)) node.textContent = value }
const setVisible = (node, visible) => { const hidden = !visible; if (node.hidden !== hidden) node.hidden = hidden }
// className 也一样要幂等：每次轮询都赋同样的字符串，样式重算照样会发生。
const setClass = (node, value) => { if (node.className !== value) node.className = value }
let announced = false

async function pollOnce() {
  const [gateway, workspace] = await Promise.allSettled([invoke('gateway_status'), invoke('workspace_state')])
  if (gateway.status === 'fulfilled') {
    const s = gateway.value
    setText($('title'), s.title); setText($('message'), s.message)
    setText($('badge'), s.badge); setClass($('badge'), `badge ${s.phase}`)
    setText($('sidebar-state'), s.phase === 'ready' ? '服务运行中' : s.phase === 'stopping' ? '正在停止' : '本机服务')
    setText($('address'), s.port ? `127.0.0.1:${s.port}` : '等待连接')
    const taskCount = Number(s.active || 0) + Number(s.background || 0)
    setText($('tasks'), taskCount ? `${taskCount} 项进行中` : '暂无任务')
    const migration = ['DATA_MIGRATION_REQUIRED', 'DATA_MIGRATION_PENDING'].includes(s.code)
    setVisible($('retry'), ['maintenance', 'migration_complete'].includes(s.phase) || (s.phase === 'failed' && !migration))
    setText($('retry'), s.phase === 'maintenance' || s.phase === 'migration_complete' ? '启动网关' : '重新启动')
    setVisible($('fresh-start'), s.phase === 'setup')
    window.backupBrowser.update(s)
    setVisible($('maintenance'), s.phase === 'ready'); setVisible($('service-stop'), s.phase === 'ready')
    setText($('data-state'), s.phase === 'ready' ? '停止服务后可检查迁移和历史备份。' : '账号、配置与图片保存在本机。')
    setVisible($('restart'), s.phase === 'unresponsive'); setVisible($('reopen'), s.phase === 'ready')
    setVisible($('continue'), Boolean(s.waiting)); setVisible($('force'), Boolean(s.waiting))
    // 停止过程中不允许退出；操作进行中也不允许，否则会和正在执行的动作打架。
    $('quit').disabled = busy || s.phase === 'stopping'
  }
  if (workspace.status === 'fulfilled') {
    showPage(workspace.value.page)
    autostartAvailable = typeof workspace.value.autostart === 'boolean'
    if (!autostartBusy && autostartAvailable && $('desktop-autostart').checked !== workspace.value.autostart) {
      $('desktop-autostart').checked = workspace.value.autostart
    }
    $('desktop-autostart').disabled = autostartBusy || !autostartAvailable
    setVisible($('autostart-status'), !autostartAvailable)
    setText($('desktop-notice'), workspace.value.notice || '')
  } else {
    autostartAvailable = false
    $('desktop-autostart').disabled = true
    setVisible($('autostart-status'), true)
    if (gateway.status === 'fulfilled') setText($('desktop-notice'), '暂时无法读取工作台状态。')
  }
  if (gateway.status === 'fulfilled') {
    // 自动迁移结果来自 workspace_state，所以要等两份状态都到位再更新向导。
    if (workspace.status === 'fulfilled') window.migrationWizard.update(gateway.value, workspace.value.migration)
  }
  if (gateway.status === 'rejected') setText($('desktop-notice'), '暂时无法获取服务状态，请稍候。')
  // ui_rendered 只是把「界面已经起来」告诉原生端，发一次就够了，不必每轮都打 IPC。
  if (!announced && gateway.status === 'fulfilled') {
    announced = true
    try { await invoke('ui_rendered') } catch { /* Status refresh surfaces a disconnected native channel. */ }
  }
  if (gateway.status !== 'fulfilled') return FAST_POLL
  return CHANGING_PHASES.includes(gateway.value.phase) ? FAST_POLL : SLOW_POLL
}

let timer = null
function schedule(delay) {
  if (timer) return
  // 窗口看不见时完全不轮询：托盘里跑着的窗口不该持续唤起排版与 IPC。
  if (document.hidden) return
  timer = setTimeout(() => { timer = null; pollOnce().then(schedule) }, delay)
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && !timer) pollOnce().then(schedule) })
pollOnce().then(schedule)