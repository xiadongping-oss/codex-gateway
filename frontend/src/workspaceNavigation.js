export const overviewPages = [
  { key: 'overview', label: '使用概况' },
  { key: 'runtime', label: '实例与自动切换' }
]

export const accessPages = [
  { key: 'access', label: '配置客户端' },
  { key: 'models', label: '模型目录' },
  { key: 'apikeys', label: 'API Key' },
  { key: 'settings', label: '出网代理' }
]

export function workspaceSection(page) {
  if (overviewPages.some(item => item.key === page)) return 'overview'
  if (accessPages.some(item => item.key === page)) return 'access'
  if (['desktop', 'service', 'data', 'about'].includes(page)) return 'desktop'
  return page
}
