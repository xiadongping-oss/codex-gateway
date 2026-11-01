import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gwRequest } from '../src/api/client.js'

function mock(t, fn) { const old=globalThis.fetch;globalThis.fetch=fn;t.after(()=>globalThis.fetch=old) }
test('gateway errors retain status, safe detail and code without dumping response',async t=>{
 mock(t,async()=>new Response(JSON.stringify({error:'client_not_found',detail:'未找到官方客户端',access_token:'DO_NOT_DISPLAY'}),{status:404}))
 await assert.rejects(gwRequest('/fixture'),e=>e.status===404&&e.code==='client_not_found'&&e.detail==='未找到官方客户端'&&!e.message.includes('DO_NOT_DISPLAY'))
})
test('401 and 403 remain distinguishable and redact bearer credentials',async t=>{
 for(const status of [401,403]){
  mock(t,async()=>new Response(JSON.stringify({detail:'Bearer secret-credential-value'}),{status}))
  await assert.rejects(gwRequest('/fixture'),e=>e.status===status&&!e.message.includes('secret-credential-value')&&e.message.includes('已隐藏'))
 }
})
test('network and timeout are readable and do not expose native exception text',async t=>{
 for(const name of ['TypeError','TimeoutError']){
  mock(t,async()=>{throw Object.assign(new Error('private payload'),{name})})
  await assert.rejects(gwRequest('/fixture'),e=>e.status===0&&e.code===(name==='TimeoutError'?'timeout':'network_error')&&!e.message.includes('private payload'))
 }
})
test('strict account parsing rejects invalid JSON; default compatibility and explicit fallback remain',async t=>{
 mock(t,async()=>new Response('invalid',{status:200}))
 await assert.rejects(gwRequest('/fixture','GET',null,undefined,{strictJson:true}),e=>e.code==='invalid_json')
 assert.deepEqual(await gwRequest('/fixture'),{})
 assert.equal(await gwRequest('/fixture','GET',null,()=>7,{strictJson:true}),7)
})
test('success and local missing-auth result are preserved unchanged',async t=>{
 for(const payload of [{ok:true,sessionId:'fixture'},{error:'not_found',exists:false}]){
  mock(t,async()=>new Response(JSON.stringify(payload),{status:200}))
  assert.deepEqual(await gwRequest('/fixture','GET',null,undefined,{strictJson:true}),payload)
 }
})
test('HTTP and network explicit fallback still return supplied value',async t=>{
 mock(t,async()=>new Response('{}',{status:500}));assert.equal(await gwRequest('/fixture','GET',null,false),false)
 globalThis.fetch=async()=>{throw new Error('offline')};assert.deepEqual(await gwRequest('/fixture','GET',null,()=>[]),[])
})
