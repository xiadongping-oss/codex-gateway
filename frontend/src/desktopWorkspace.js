export const isDesktopWorkspace = () => typeof window !== 'undefined' && window.__CGW_DESKTOP__ === true
export function openDesktopWorkspace(page) {
  if (!isDesktopWorkspace() || !['service', 'data', 'desktop'].includes(page)) return false
  window.location.href = `cgw-workspace://open/${page}`
  return true
}
