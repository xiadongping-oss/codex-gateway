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
  return '未返回'
}
