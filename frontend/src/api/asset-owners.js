// 本机按请求来源分组，局域网按生成时的 Key 分组。旧图保留可确认的归属。
export const LOCAL_OWNER = '__local__'
export const NO_OWNER = '__none__'

function ownerGroup(img) {
  if (img?.ownerSource === 'local') return LOCAL_OWNER
  return img?.ownerKeyId || NO_OWNER
}

export function buildOwnerOptions(images) {
  const local = { id: LOCAL_OWNER, label: '本机', count: 0 }
  const map = new Map([[LOCAL_OWNER, local]])
  for (const img of images || []) {
    const id = ownerGroup(img)
    if (!map.has(id)) map.set(id, {
      id,
      label: id === NO_OWNER ? '无归属（旧图）' : (img?.ownerKeyName || '已删除的 Key') + ' · ' + id.slice(-8),
      count: 0
    })
    map.get(id).count++
  }
  map.delete(LOCAL_OWNER)
  const byCount = [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN'))
  return [local, ...byCount]
}

export function matchesOwner(img, filter) {
  return !filter || ownerGroup(img) === filter
}
