// Present one actionable status without exposing upstream response bodies.
export function connectionStatus({ mode, running, health, loggedIn, hasApiKey }) {
  if (mode === 'openai') return { tone: 'neutral', title: hasApiKey ? 'API Key 已配置' : '尚未配置 API Key', description: hasApiKey ? '可通过客户端调用验证连接。' : '添加账号以配置供应商与密钥。' }
  if (mode !== 'bridge') return null
  const detail = JSON.stringify(health?.data?.error || health?.error || '')
  if (/unsupported_country_region_territory|region_territory/i.test(detail)) return { tone: 'error', title: '账号已导入，网络连接受限', description: '上游拒绝了当前网络出口（HTTP 403）。请检查出网代理后重新检测连接。', action: 'settings' }
  if (!loggedIn) return { tone: 'neutral', title: '尚未配置账号', description: '添加账号并完成授权后即可使用。' }
  if (!running) return { tone: 'neutral', title: '账号已就绪，模型代理未启动', description: '可在概览中启动模型代理。' }
  if (/invalid_grant|invalid_refresh_token|token_expired|revoked|HTTP 401/i.test(detail)) return { tone: 'error', title: '账号授权需要更新', description: '刷新令牌已失效（HTTP 401）。请重新授权此账号，再检测连接。', action: 'reauth' }
  if (health?.ok !== true) return { tone: 'error', title: '模型代理暂时无法连接', description: '账号凭据已保存。请检查网络与出网代理后重试。', action: 'settings' }
  return { tone: 'success', title: '连接正常', description: '' }
}
