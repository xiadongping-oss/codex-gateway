import crypto from 'node:crypto'

export function createDesktopTickets(launchId, now = Date.now) {
  const secret = crypto.randomBytes(32)
  let outstanding = null
  const sign = text => crypto.createHmac('sha256', secret).update(text).digest('hex')
  return {
    issue() {
      const expiresAt = now() + 60_000
      const text = `d1.${launchId}.${crypto.randomBytes(32).toString('hex')}.${expiresAt}`
      outstanding = `${text}.${sign(text)}`
      return { ticket: outstanding, expiresAt }
    },
    consume(ticket) {
      if (typeof ticket !== 'string' || ticket !== outstanding) return { ok: false }
      const parts = ticket.split('.')
      if (parts.length !== 5 || parts[1] !== launchId || now() >= Number(parts[3])) return { ok: false }
      const mac = sign(parts.slice(0, 4).join('.'))
      if (!/^[a-f0-9]{64}$/.test(parts[4]) || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(parts[4]))) return { ok: false }
      outstanding = null // Consume synchronously, before issuing the session cookie.
      return { ok: true }
    },
    invalidate() { outstanding = null }
  }
}
