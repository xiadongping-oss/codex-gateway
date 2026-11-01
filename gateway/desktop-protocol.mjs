// No business imports: safe to load before initialize/start.
const MAX_FRAME = 64 * 1024
const MAX_QUEUE = 1024 * 1024
const fail = (code = 'FRAME_INVALID') => Object.assign(new Error(code), { code })

// JSON.parse alone silently accepts duplicate keys (including escaped spellings).
export function parseStrictJson(text) {
  const value = JSON.parse(text)
  const tokens = text.match(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) || []
  let at = 0
  function scan(depth = 0) {
    if (depth > 64) throw fail()
    const token = tokens[at++]
    if (token === '{') {
      const keys = new Set()
      while (tokens[at] !== '}') {
        const key = JSON.parse(tokens[at++])
        if (keys.has(key)) throw fail()
        keys.add(key)
        at++ // colon; syntax already validated by JSON.parse
        scan(depth + 1)
        if (tokens[at] !== ',') break
        at++
      }
      at++
    } else if (token === '[') {
      while (tokens[at] !== ']') {
        scan(depth + 1)
        if (tokens[at] !== ',') break
        at++
      }
      at++
    }
  }
  scan()
  return value
}

export function createControlChannel({ input, output, onRequest, onFault }) {
  let pending = Buffer.alloc(0)
  let inputSeq = 0
  let outputSeq = 0
  let launchId = null
  let failed = false
  function fault(error) {
    if (failed) return
    failed = true
    onFault(error.code || 'CONTROL_CHANNEL_LOST')
  }
  const fields = new Set(['protocol', 'version', 'launchId', 'seq', 'kind', 'type', 'requestId', 'payload'])
  function receive(bytes) {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    if (!text || text.startsWith('\ufeff')) throw fail()
    const msg = parseStrictJson(text)
    if (!msg || Array.isArray(msg) || typeof msg !== 'object') throw fail()
    if (msg.protocol !== 'cgw.desktop' || msg.version !== 1) throw fail('PROTOCOL_UNSUPPORTED')
    if (Object.keys(msg).some(k => !fields.has(k)) || Object.keys(msg).length !== fields.size ||
        msg.kind !== 'request' || typeof msg.type !== 'string' || !msg.type ||
        !Number.isSafeInteger(msg.seq) || msg.seq !== inputSeq + 1 || msg.requestId !== msg.seq ||
        !msg.payload || typeof msg.payload !== 'object' || Array.isArray(msg.payload)) throw fail()
    if (typeof msg.launchId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(msg.launchId) ||
        (launchId && msg.launchId !== launchId)) throw fail('IDENTITY_MISMATCH')
    launchId = msg.launchId
    inputSeq = msg.seq
    onRequest(msg)
  }
  input.on('data', chunk => {
    if (failed) return
    try {
      // Never concatenate an unbounded pipe chunk with the partial frame.
      let offset = 0
      while (offset < chunk.length && !failed) {
        const newline = chunk.indexOf(10, offset)
        const end = newline < 0 ? chunk.length : newline
        const size = pending.length + end - offset
        if (size + 1 > MAX_FRAME) throw fail()
        pending = Buffer.concat([pending, chunk.subarray(offset, end)], size)
        if (newline < 0) break
        const frame = pending
        pending = Buffer.alloc(0)
        receive(frame)
        offset = end + 1
      }
    } catch (error) { fault(['FRAME_INVALID', 'PROTOCOL_UNSUPPORTED', 'IDENTITY_MISMATCH'].includes(error.code) ? error : fail()) }
  })
  input.on('end', () => fault(fail(pending.length ? 'FRAME_INVALID' : 'CONTROL_CHANNEL_LOST')))
  input.on('error', () => fault(fail('CONTROL_CHANNEL_LOST')))
  output.on('error', () => fault(fail('CONTROL_CHANNEL_LOST')))
  function send(kind, type, payload, extra = {}) {
    if (!launchId || output.destroyed) return false
    const frame = JSON.stringify({ protocol: 'cgw.desktop', version: 1, launchId,
      seq: outputSeq + 1, kind, type, ...extra, payload }) + '\n'
    const size = Buffer.byteLength(frame)
    if (size > MAX_FRAME || output.writableLength + size > MAX_QUEUE) {
      fault(fail('CONTROL_CHANNEL_LOST'))
      return false
    }
    outputSeq++
    output.write(frame)
    return true
  }
  return {
    get launchId() { return launchId },
    event(type, payload) { return send('event', type, payload) },
    respond(msg, payload, error) {
      return send('response', msg.type, payload, { requestId: msg.requestId, ok: !error, ...(error ? { error } : {}) })
    },
    flush() {
      return new Promise(resolve => {
        if (output.destroyed) return resolve(false)
        const timer = setTimeout(() => resolve(false), 1000)
        output.write('', error => { clearTimeout(timer); resolve(!error) })
      })
    }
  }
}
