(() => {
  if (window.top !== window || location.origin !== /*__CGW_ORIGIN__*/null) return;
  const state = { authenticated: false, mounted: false, cleanUrl: false, lost: false };
  Object.defineProperty(window, '__cgwDesktopSession', { value: state });
  async function check() {
    // The initial response is a redirect; only the clean root can become visible.
    state.cleanUrl = !location.search.includes('_cgw_bootstrap');
    state.mounted = !!document.querySelector('#app')?.children.length;
    try {
      const r = await fetch('/__gw/admin/session', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
      const body = r.ok ? await r.json() : null;
      const valid = body?.authenticated === true && body?.via === 'session';
      if (state.authenticated && !valid) state.lost = true;
      state.authenticated = valid;
    } catch { if (state.authenticated) state.lost = true; }
    setTimeout(check, 1500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check, { once: true }); else check();
  // Normalize anchors to the navigation callback. This also covers WebView2 builds
  // that fail to report target=_blank clicks through the new-window callback.
  document.addEventListener('click', event => {
    const link = event.target.closest?.('a[href]');
    if (!link || link.hasAttribute('download') || !event.isTrusted) return;
    if (link.target === '_blank' || new URL(link.href, location.href).origin !== location.origin) {
      event.preventDefault(); location.assign(link.href);
    }
  }, true);
})();
