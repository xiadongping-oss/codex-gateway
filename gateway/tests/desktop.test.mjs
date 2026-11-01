import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { createControlChannel, parseStrictJson } from '../desktop-protocol.mjs'
import { createDesktopTickets } from '../desktop-ticket.mjs'
import { createShutdownManager } from '../shutdown-manager.mjs'
import { createWorkTracker } from '../work-tracker.mjs'
import { createBridgePool } from '../bridge-pool.mjs'

const id = 'b7da9434-52d8-4a4d-9e12-3c95486db6a4'
const frame = (seq = 1, overrides = {}) => ({ protocol: 'cgw.desktop', version: 1, launchId: id, seq, kind: 'request', type: 'initialize', requestId: seq, payload: { challenge: 'a'.repeat(64) }, ...overrides })
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await sleep(10) }
  assert.fail('condition timeout')
}
function rig() {
  const input = new PassThrough(), output = new PassThrough(), requests = [], faults = [], lines = []
  output.on('data', b => lines.push(JSON.parse(b)))
  const channel = createControlChannel({ input, output, onRequest: m => requests.push(m), onFault: c => faults.push(c) })
  return { input, output, requests, faults, lines, channel }
}
test('control: fragmented UTF-8, multiple frames, independent response sequence', () => {
  const r = rig()
  const bytes = Buffer.from(JSON.stringify(frame(1, { payload: { label: '中文' } })) + '\n' + JSON.stringify(frame(2)) + '\n')
  for (const byte of bytes) r.input.write(Buffer.from([byte]))
  assert.equal(r.requests.length, 2)
  assert.deepEqual(r.faults, [])
  r.channel.respond(r.requests[1], {})
  r.channel.respond(r.requests[0], {})
  assert.deepEqual(r.lines.map(x => [x.seq, x.requestId]), [[1, 2], [2, 1]])
})
for (const [name, bytes, expected] of [
  ['empty', '\n', 'FRAME_INVALID'], ['BOM', '\ufeff{}\n', 'FRAME_INVALID'],
  ['duplicate escaped key', '{"x":1,"\\u0078":2}\n', 'FRAME_INVALID'],
  ['invalid UTF8', Buffer.from([0xc0, 0x80, 10]), 'FRAME_INVALID'],
  ['unterminated oversized', 'x'.repeat(65536), 'FRAME_INVALID'],
  ['unsupported', JSON.stringify(frame(1, { version: 2 })) + '\n', 'PROTOCOL_UNSUPPORTED'],
  ['gap', JSON.stringify(frame(2)) + '\n', 'FRAME_INVALID'],
  ['unknown field', JSON.stringify({ ...frame(), extra: true }) + '\n', 'FRAME_INVALID'],
  ['bad identity', JSON.stringify(frame(1, { launchId: 'wrong' })) + '\n', 'IDENTITY_MISMATCH']
]) test(`control rejects ${name}`, () => {
  const r = rig(); r.input.write(bytes)
  assert.deepEqual(r.faults, [expected]); assert.equal(r.requests.length, 0)
})
test('control rejects duplicate sequence and changed launch identity', () => {
  for (const next of [frame(), frame(2, { launchId: 'a7da9434-52d8-4a4d-9e12-3c95486db6a4' })]) {
    const r = rig(); r.input.write(JSON.stringify(frame()) + '\n' + JSON.stringify(next) + '\n')
    assert.equal(r.requests.length, 1); assert.equal(r.faults.length, 1)
  }
  assert.throws(() => parseStrictJson('{"outer":{"x":1,"x":2}}'))
  assert.deepEqual(parseStrictJson('{"x":{},"y":[],"a":{"x":1}}'), { x: {}, y: [], a: { x: 1 } })
})
test('control backpressure is bounded; EOF is reported once', async () => {
  const input = new PassThrough(), faults = []
  const output = new Writable({ write(_b, _e, _cb) {} })
  const channel = createControlChannel({ input, output, onRequest() {}, onFault: c => faults.push(c) })
  input.write(JSON.stringify(frame()) + '\n')
  for (let i = 0; i < 30; i++) channel.event('ready', { text: 'x'.repeat(50_000) })
  assert.deepEqual(faults, ['CONTROL_CHANNEL_LOST'])
  assert.ok(output.writableLength <= 1024 * 1024)
  output.destroy(); input.end(); await sleep(10)
  assert.equal(faults.length, 1)
})
test('desktop tickets: single-use, replacement, expiry, same launchId with different process secret', () => {
  let time = 10
  const a = createDesktopTickets(id, () => time), b = createDesktopTickets(id, () => time)
  const first = a.issue().ticket, second = a.issue().ticket
  assert.equal(a.consume(first).ok, false)
  assert.equal(b.consume(second).ok, false)
  assert.equal(a.consume(second.slice(0, -1) + 'z').ok, false)
  assert.equal(a.consume(second).ok, true)
  assert.equal(a.consume(second).ok, false)
  const third = a.issue().ticket; time += 60_000
  assert.equal(a.consume(third).ok, false)
  const fourth = a.issue().ticket; a.invalidate(); assert.equal(a.consume(fourth).ok, false)
})
function lifecycle(options = {}) {
  const work = createWorkTracker(), events = [], calls = [], result = []
  let failFlush = false
  const runtime = {
    counts: () => ({ ...work.counts(), bridgeCount: 0 }),
    drain() { calls.push('drain'); work.drain() }, cancel() { calls.push('cancel'); work.cancel() },
    flush() { calls.push('flush'); if (failFlush) throw new Error('disk full') },
    async stopChildren() { calls.push('children'); return true },
    async closeHttp() { calls.push('http'); return true },
    release() { calls.push('release'); return true }, ...options
  }
  const manager = createShutdownManager({ runtime, emit: (type, payload) => events.push({ type, payload }), finish: r => result.push(r), drainMs: 50, cleanupMs: 100 })
  return { work, events, calls, result, manager, setFail: value => { failFlush = value } }
}
test('shutdown waits for registered handlers and repeated shutdown does not reset deadline', async () => {
  const r = lifecycle(), done = r.work.begin('request')
  r.manager.begin(); await sleep(30); r.manager.begin()
  await until(() => r.manager.status().waiting)
  assert.deepEqual(r.calls, ['drain'])
  assert.equal(r.events.find(x => x.type === 'shutdown.waiting').payload.reason, 'DRAIN_TIMEOUT')
  assert.equal(r.manager.continue(), true)
  assert.equal(r.work.draining, true)
  done(); await until(() => r.result.length)
  assert.equal(r.result[0].exitCode, 0)
  assert.deepEqual(r.calls, ['drain', 'flush', 'children', 'http', 'flush', 'release'])
})
test('shutdown flush failure waits, retains data, continue retries without reopening', async () => {
  const r = lifecycle(); r.setFail(true); r.manager.begin()
  await until(() => r.manager.status().waiting)
  assert.equal(r.events.at(-1).payload.reason, 'FLUSH_FAILED')
  assert.equal(r.calls.includes('children'), false)
  r.setFail(false); assert.equal(r.manager.continue(), true)
  await until(() => r.result.length)
  assert.equal(r.result[0].persisted, true); assert.equal(r.result[0].outcome, 'graceful')
})
test('shutdown force still saves; unconfirmed child exit retains ownership', async () => {
  const r = lifecycle({ async stopChildren() { return false } })
  const done = r.work.begin('background', () => done())
  r.manager.begin(); await until(() => r.manager.status().waiting)
  r.manager.force(); await until(() => r.result.length)
  assert.equal(r.result[0].persisted, true); assert.equal(r.result[0].childrenExited, false)
  assert.equal(r.result[0].exitCode, 1); assert.equal(r.calls.includes('release'), false)
})
test('shutdown force cancels work, reports forced; orphan channel has bounded wait', async () => {
  for (const urgent of [false, true]) {
    const r = lifecycle(), done = r.work.begin('background', () => done())
    r.manager.begin({ urgent })
    if (!urgent) { await until(() => r.manager.status().waiting); r.manager.force() }
    await until(() => r.result.length)
    assert.equal(r.result[0].exitCode, 4)
    assert.equal(r.result[0].outcome, 'forced')
  }
})
test('pool waits for actual exit even if instance was already removed', async () => {
  const child = new EventEmitter(); child.pid = 123; child.exitCode = null; child.kill = () => true
  const pool = createBridgePool({ spawn: () => child, probe: async () => ({ listening: true }) })
  await pool.start('a'); pool.stop('a')
  assert.equal(pool.list().length, 0); assert.equal(pool.childCount(), 1)
  pool.drain()
  assert.equal((await pool.start('b')).ok, false)
  assert.equal(await pool.stopAndWait(30), false)
  const stopped = pool.stopAndWait(200)
  setTimeout(() => child.emit('exit', 0), 25)
  assert.equal(await stopped, true)
  pool.dispose()
})

test('shutdown waits for asynchronous cancellation before final flush and unlock', async () => {
  const r = lifecycle()
  const done = r.work.begin('request', () => setTimeout(() => { r.calls.push('settled'); done() }, 20))
  r.manager.begin(); await until(() => r.manager.status().waiting); r.manager.force()
  await until(() => r.result.length)
  assert.equal(r.result[0].outcome, 'forced')
  assert.deepEqual(r.calls.slice(-3), ['settled', 'flush', 'release'])
})

test('shutdown keeps ownership when cancellation cannot settle within cleanup budget', async () => {
  const r = lifecycle()
  r.work.begin('request', () => {})
  r.manager.begin(); await until(() => r.manager.status().waiting); r.manager.force()
  await until(() => r.result.length)
  assert.equal(r.result[0].outcome, 'failed')
  assert.equal(r.result[0].persisted, false)
  assert.equal(r.calls.includes('release'), false)
})
