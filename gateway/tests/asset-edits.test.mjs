import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { PNG } from '../node_modules/pngjs/lib/png.js'
import { generateImage, ImageRequest } from '../node_modules/chatgpt-bridge/dist/index.js'
import { createAuditHarness } from './audit-harness.mjs'
import { createEditSession, editSession, saveEditSession, editFile, resolveEditRequest, exportEditSession, validateMarks } from '../asset-edits.mjs'

const png = new PNG({ width: 32, height: 24 }); png.data.fill(255)
const bytes = PNG.sync.write(png), b64 = bytes.toString('base64'), preview = 'data:image/png;base64,' + b64
const marks = [{ type: 'rect', points: [{ x: .1, y: .2 }, { x: .6, y: .8 }], note: '改为白色' }]

test('immutable original, resumable drafts, revision conflicts, bounded marks and Key isolation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-asset-edit-'))
  const paths = { root, cache: path.join(root, 'cache') }
  try {
    const args = { source: 'generated', name: 'a.png', bytes, keyId: 'A' }
    const session = createEditSession(paths, args)
    assert.equal(createEditSession(paths, args).id, session.id)
    assert.throws(() => editSession(paths, session.id, 'B'), { status: 404 })
    const saved = saveEditSession(paths, session.id, 'A', false, { revision: 0, marks, instruction: '调整茶壶', preserve: '保持构图', preview })
    assert.equal(saved.revision, 1)
    assert.throws(() => saveEditSession(paths, session.id, 'A', false, { revision: 0, marks: [], instruction: 'lost', preserve: '' }), { status: 409 })
    assert.equal(editSession(paths, session.id, 'A').instruction, '调整茶壶')
    const request = resolveEditRequest(paths, { edit_session_id: session.id, edit_revision: 1, prompt: '按保存的标注编辑' }, 'A')
    assert.deepEqual(request.image, [preview, preview]); assert.equal(request.reference_images, undefined)
    assert.match(request.prompt, /标注 1：改为白色/); assert.match(request.prompt, /需要保留：保持构图/)
    assert.equal(request.cgw_edit.parentId, saved.parentId)
    assert.throws(() => resolveEditRequest(paths, { edit_session_id: session.id, edit_revision: 0 }, 'A'), { status: 409 })
    assert.deepEqual(resolveEditRequest(paths, { prompt: 'fixture', cgw_edit: { parentId: 'spoof' } }, 'A'), { prompt: 'fixture' })
    assert.throws(() => resolveEditRequest(paths, { edit_session_id: session.id, image: preview }, 'A'))
    assert.throws(() => validateMarks([{ ...marks[0], points: [{ x: -1, y: 0 }] }]))
    assert.throws(() => validateMarks(Array(101).fill(marks[0])))
    assert.deepEqual(editFile(paths, saved, 'original').bytes, bytes)
    const exported = exportEditSession(paths, saved)
    assert.deepEqual(fs.readFileSync(path.join(paths.cache, 'asset-exports', exported.id, 'original.png')), bytes)
    assert.match(fs.readFileSync(path.join(paths.cache, 'asset-exports', exported.id, 'instructions.txt'), 'utf8'), /改为白色/)
    const clean = saveEditSession(paths, session.id, 'A', false, { revision: 1, marks: [], instruction: '只改背景', preserve: '' })
    assert.equal(clean.hasPreview, false); assert.equal(resolveEditRequest(paths, { edit_session_id: session.id, edit_revision: 2 }, 'A').reference_images, undefined)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('actual HTTP/MCP saved-edit roundtrip: authorized original and annotation reach upstream; result retains lineage', { timeout: 60000 }, async () => {
  const harness = await createAuditHarness(), calls = [], upstreamCalls = []
  const bridge = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { req.resume(); res.writeHead(503); res.end(); return }
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    try {
      const body = JSON.parse(Buffer.concat(chunks)); calls.push(body)
      const result = await generateImage({ imageModel: 'offline-fixture', timeoutMs: 1000 }, { async call(options) {
        upstreamCalls.push(options.body)
        return new Response('data: ' + JSON.stringify({ type: 'response.output_item.done', item: { type: 'image_generation_call', result: b64 } }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }, async raiseForStatus() {} }, ImageRequest.parse(body))
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ b64_json: result.b64 }] }))
    } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: e.message } })) }
  })
  bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening')
  try {
    harness.env.BRIDGE_PORT = String(bridge.address().port); harness.reset(); await harness.start()
    const admin = JSON.parse(fs.readFileSync(path.join(harness.sandbox, 'admin-token.json'))).token
    const request = (route, key, body) => fetch(harness.base + route, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) })
    const a = (await (await request('/__gw/apikeys', admin, { name: 'A' })).json()).key
    const b = (await (await request('/__gw/apikeys', admin, { name: 'B' })).json()).key
    const initial = await (await request('/v1/images/generations', a.token, { prompt: 'fixture original' })).json()
    const name = path.basename(initial.data[0].local_path)
    let response = await request('/v1/gen-images/edit-sessions', a.token, { name })
    assert.equal(response.status, 200)
    const session = (await response.json()).session
    assert.equal((await request('/v1/gen-images/edit-sessions?id=' + session.id + '&file=original', b.token)).status, 404)
    assert.equal((await request('/v1/gen-images/edit-sessions', b.token, { name })).status, 404)
    response = await request('/v1/gen-images/edit-sessions', a.token, { id: session.id, revision: 0, marks, preview, instruction: '修改茶壶材质', preserve: '光线和构图' })
    assert.equal(response.status, 200)
    const fromAdmin = await (await request('/__gw/assets/edit-sessions?id=' + session.id, admin)).json()
    assert.equal(fromAdmin.session.marks[0].note, '改为白色')
    const size = calls.length
    assert.equal((await request('/v1/images/edits', b.token, { prompt: 'edit', edit_session_id: session.id, edit_revision: 1 })).status, 404)
    assert.equal((await request('/v1/images/edits', a.token, { prompt: 'edit', edit_session_id: session.id, edit_revision: 0 })).status, 409)
    assert.equal(calls.length, size)
    const staleRpc = await request('/mcp', a.token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'generate_image', arguments: { prompt: 'edit', edit_session_id: session.id, edit_revision: 0 } } })
    const staleReply = JSON.parse((await staleRpc.text()).split('\n').find(line => line.startsWith('data:')).slice(5))
    assert.equal(staleReply.result.isError, true); assert.match(staleReply.result.content[0].text, /重新复制/)

    const rpc = await request('/mcp', a.token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'generate_image', arguments: { prompt: '按保存的标注编辑', edit_session_id: session.id, edit_revision: 1 } } })
    const reply = JSON.parse((await rpc.text()).split('\n').find(line => line.startsWith('data:')).slice(5))
    assert.notEqual(reply.result.isError, true)
    assert.deepEqual(calls.at(-1).image, [preview, preview]); assert.equal(calls.at(-1).reference_images, undefined); assert.equal(calls.at(-1).cgw_edit, undefined)
    assert.match(calls.at(-1).prompt, /标注 1：改为白色/)
    assert.equal(upstreamCalls.at(-1).tools[0].action, 'edit')
    assert.deepEqual(upstreamCalls.at(-1).input[1].content.filter(p => p.type === 'input_image').map(p => p.image_url), [preview, preview])
    const images = (await (await request('/v1/gen-images/list', a.token)).json()).images
    const child = images.find(image => image.parentId === session.parentId)
    assert.ok(child); assert.notEqual(child.name, name); assert.equal(child.familyId, session.familyId)
    const versions = await (await request('/v1/gen-images/edit-sessions?versions=true&name=' + name, a.token)).json()
    assert.equal(versions.images.length, 2)
    assert.deepEqual(Buffer.from(await (await request('/v1/gen-images/' + name, a.token)).arrayBuffer()), bytes)
    const exported = await (await request('/__gw/assets/edit-sessions', admin, { id: session.id, action: 'export' })).json()
    assert.ok(exported.export.files.includes('instructions.txt'))
    const localDir = path.join(harness.sandbox, 'local-fixture'); fs.mkdirSync(localDir); fs.writeFileSync(path.join(localDir, 'local.png'), bytes)
    const source = await (await request('/__gw/assets/sources', admin, { type: 'local', name: 'local fixture', config: { dir: localDir } })).json()
    const local = await (await request('/__gw/assets/edit-sessions', admin, { src: source.source.id, name: 'local.png', keyId: a.id })).json()
    assert.equal(local.session.keyId, a.id)
    assert.equal((await request('/v1/gen-images/edit-sessions?id=' + local.session.id, a.token)).status, 200)
    assert.equal((await request('/v1/gen-images/edit-sessions?id=' + local.session.id, b.token)).status, 404)

  } finally { await harness.close(); bridge.closeAllConnections(); await new Promise(resolve => bridge.close(resolve)) }
})
