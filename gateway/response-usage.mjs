import { Transform } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { createGunzip, createBrotliDecompress, createInflate } from 'node:zlib'

function normalizeUsage(raw) {
  const fields = ['prompt_tokens', 'input_tokens', 'completion_tokens', 'output_tokens', 'total_tokens']
  if (raw && fields.some(key => raw[key] != null && (typeof raw[key] === 'boolean' || (typeof raw[key] === 'string' && !raw[key].trim())))) return null
  if (!raw || !fields.some(key => raw[key] != null)) return null
  const promptTokens = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0)
  const completionTokens = Number(raw.completion_tokens ?? raw.output_tokens ?? 0)
  const totalTokens = Number(raw.total_tokens ?? promptTokens + completionTokens)
  if (![promptTokens, completionTokens, totalTokens].every(n => Number.isFinite(n) && n >= 0)) return null
  return { promptTokens, completionTokens, totalTokens }
}

// Read structural usage objects without retaining response text or image payloads.
// The same scanner accepts a JSON document or the JSON objects in SSE data lines.
export function createUsageCollector() {
  const decoder = new StringDecoder('utf8')
  const stack = []
  let inString = false, escaped = false, isKey = false, key = ''
  let capture = '', captureDepth = 0, latest = null
  function consume(text) {
    for (const ch of text) {
      if (captureDepth) {
        capture += ch
        if (capture.length > 65536) { captureDepth = 0; capture = '' }
      }
      const parent = stack.at(-1)
      if (inString) {
        if (escaped) { escaped = false; if (isKey && key.length < 128) key += ch; continue }
        if (ch === '\\') { escaped = true; continue }
        if (ch === '"') {
          inString = false
          if (isKey && parent) { parent.key = key; parent.expectsKey = false }
        } else if (isKey && key.length < 128) key += ch
        continue
      }
      if (ch === '"') { inString = true; escaped = false; isKey = parent?.expectsKey === true; key = ''; continue }
      if (ch === '{' || ch === '[') {
        const path = parent ? [...parent.path, parent.key ?? '*'] : []
        if (ch === '{' && parent?.key === 'usage' && (parent.path.length === 0 || parent.path.join('.') === 'response')) {
          capture = '{'; captureDepth = stack.length + 1
        }
        if (stack.length >= 256) { stack.length = 0; captureDepth = 0; capture = ''; continue }
        stack.push({ path, key: null, object: ch === '{', expectsKey: ch === '{' })
      } else if (ch === '}' || ch === ']') {
        if (captureDepth && stack.length === captureDepth) {
          try { latest = normalizeUsage(JSON.parse(capture)) || latest } catch {}
          captureDepth = 0; capture = ''
        }
        stack.pop()
      } else if (ch === ',' && parent) {
        parent.key = null
        parent.expectsKey = parent.object
      } else if (ch === ':' && parent) {
        parent.expectsKey = false
      }
    }
  }
  return {
    write(chunk) { consume(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) },
    end() { consume(decoder.end()); return latest },
    get usage() { return latest }
  }
}

export function extractUsage(text) {
  if (!text) return null
  const collector = createUsageCollector()
  collector.write(text)
  return collector.end()
}

// Decode only the observation branch. Forward the original response bytes.
export function createUsageTap({ encoding = '', onUsage }) {
  const collector = createUsageCollector()
  const compression = String(encoding).toLowerCase()
  const unzip = compression === 'gzip' ? createGunzip() : compression === 'br' ? createBrotliDecompress() : compression === 'deflate' ? createInflate() : null
  let decodeFailed = false
  if (unzip) {
    unzip.on('data', chunk => collector.write(chunk))
    unzip.on('error', () => { decodeFailed = true })
  }
  const finish = () => { const usage = collector.end(); if (usage && !decodeFailed) onUsage(usage) }
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (unzip && !decodeFailed) unzip.write(chunk, () => callback(null, chunk))
      else { if (!unzip) collector.write(chunk); callback(null, chunk) }
    },
    flush(callback) {
      if (!unzip || decodeFailed) { finish(); callback(); return }
      let done = false
      const complete = () => { if (done) return; done = true; finish(); callback() }
      unzip.once('end', complete)
      unzip.once('error', complete)
      unzip.end()
    },
    destroy(error, callback) { unzip?.destroy(); callback(error) }
  })
}

// The gateway requests bridge usage internally even if a chat client omits it.
// Hide only the additional usage-only event; preserve every other SSE byte.
export function createChatUsageFilter() {
  let pending = Buffer.alloc(0), passingLargeEvent = false
  function usageOnly(event) {
    const data = event.toString('utf8').split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    try { const value = JSON.parse(data); return Array.isArray(value.choices) && value.choices.length === 0 && value.usage != null } catch { return false }
  }
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending = Buffer.concat([pending, chunk])
      let match
      while ((match = /\r?\n\r?\n/.exec(pending.toString('latin1')))) {
        const end = match.index + match[0].length
        const event = pending.subarray(0, end)
        if (passingLargeEvent || !usageOnly(event)) this.push(event)
        pending = pending.subarray(end)
        passingLargeEvent = false
      }
      if (pending.length > 1024 * 1024) {
        this.push(pending.subarray(0, -3))
        pending = pending.subarray(-3)
        passingLargeEvent = true
      }
      callback()
    },
    flush(callback) { if (pending.length) this.push(pending); callback() }
  })
}
