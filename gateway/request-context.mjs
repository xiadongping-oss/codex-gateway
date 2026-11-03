import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

const scope = new AsyncLocalStorage()
const transfers = new Map()
const local = ip => ['127.0.0.1','::1'].includes(String(ip || '').replace(/^::ffff:/,''))
export function requestCaller(req, verifiedKey) {
  const ip = String(req.socket?.remoteAddress || '').replace(/^::ffff:/,'').slice(0,64)
  let device = String(req.headers?.['x-cgw-device-name'] || '')
  try { device = decodeURIComponent(device) } catch { device = '' }
  device = device.replace(/[\p{C}]/gu,'').trim().slice(0,80)
  return { ip, device, deviceSelfReported: !!device, keyId: verifiedKey?.keyId || null,
    keyName: verifiedKey?.name || null, source: req.desktopLan || !local(ip) ? 'lan' : 'local' }
}
export const currentCaller = () => scope.getStore() || null
export const withCaller = (caller, operation) => scope.run(caller, operation)

// Carry the real MCP peer through an internal image API request. Single-use,
// expiring, server-generated and bound to the verified Key; never trust XFF.
export function issueCallerTransfer() {
  const now = Date.now()
  for (const [id, item] of transfers) if (item.expires < now) transfers.delete(id)
  if (transfers.size >= 1024 || !currentCaller()) return null
  const id = randomUUID()
  transfers.set(id,{caller:{...currentCaller()},expires:now+30000})
  return id
}
export function consumeCallerTransfer(req, caller) {
  const id = req.headers?.['x-cgw-internal-call']
  if (!id || req.desktopLan || !local(req.socket?.remoteAddress) || req.method !== 'POST' || !/^\/v1\/images\/(generations|edits)(?:\?|$)/.test(req.url || '')) return caller
  const item = transfers.get(id)
  if (!item || item.expires < Date.now() || item.caller.keyId !== caller.keyId) return caller
  transfers.delete(id)
  return item.caller
}
