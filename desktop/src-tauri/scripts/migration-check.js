// Injected only in the explicit isolated migration smoke scenario.
//
// 这段脚本按界面上的真实控件驱动，所以迁移向导改版时必须同步改这里：
// 向导现在先自动扫描旧数据、再分步走「找到旧数据 → 处理图片 → 核对并迁移 → 完成」，
// 不再有一次性填完的表单。下面的每一步都对应界面上真实存在的元素。
//
// 改版后的操作逻辑里，旧数据不再堵住启动：发现旧数据会自动尝试接管，接管不了的
// 只在「数据与备份」里提示，应用照常可用。所以这里先断言「已经 ready」，再停下来
// 做迁移 —— 这正好是那次改版最需要被钉住的回归。
(async () => {
  const $ = id => document.getElementById(id)
  const view = name => document.querySelector(`[data-view="${name}"]`)
  const invoke = (command, args) => window.__TAURI__.core.invoke(command, args)
  const wait = async predicate => {
    const until = Date.now() + 45000
    while (Date.now() < until) { if (await predicate()) return; await new Promise(r => setTimeout(r, 100)) }
    throw new Error('check deadline')
  }
  const set = (id, value) => { $(id).value = value; $(id).dispatchEvent(new Event('input', { bubbles: true })); $(id).dispatchEvent(new Event('change', { bubbles: true })) }
  // 手动指定目录：填好路径后点「使用这个目录」，它就成为当前选中的候选。
  // auth 是旧配置里指向目录外的凭据文件，必须在这一步重新指定，否则核对通不过。
  const choose = (source, gallery, auth) => {
    $('migration-manual').open = true
    set('migration-source', source)
    set('migration-gallery', gallery || '')
    set('migration-auth-map', auth || '')
    $('migration-manual-use').click()
  }
  const next = () => $('migration-main').click()
  const confirm = () => { $('migration-stopped').checked = true; $('migration-stopped').dispatchEvent(new Event('change')) }
  // 核对这一步要等「计划真的算出来了」再往下走。只看摘要有没有字是不够的：
  // 「正在核对…」那行也算有字，此时点迁移会因为没有指纹而被静默拒绝。
  const planned = () => !view('review').hidden && view('review').dataset.planning === 'false' && $('migration-summary-list').textContent.length > 0
  const panelReady = () => $('migration-panel') && !$('migration-panel').hidden
  const check = condition => { if (!condition) throw new Error('check failed') }
  const viewsReady = () => Boolean($('migration-views')) && !$('migration-views').hidden
  // 迁移要重写整个数据根目录，所以必须先停掉本机服务：卡片上「停止服务并继续」
  // 就是这个用途。网关运行时后端连 context 都会拒绝，也就谈不上核对。
  const stopService = async () => {
    await wait(() => Boolean($('migration-stop-service')) && !$('migration-stop-service').hidden)
    $('migration-stop-service').click()
    await wait(async () => (await invoke('gateway_status')).phase === 'maintenance')
    await wait(() => viewsReady() && view('loading').hidden)
  }
  const fixture = window.__migrationFixture
  let stage = 0
  const enter = value => { stage = value; window.__migrationStage = value }
  try {
    if (fixture.fresh) {
      // 没有旧数据时：应用必须照常可用，而且不许再拿迁移拦人。
      await wait(async () => (await invoke('gateway_status')).phase === 'ready')
      check(!panelReady())
      window.__migrationCheck = 'passed'
      return
    }
    // 先等概览页把原生控制台检查做完：脚本一会把页面切到「数据与备份」，
    // 概览一旦卸载，那些检查就没有第二次机会了（冒烟会在收尾时报 D02 全 false）。
    await wait(async () => (await invoke('gateway_status')).phase === 'ready')
    await wait(async () => (await invoke('workspace_state')).page === 'overview')
    await new Promise(r => setTimeout(r, 8000))
    document.querySelector('.nav-item[data-page="data"]').click()
    await wait(() => panelReady() && !viewsReady())
    enter(2)
    await stopService()
    // 新版里网关已经先跑起来过，工作空间里已经有了它自己的启动文件。
    // 迁移必须在这种状态下仍然可行，否则「既要应用可用、又要能补迁旧数据」是句空话。
    check((await invoke('migration_request', { request: { operation: 'context' } })).targetExists)
    enter(3)
    // 相对路径必须被拒，而且不能进入核对步骤。
    choose('relative-invalid')
    next()
    await wait(() => $('migration-error').textContent.includes('绝对路径'))
    check(view('review').hidden)
    enter(4)
    choose(fixture.source, fixture.gallery, fixture.auth)
    next()
    await wait(() => !view('gallery').hidden)
    check($('migration-gallery-lede').textContent.length > 0)
    enter(5)
    next()
    await wait(planned)
    check($('migration-main').disabled)
    // 改了任何输入都应该让已核对的计划失效，重新走一遍核对。
    $('migration-back').click()
    await wait(() => !view('gallery').hidden)
    next()
    await wait(planned)
    enter(6)
    confirm(); next()
    await wait(async () => (await invoke('gateway_status')).phase === 'migration_complete')
    await wait(() => !view('result').hidden && !$('migration-stopped').disabled)
    check($('migration-archive').textContent.includes('.migration-committed-'))
    enter(7)
    await wait(() => !$('backup-refresh').disabled)
    $('backup-refresh').click()
    await wait(() => $('backup-list').querySelector('button') && !$('backup-list').querySelector('button').disabled)
    $('backup-list').querySelector('button').click()
    await wait(() => !$('backup-review').hidden && !$('backup-stopped').disabled)
    check($('backup-restore').disabled)
    $('backup-stopped').checked = true; $('backup-stopped').dispatchEvent(new Event('change'))
    $('backup-restore').click()
    // 回退把工作空间交还给迁移前的状态：向导回到选择旧数据那一步。
    await wait(() => !view('source').hidden)
    enter(8)
    choose(fixture.source, fixture.gallery, fixture.auth)
    next(); next()
    await wait(planned)
    confirm(); next()
    await wait(async () => (await invoke('gateway_status')).phase === 'migration_complete')
    await wait(() => !$('retry').hidden)
    enter(9)
    $('retry').click()
    await wait(async () => (await invoke('gateway_status')).phase === 'ready')
    let refused = false
    try { await invoke('migration_request', { request: { operation: 'context' } }) }
    catch (error) { refused = error === 'MIGRATION_GATEWAY_ACTIVE' }
    check(refused)
    enter(10)
    await stopService()
    // 这里必须显式点刷新：面板只在「看到进入维护模式那一刻」自动加载，而上面的
    // 迁移 / 回退 / 重启几十毫秒就跑完了，轮询很可能一次都没落在中间阶段上。
    await wait(() => !$('backup-refresh').disabled)
    $('backup-refresh').click()
    await wait(() => $('backup-list').querySelector('button') && !$('backup-list').querySelector('button').disabled)
    $('backup-list').querySelector('button').click()
    await wait(() => !$('backup-review').hidden && $('backup-decision').textContent.includes('发生变化'))
    check($('backup-restore').disabled)
    enter(11)
    $('retry').click()
    await wait(async () => (await invoke('gateway_status')).phase === 'ready')
    window.__migrationCheck = 'passed'
  } catch (error) {
    // 只报步骤编号的话，冒烟失败时只能知道「卡在第 0 步」。带上原因才查得动：
    // 原生窗口里看不到 DOM，所以把当时界面上的提示和主按钮状态一起带回来。
    const reason = String(error && (error.message || error) || 'unknown').replace(/[\r\n|]/g, ' ').slice(0, 160)
    const at = id => { const node = $(id); return node ? (node.textContent || '').replace(/[\r\n|]/g, ' ').trim().slice(0, 120) : '?' }
    const button = $('migration-main')
    const context = [
      'code=' + (($('migration-panel') || {}).dataset ? $('migration-panel').dataset.lastError || '-' : '-'),
      'err=' + at('migration-error'),
      'hint=' + at('migration-hint'),
      'view=' + (['loading', 'source', 'gallery', 'review', 'running', 'result', 'recovery'].find(name => view(name) && !view(name).hidden) || '?'),
      'main=' + (button ? (button.hidden ? 'hidden' : String(button.textContent) + '/' + (button.disabled ? 'disabled' : 'enabled')) : '?')
    ].join(' ')
    window.__migrationCheck = 'failed:' + stage + '|' + reason + ' ' + context
  }
})()
