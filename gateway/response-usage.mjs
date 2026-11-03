// Parse only observed upstream usage; never estimate missing token counts.
export function extractUsage(text) {
  if (!text) return null
  const objects = []
  try { objects.push(JSON.parse(text)) } catch {}
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    try { objects.push(JSON.parse(line.slice(5).trim())) } catch {}
  }
  for (const obj of objects.reverse()) {
    const raw = obj?.usage || obj?.response?.usage
    if (!raw) continue
    const promptTokens = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0)
    const completionTokens = Number(raw.completion_tokens ?? raw.output_tokens ?? 0)
    const totalTokens = Number(raw.total_tokens ?? promptTokens + completionTokens)
    if (![promptTokens,completionTokens,totalTokens].every(n => Number.isFinite(n) && n >= 0)) continue
    return {promptTokens,completionTokens,totalTokens}
  }
  return null
}
