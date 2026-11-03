import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {clientAssets} from '../client-assets.mjs'
import {requestCaller,withCaller,currentCaller,issueCallerTransfer,consumeCallerTransfer} from '../request-context.mjs'
import {imagePresentation,imageToolResult} from '../image-mcp.mjs'
import {queryAssets} from '../asset-metadata.mjs'
import {fileURLToPath} from 'node:url'
import {desktopFixture,freePort} from './lib/desktop-fixture.mjs'

test('caller identity uses socket IP and verified key; self-reported device is bounded; XFF cannot spoof it',()=>{
  const request={socket:{remoteAddress:'::ffff:192.0.2.9'},headers:{'x-forwarded-for':'198.51.100.3','x-cgw-device-name':encodeURIComponent('设计工作站\n')},desktopLan:true}
  const caller=requestCaller(request,{keyId:'id-fixture',name:'设计组',token:'cgw-secret-fixture'})
  assert.deepEqual(caller,{ip:'192.0.2.9',device:'设计工作站',deviceSelfReported:true,keyId:'id-fixture',keyName:'设计组',source:'lan'})
  assert.ok(!JSON.stringify(caller).includes('secret'))
  assert.equal(requestCaller({...request,headers:{'x-cgw-device-name':'%invalid'}}).device,'')
  assert.equal(requestCaller({...request,headers:{'x-cgw-device-name':'a'.repeat(100)}}).device.length,80)
})

test('concurrent requests retain independent identities, and internal MCP attribution is single-use, key-bound and loopback-only',async()=>{
  const a={ip:'192.0.2.1',keyId:'A'},b={ip:'192.0.2.2',keyId:'B'}
  await Promise.all([withCaller(a,async()=>{await delay(8);assert.equal(currentCaller().keyId,'A')}),withCaller(b,async()=>{await delay(2);assert.equal(currentCaller().keyId,'B')})])
  const token=withCaller(a,issueCallerTransfer)
  const req={method:'POST',url:'/v1/images/generations',socket:{remoteAddress:'127.0.0.1'},headers:{'x-cgw-internal-call':token}}
  assert.equal(consumeCallerTransfer({...req,desktopLan:true},b),b)
  assert.equal(consumeCallerTransfer({...req,socket:{remoteAddress:'192.0.2.8'}},a),a)
  assert.equal(consumeCallerTransfer(req,b),b)
  assert.deepEqual(consumeCallerTransfer(req,{ip:'127.0.0.1',keyId:'A'}),a)
  const local={ip:'127.0.0.1',keyId:'A'}
  assert.equal(consumeCallerTransfer(req,local),local)
})

test('public asset manifest hashes distributed bytes and exact tools array, changes when content changes, and contains no credentials',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cgw-client-assets-'))
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  fs.mkdirSync(path.join(root,'lan-kit/skills/codex-gateway-image'),{recursive:true})
  const skill=path.join(root,'lan-kit/skills/codex-gateway-image/SKILL.md')
  fs.writeFileSync(skill,'---\nname: gpt-image\n---\n');fs.writeFileSync(path.join(root,'client-setup.js'),'fixture')
  const tools=[{name:'generate_image'}],m=clientAssets(root,'fixture',tools)
  assert.equal(m.mcp.sha256,crypto.createHash('sha256').update(JSON.stringify(tools)).digest('hex'))
  assert.equal(m.skill.url,'/lan-kit/skills/codex-gateway-image/SKILL.md')
  fs.appendFileSync(skill,'changed');assert.notEqual(clientAssets(root,'fixture',tools).skill.sha256,m.skill.sha256)
  assert.deepEqual(Object.keys(m).sort(),['gatewayVersion','mcp','prompt','schemaVersion','skill'])
})

test('every successful image offers fresh side-gallery resource and exact image link, with no Key in URL',()=>{
  const item={download_url:'http://127.0.0.1:4173/v1/gen-images/fixture_1.png'}
  const a=imagePresentation('http://192.0.2.2:5199',item),b=imagePresentation('http://192.0.2.2:5199',item)
  const url=new URL(a.gallery_url)
  assert.equal(url.origin,'http://192.0.2.2:5199');assert.equal(url.pathname,'/gallery');assert.equal(url.searchParams.get('image'),'fixture_1.png')
  assert.notEqual(a.gallery_url,b.gallery_url);assert.equal(url.searchParams.has('key'),false)
  assert.match(a.instruction,/每次出图成功/);assert.match(a.instruction,/没有浏览器工具/)
  const r=imageToolResult({text:a.instruction,...a})
  assert.equal(r.content[1].type,'resource_link');assert.equal(r.content[1].uri,a.gallery_url)
  assert.equal(r.structuredContent.open_gallery,true)
  assert.deepEqual(imageToolResult({text:'list'}),{content:[{type:'text',text:'list'}]})
})

test('omitting gallery query parameters keeps all personal images visible',()=>{
  assert.equal(queryAssets([{name:'fixture.png'}],{q:null,sort:null}).length,1)
})

test('LAN MCP records real caller, device and key; public update manifest works, management stays private, and logs survive restart',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cgw-caller-live-'))
  let fixture
  t.after(async()=>{await fixture?.stop();fs.rmSync(root,{recursive:true,force:true})})
  const resources=process.env.CGW_CLIENT_TEST_RESOURCES || fileURLToPath(new URL('../..',import.meta.url))
  const node=process.env.CGW_CLIENT_TEST_RESOURCES ? path.join(resources,'runtime',process.platform==='win32'?'node.exe':'node') : process.execPath
  const open=async()=>{fixture=await desktopFixture({root,resources,node});await fixture.start();await fixture.login()}
  await open()
  const discoveryBefore=await(await fetch(fixture.ready.origin+'/client-connection.json')).json()
  assert.equal(discoveryBefore.sharingEnabled,false);assert.deepEqual(discoveryBefore.sharedOrigins,[])
  const key=(await(await fixture.request('/__gw/apikeys',{name:'测试设备专用'})).json()).key
  const port=await freePort()
  assert.equal((await fixture.request('/__gw/lan',{enabled:true,port})).status,200)
  const origin=`http://127.0.0.1:${port}`
  const discovery=await(await fetch(fixture.ready.origin+'/client-connection.json')).json()
  assert.equal(discovery.sharingEnabled,true);assert.ok(discovery.sharedOrigins.every(item=>new URL(item.origin).port===String(port)))
  assert.deepEqual(Object.keys(discovery).sort(),['localOrigin','sharedOrigins','sharingEnabled'])
  assert.ok(!JSON.stringify(discovery).includes(key.token))
  assert.equal((await fetch(origin+'/client-connection.json')).status,200)
  const manifest=await(await fetch(origin+'/client-assets.json')).json()
  assert.match(manifest.mcp.sha256,/^[a-f0-9]{64}$/)
  const response=await fetch(origin+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+key.token,'Content-Type':'application/json','X-CGW-Device-Name':encodeURIComponent('设计工作站'),'X-Forwarded-For':'198.51.100.99'},body:JSON.stringify({id:1,jsonrpc:'2.0',method:'tools/call',params:{name:'list_generated_images',arguments:{}}})})
  assert.equal(response.status,200);assert.match(await response.text(),/你的生成图库为空/)
  assert.equal((await fetch(origin+'/__gw/call-logs',{headers:{Authorization:'Bearer '+key.token}})).status,403)
  const logs=(await(await fixture.request('/__gw/call-logs')).json()).logs
  const log=logs.find(log=>log.endpoint==='/mcp:list_generated_images')
  assert.equal(log.caller.ip,'127.0.0.1');assert.equal(log.caller.source,'lan');assert.equal(log.caller.device,'设计工作站');assert.equal(log.caller.keyId,key.id);assert.equal(log.caller.keyName,'测试设备专用')
  assert.ok(!JSON.stringify(logs).includes(key.token))
  await fixture.command('shutdown',{reason:'user_exit'});await fixture.exitWithin()
  await open()
  const saved=(await(await fixture.request('/__gw/call-logs')).json()).logs.find(item=>item.id===log.id)
  assert.deepEqual(saved.caller,log.caller)
})
