// Only injected for explicitly isolated native checks. No accounts or upstream calls.
(async () => {
  const s = window.__cgwDesktopSession;
  if (!s || s.probed) return;
  s.probed = true;
  s.cookieHidden = !document.cookie.includes('cgw_session');
  s.historyClean = !location.href.includes('_cgw_bootstrap') && !document.referrer.includes('_cgw_bootstrap');
  try { await window.__TAURI__.core.invoke('gateway_status'); s.nativeDenied = false; }
  catch { s.nativeDenied = true; }
  try { await window.__TAURI__.core.invoke('migration_request', { request: { operation: 'context' } }); s.nativeDenied = false; }
  catch { /* Both native management entry points must remain inaccessible. */ }
  s.workspaceDenied = true;
  for (const [command, args] of [
    ['workspace_state', {}],
    ['workspace_navigate', { page: 'service' }],
    ['workspace_autostart', { enabled: false }]
  ]) {
    try { await window.__TAURI__.core.invoke(command, args); s.workspaceDenied = false; }
    catch { /* Navigation is a fixed native callback, never an IPC grant. */ }
  }
  try { await window.__TAURI__.core.invoke('plugin:window|is_visible', { label: null }); s.coreDenied = false; }
  catch { s.coreDenied = true; }
  const before = location.origin;
  window.open('https://example.com/cgw-desktop-test', '_blank');
  location.assign('https://example.com/cgw-desktop-navigation');
  setTimeout(() => { s.navigationSafe = location.origin === before; }, 500);
})();
