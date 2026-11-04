import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {desktopFixture,freePort} from './lib/desktop-fixture.mjs'

test('management failures aggregate separately; real API failures remain business calls; LAN totals survive log rotation and restart',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cgw-log-policy-'))
  const original=process.env.CGW_DATA_DIR
  process.env.CGW_DATA_DIR=root
  const logs=await import('../call-logs.mjs?policy-first')
  if(original===undefined)delete process.env.CGW_DATA_DIR;else process.env.CGW_DATA_DIR=original
  t.after(()=>{logs.flushCallLogs();fs.rmSync(root,{recursive:true,force:true})})
  const now=Date.now(),caller={source:'local',ip:'127.0.0.1'}
  for(let i=0;i<80;i++)logs.recordCallLog({method:'GET',endpoint:'/__gw/call-logs',status:401,caller})
  assert.equal(logs.getCallLogs().length,0)
  assert.equal(logs.getManagementLogs().length,1)
  assert.equal(logs.getManagementLogs()[0].count,80)
  logs.recordCallLog({method:'POST',endpoint:'/v1/responses',status:401,caller})
  assert.equal(logs.getCallLogs()[0].status,401)
  for(let i=0;i<240;i++)logs.recordCallLog({at:now,method:'POST',endpoint:'/v1/responses',status:200,tokens:20,caller:{source:'lan',ip:'192.0.2.1',keyId:'one-user'}})
  logs.recordCallLog({at:now,method:'POST',endpoint:'/mcp:list_generated_images',status:200,caller:{source:'lan',keyId:'another-user'}})
  logs.recordCallLog({at:now,endpoint:'/v1/responses',status:200,tokens:999,caller:{source:'local',keyId:'local-key'}})
  logs.recordCallLog({at:now,endpoint:'/v1/responses',status:401,caller:{source:'lan'}})
  assert.equal(logs.getLanUsage(now).activeUsers,2)
  assert.equal(logs.getLanUsage(now).tokensTotal,4800)
  logs.flushCallLogs()
  process.env.CGW_DATA_DIR=root
  const restarted=await import('../call-logs.mjs?policy-restarted')
  if(original===undefined)delete process.env.CGW_DATA_DIR;else process.env.CGW_DATA_DIR=original
  assert.equal(restarted.getManagementLogs()[0].count,80)
  assert.equal(restarted.getLanUsage(now).tokensTotal,4800)
  assert.equal(restarted.getLanUsage(now+300001).activeUsers,0)
  assert.equal(restarted.getLanUsage(now+300001).tokensTotal,4800)
})

test('actual control-plane polling and rejected model calls stay in their own feeds; verified LAN requests produce real source tags',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cgw-log-http-'))
  let fixture
  t.after(async()=>{await fixture?.stop();fs.rmSync(root,{recursive:true,force:true})})
  fixture=await desktopFixture({root,resources:fileURLToPath(new URL('../..',import.meta.url)),node:process.execPath})
  await fixture.start();await fixture.login()
  for(let i=0;i<4;i++)assert.equal((await fetch(fixture.ready.origin+'/__gw/call-logs')).status,401)
  const rejected=await fetch(fixture.ready.origin+'/v1/responses',{method:'POST',headers:{Authorization:'Bearer invalid-key','Content-Type':'application/json'},body:'{}'})
  assert.equal(rejected.status,401)
  let feed=await(await fixture.request('/__gw/call-logs')).json()
  assert.equal(feed.management.find(log=>log.endpoint==='/__gw/call-logs').count,4)
  assert.equal(feed.logs.filter(log=>log.endpoint.startsWith('/__gw/')).length,0)
  assert.ok(feed.logs.some(log=>log.endpoint==='/v1/responses'&&log.status===401))
  const key=(await(await fixture.request('/__gw/apikeys',{name:'真实来源测试'})).json()).key
  let keys=(await(await fixture.request('/__gw/apikeys')).json()).keys
  assert.deepEqual(keys[0].usageSources,[])
  const port=await freePort()
  assert.equal((await fixture.request('/__gw/lan',{enabled:true,port})).status,200)
  for(const origin of [fixture.ready.origin,'http://127.0.0.1:'+port]){
    const r=await fetch(origin+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+key.token,'Content-Type':'application/json'},body:JSON.stringify({id:1,jsonrpc:'2.0',method:'tools/call',params:{name:'list_generated_images',arguments:{}}})})
    assert.equal(r.status,200);await r.arrayBuffer()
  }
  keys=(await(await fixture.request('/__gw/apikeys')).json()).keys
  assert.deepEqual(keys[0].usageSources.map(s=>s.source).sort(),['lan','local'])
  assert.ok(keys[0].usageSources.every(s=>s.callCount===1))
  const status=await(await fixture.request('/__gw/status')).json()
  assert.equal(status.lanUsage.activeUsers,1)
  assert.equal(status.lanUsage.tokensTotal,0)
})

test('legacy business records remain readable; old management polling migrates to an aggregate without inventing historic LAN totals',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cgw-log-legacy-'))
  fs.mkdirSync(path.join(root,'data'))
  const at=Date.now()
  fs.writeFileSync(path.join(root,'data/call-logs.json'),JSON.stringify({seq:3,logs:[
    {id:3,at,endpoint:'/v1/responses',method:'POST',status:200,tokens:17,caller:{source:'lan',keyId:'old-user'}},
    {id:2,at:at-100,endpoint:'/__gw/status',method:'GET',status:401},
    {id:1,at:at-200,endpoint:'/__gw/status',method:'GET',status:401}
  ]}))
  const original=process.env.CGW_DATA_DIR
  process.env.CGW_DATA_DIR=root
  const logs=await import('../call-logs.mjs?policy-legacy')
  if(original===undefined)delete process.env.CGW_DATA_DIR;else process.env.CGW_DATA_DIR=original
  t.after(()=>{logs.flushCallLogs();fs.rmSync(root,{recursive:true,force:true})})
  assert.equal(logs.getCallLogs()[0].id,3)
  assert.equal(logs.getCallLogs()[0].tokens,17)
  assert.equal(logs.getManagementLogs()[0].count,2)
  assert.equal(logs.getLanUsage().tokensTotal,0)
  logs.recordCallLog({endpoint:'/v1/models',method:'GET',status:200})
  assert.equal(logs.getCallLogs()[0].id,4)
})
