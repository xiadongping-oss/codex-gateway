import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { desktopFixture, freePort } from './lib/desktop-fixture.mjs'

for (const mode of ['bridge', 'openai']) {
  test('real proxy records per-call and key token usage in ' + mode + ' mode', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-proxy-usage-'))
    let fixture, upstreamBody
    const content = 'data: '+JSON.stringify({choices:[{delta:{content:'测试'}}]})+'\n\n'
    const done = 'data: [DONE]\n\n'
    const upstream = http.createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      try { upstreamBody = JSON.parse(Buffer.concat(chunks)) } catch {}
      if (req.method !== 'POST') { res.end(JSON.stringify({ok:true,data:[]})); return }
      if (mode === 'bridge') {
        assert.equal(upstreamBody.stream_options.include_usage, true)
        const payload = content+'data: '+JSON.stringify({choices:[],usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20}})+'\n\n'+done
        res.writeHead(200, {'Content-Type':'text/event-stream','Content-Length':Buffer.byteLength(payload)})
        res.end(payload)
      } else {
        res.writeHead(200, {'Content-Type':'application/json','Content-Encoding':'gzip'})
        res.end(gzipSync(JSON.stringify({output:'内容'.repeat(60000),usage:{input_tokens:12,output_tokens:8,total_tokens:20}})))
      }
    })
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
    t.after(async () => {
      await fixture?.stop()
      upstream.closeAllConnections()
      await new Promise(resolve => upstream.close(resolve))
      fs.rmSync(root, {recursive:true,force:true})
    })
    const dataRoot = path.join(root,'data')
    fixture = await desktopFixture({
      root, resources:fileURLToPath(new URL('../..',import.meta.url)), node:process.execPath, dataRoot,
      overrides:{BRIDGE_PORT:String(upstream.address().port)}
    })
    await fixture.start(); await fixture.login()
    if (mode === 'openai') {
      const configured = await fixture.request('/__gw/auth/mode', {
        mode:'openai',apiKey:'synthetic-upstream-key',
        baseUrl:'http://127.0.0.1:'+upstream.address().port
      })
      assert.equal(configured.status,200)
    }
    const key = (await (await fixture.request('/__gw/apikeys',{name:'usage-test'})).json()).key
    const endpoint = mode === 'bridge' ? '/v1/chat/completions' : '/v1/responses'
    const response = await fetch(fixture.ready.origin+endpoint,{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key.token},
      body:JSON.stringify({model:'gpt-6.1-sol',messages:[{role:'user',content:'test'}],input:'test',stream:mode === 'bridge'}),
      signal:AbortSignal.timeout(10000)
    })
    assert.equal(response.status,200)
    const text = await response.text()
    if (mode === 'bridge') assert.equal(text,content+done)
    else assert.equal(JSON.parse(text).usage.total_tokens,20)
    const logs = (await (await fixture.request('/__gw/call-logs')).json()).logs
    const call = logs.find(item => item.endpoint === endpoint)
    assert.equal(call.tokens,20)
    assert.deepEqual(call.usage,{promptTokens:12,completionTokens:8,totalTokens:20})
    const keys = (await (await fixture.request('/__gw/apikeys')).json()).keys
    assert.equal(keys.find(item=>item.id===key.id).tokens,20)
    assert.equal(keys.find(item=>item.id===key.id).usageSources.find(source=>source.source==='local').tokens,20)
    const lanPort=await freePort()
    assert.equal((await fixture.request('/__gw/lan',{enabled:true,port:lanPort})).status,200)
    const lanResponse=await fetch('http://127.0.0.1:'+lanPort+endpoint,{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key.token},
      body:JSON.stringify({model:'gpt-6.1-sol',messages:[{role:'user',content:'test'}],input:'test',stream:mode==='bridge'}),
      signal:AbortSignal.timeout(10000)
    })
    assert.equal(lanResponse.status,200);await lanResponse.arrayBuffer()
    const status=await(await fixture.request('/__gw/status')).json()
    assert.equal(status.lanUsage.tokensTotal,20)
    assert.equal(status.lanUsage.activeUsers,1)
    const updated=(await(await fixture.request('/__gw/apikeys')).json()).keys.find(item=>item.id===key.id)
    assert.equal(updated.tokens,40)
    assert.equal(updated.usageSources.find(source=>source.source==='lan').tokens,20)
  })
}
