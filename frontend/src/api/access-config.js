const FALLBACK_MODEL = 'gpt-6.1-sol'

export function formatAccessConfig(baseUrl, apiKey, model) {
  const mdl = model || FALLBACK_MODEL
  return `OPENAI_BASE_URL=${baseUrl}\nOPENAI_API_KEY=${apiKey || '<在 API Key 页创建密钥>'}\nOPENAI_MODEL=${mdl}`
}
