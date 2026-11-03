import fs from 'node:fs'
import path from 'node:path'
export const IMAGE_ADAPTER_REVISION = '2026-11-03-edit-1'
const MAX_AGE = 30 * 24 * 3600 * 1000
export function readImageVerification(cacheDir, accountId, model, now = Date.now()) {
  try {
    const file = path.join(cacheDir, 'image-verification.json')
    if (fs.statSync(file).size > 64 * 1024) return null
    const report = JSON.parse(fs.readFileSync(file, 'utf8'))
    const at = Date.parse(report.checkedAt)
    if (report.schemaVersion !== 1 || report.adapterRevision !== IMAGE_ADAPTER_REVISION || !accountId || report.accountId !== accountId || report.model !== model || !Number.isFinite(at) || now - at > MAX_AGE || at > now + 60000) return null
    const features = {}
    for (const id of ['transparent', 'mask', 'outpaint', 'format', 'compression', 'size', 'quality', 'fidelity', 'identity', 'advanced', 'batch']) {
      const feature = report.features?.[id]
      const checkedAt = feature?.checkedAt || report.checkedAt
      const featureAt = Date.parse(checkedAt)
      if (feature && ['passed', 'limited', 'failed', 'unsupported'].includes(feature.status) && typeof feature.detail === 'string' && Number.isFinite(featureAt) && now - featureAt <= MAX_AGE && featureAt <= now + 60000) features[id] = { status: feature.status, detail: feature.detail.slice(0, 600), checkedAt }
    }
    return { checkedAt: report.checkedAt, model, features }
  } catch { return null }
}
