// Injected only in the explicit isolated migration smoke scenario.
(async () => {
  const $ = id => document.getElementById(id)
  const invoke = (command, args) => window.__TAURI__.core.invoke(command, args)
  const wait = async predicate => {
    const until = Date.now() + 45000
    while (Date.now() < until) { if (await predicate()) return; await new Promise(r => setTimeout(r, 100)) }
    throw new Error('check deadline')
  }
  const set = (id, value) => { $(id).value = value; $(id).dispatchEvent(new Event('input', { bubbles: true })); $(id).dispatchEvent(new Event('change', { bubbles: true })) }
  const confirm = () => { $('migration-stopped').checked = true; $('migration-stopped').dispatchEvent(new Event('change')) }
  const check = condition => { if (!condition) throw new Error('check failed') }
  let stage = 0
  try {
    await wait(() => $('migration-panel') && !$('migration-panel').hidden && $('migration-target').textContent !== '正在读取…')
    check((await invoke('gateway_status')).phase === 'setup')
    check(!(await invoke('migration_request', { request: { operation: 'context' } })).targetExists)
    if (window.__migrationFixture.fresh) {
      $('fresh-start').click()
      await wait(async () => (await invoke('gateway_status')).phase === 'ready')
      window.__migrationCheck = 'passed'
      return
    }
    stage = 1
    set('migration-source', 'relative-invalid')
    set('migration-gallery-choice', 'skip')
    $('migration-plan').click()
    await wait(() => $('migration-error').textContent.includes('绝对路径'))
    check($('migration-review').hidden)
    stage = 2
    set('migration-source', window.__migrationFixture.source)
    set('migration-gallery-choice', 'import')
    set('migration-gallery', window.__migrationFixture.gallery)
    const plan = async () => { await wait(() => !$('migration-plan').disabled); $('migration-plan').click(); await wait(() => !$('migration-review').hidden); check($('migration-apply').disabled) }
    await plan()
    stage = 3
    set('migration-source', window.__migrationFixture.source)
    check($('migration-review').hidden)
    await plan()
    stage = 4
    confirm(); $('migration-apply').click()
    await wait(async () => (await invoke('gateway_status')).phase === 'migration_complete')
    await wait(() => !$('migration-rollback').hidden && !$('migration-stopped').disabled)
    check($('migration-archive').textContent.includes('.migration-committed-'))
    check($('migration-rollback').disabled)
    stage = 5
    confirm(); $('migration-rollback').click()
    await wait(async () => (await invoke('gateway_status')).phase === 'setup')
    await wait(() => !$('migration-form').hidden && !$('migration-plan').disabled)
    check(!(await invoke('migration_request', { request: { operation: 'context' } })).targetExists)
    stage = 6
    await plan(); confirm(); $('migration-apply').click()
    await wait(async () => (await invoke('gateway_status')).phase === 'migration_complete')
    await wait(() => !$('retry').hidden)
    stage = 7
    $('retry').click()
    await wait(async () => (await invoke('gateway_status')).phase === 'ready')
    let refused = false
    try { await invoke('migration_request', { request: { operation: 'context' } }) }
    catch (error) { refused = error === 'MIGRATION_GATEWAY_ACTIVE' }
    check(refused)
    window.__migrationCheck = 'passed'
  } catch { window.__migrationCheck = 'failed:' + stage }
})()
