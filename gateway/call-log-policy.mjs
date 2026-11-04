// Control-plane polling is diagnostic traffic, never a model invocation.
export const isManagementLog = entry => /^\/__gw(?:\/|$)/.test(entry.endpoint || '')
export const callLogKind = entry => isManagementLog(entry) ? 'management' : 'business'

export function aggregateManagement(logs, entry) {
  const previous = logs.find(item => item.endpoint === entry.endpoint && item.status === entry.status &&
    item.method === entry.method && item.caller?.ip === entry.caller?.ip &&
    item.caller?.source === entry.caller?.source && item.at <= entry.at && entry.at - item.at < 60000)
  if (!previous) { logs.unshift({...entry,count:entry.count || 1,firstAt:entry.firstAt || entry.at}); return }
  previous.at = entry.at
  previous.count = (previous.count || 1) + (entry.count || 1)
  logs.splice(logs.indexOf(previous),1)
  logs.unshift(previous)
}
