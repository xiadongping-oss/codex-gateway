export function callTokenCount(entry) {
  const usage = entry.usage
  const count = usage?.totalTokens ?? entry.tokens ??
    (usage && usage.promptTokens != null && usage.completionTokens != null ? usage.promptTokens + usage.completionTokens : null)
  return typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : null
}

export function callTokenText(entry) {
  const count = callTokenCount(entry)
  if (count !== null) return count.toLocaleString()
  if (entry.method === 'GET' || entry.status >= 400) return '—'
  // 老记录没有这两个字段，保持原来的「未返回」；新记录把原因说清楚，
  // 避免把「客户端掐断」和「上游没给 usage」混为一谈。
  if (entry.streamEnd === 'interrupted') return '流中断'
  if (entry.usageState === 'no-usage') return '上游未返回'
  return '未返回'
}
