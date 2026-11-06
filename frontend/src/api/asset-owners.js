// 后台「图片素材」按生成时所用 API Key 区分来源用户。
// 归属来自 generated/index.json 的 keyId/keyName（落盘当时的快照），
// 因此 Key 被改名或删除后，历史图片仍可按原 keyId 筛选。
export const NO_OWNER = '__none__'

export function buildOwnerOptions(images) {
  const map = new Map()
  for (const img of images || []) {
    const id = img?.ownerKeyId || NO_OWNER
    if (!map.has(id)) map.set(id, {
      id,
      label: id === NO_OWNER ? '无归属（旧图）' : (img?.ownerKeyName || '已删除的 Key') + ' · ' + id.slice(-8),
      count: 0
    })
    map.get(id).count++
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN'))
}

export function matchesOwner(img, filter) {
  if (!filter) return true
  return (img?.ownerKeyId || NO_OWNER) === filter
}
