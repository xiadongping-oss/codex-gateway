(() => {
  const $=id=>document.getElementById(id)
  const invoke=window.__TAURI__.core.invoke
  const busyPhases=['checking','downloading','waiting','installing']
  let pending=false, latest=null
  const messages={idle:'可检查 GitHub 发布的新版本。',checking:'正在检查更新…',available:'有新版本可用，下载时可以继续使用。',current:'当前已是最新发布版本。',downloading:'正在下载并校验更新签名…',downloaded:'下载完成，签名已验证。准备好后可安装并重启。',waiting:'正在等待任务结束并保存数据，请保持应用打开…',installing:'正在启动安装器，完成后会重新打开应用…'}
  const bytes=n=>n>=1048576?(n/1048576).toFixed(1)+' MB':Math.ceil(n/1024)+' KB'
  function update(value) {
    if(!value)return
    latest=value
    const busy=pending || busyPhases.includes(value.phase)
    $('updater-panel').setAttribute('aria-busy',String(busy))
    $('updater-current').textContent='当前版本 '+value.currentVersion+(value.version?' · 新版本 '+value.version:'')
    $('updater-badge').textContent=value.version?'v'+value.version:'在线更新'
    let message=messages[value.phase] || value.error || '更新状态暂不可用，请重新检查。'
    if(value.phase==='error')message=value.error || '更新失败，请重试。'
    if(value.phase==='downloading')message+=' '+bytes(value.downloaded || 0)+(value.total?' / '+bytes(value.total):'')
    $('updater-status').textContent=message
    $('updater-status').classList.toggle('update-error',value.phase==='error')
    $('updater-check').disabled=busy
    $('updater-download').hidden=value.readyToInstall || !value.version || ['downloaded','waiting','installing'].includes(value.phase)
    $('updater-download').disabled=busy
    $('updater-install').hidden=!value.readyToInstall && !['downloaded','waiting','installing'].includes(value.phase)
    $('updater-install').disabled=busy
    $('updater-progress').hidden=value.phase!=='downloading'
    if(value.total)$('updater-progress').value=Math.min(100,100*value.downloaded/value.total)
    else $('updater-progress').removeAttribute('value')
    $('updater-notes').textContent=value.notes || ''
    $('updater-notes').hidden=!value.notes
  }
  async function act(action) {
    if(pending && action!=='release')return
    if(action==='release') {
      try {await invoke('workspace_update',{action})} catch {$('updater-status').textContent='浏览器未能打开，请稍后重试。'}
      return
    }
    pending=true
    if(latest)update(latest)
    try {latest=await invoke('workspace_update',{action})}
    catch(error) {if(latest)latest={...latest,phase:'error',error:typeof error==='string' && error.length<250?error:'更新操作未完成，请重试。'}}
    finally {pending=false;if(latest)update(latest)}
  }
  $('updater-check').onclick=()=>act('check')
  $('updater-download').onclick=()=>act('download')
  $('updater-install').onclick=()=>act('install')
  $('updater-release').onclick=()=>act('release')
  window.cgwUpdaterUi={update}
})()
