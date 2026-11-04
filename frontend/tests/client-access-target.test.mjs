import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {ref,computed,watch} from 'vue'
import '../../gateway/client-setup.js'

const helpers=globalThis.CGWClientSetup
const source=fs.readFileSync(new URL('../src/views/ClientAccess.vue',import.meta.url),'utf8').split('<script setup>')[1].split('</script>')[0].replace(/^import .*$/gm,'')
const assets={gatewayVersion:'test',skill:{sha256:'a'.repeat(64)},mcp:{sha256:'b'.repeat(64)}}
function component({enabled=true,reveal,initialModel=''}={}) {
  const copied=[],unmounted=[],revealed=[]
  const run=new Function('ref','computed','watch','onMounted','onUnmounted','defineEmits','defineProps','api','BASE','window','copyText','formatAccessConfig','gwRequest','fetch',source+'\nreturn {target,base,keyId,connections,prompt,error,feedback,copy,copySetup,load,device,manual,manualKey,model};')
  const api={listApiKeys:async()=>[{id:'fixture-id',name:'Fixture',mask:'cgw-…'}],getModels:async()=>[{id:'fixture-text',kind:'text'}],revealApiKey:async id=>{revealed.push(id);return reveal?reveal(id):{token:'cgw-synthetic-fixture'}}}
  const c=run(ref,computed,watch,()=>{},fn=>unmounted.push(fn),()=>()=>{},()=>({initialModel}),api,'',{location:{origin:'http://127.0.0.1:4173'}},async text=>copied.push(text),(base,key,model)=>[base,key,model].join('\n'),async()=>({lan:{enabled,port:5199,addresses:[{address:'192.0.2.5',preferred:true},{address:'100.64.0.2'}]}}),async()=>({ok:true,json:async()=>assets}))
  return {...c,copied,revealed,dispose:()=>unmounted.forEach(fn=>fn())}
}

test('remote configuration rejects loopback, wildcard and credential-bearing addresses before returning a Key',()=>{
  for(const base of ['http://127.0.0.1:4173','http://localhost:4173','http://[::1]:4173','http://127.1:4173','http://0.0.0.0:4174','http://[::]:4174','https://user:secret@host.example'])assert.throws(()=>helpers.buildMcpConfig({base,target:'remote',key:'synthetic'}))
  assert.equal(helpers.buildMcpConfig({base:'http://[fd00::5]:5199',target:'remote',key:'fixture'}).mcpServers['codex-gateway-lan'].url,'http://[fd00::5]:5199/mcp')
})
test('local is selected by default; remote copy uses shared host and custom port for every service',async()=>{
  const c=component();await c.load()
  assert.equal(c.target.value,'local');assert.equal(c.base.value,'http://127.0.0.1:4173')
  c.target.value='remote';assert.equal(c.base.value,'http://192.0.2.5:5199')
  assert.ok(!c.prompt.value.includes('cgw-synthetic-fixture'))
  await c.copy('prompt')
  const prompt=c.copied[0]
  assert.match(prompt,/无需安装|不需要安装/);assert.match(prompt,/不要建议在用户电脑安装或启动网关/)
  for(const route of ['/mcp','/gallery','/client-assets.json','/lan-kit/skills/codex-gateway-image/SKILL.md'])assert.ok(prompt.includes('http://192.0.2.5:5199'+route))
  await c.copy('mcp');assert.equal(JSON.parse(c.copied[1]).mcpServers['codex-gateway-lan'].headers.Authorization,'Bearer cgw-synthetic-fixture')
  await c.copySetup();assert.equal(c.copied.at(-1),'http://192.0.2.5:5199/setup');c.dispose()
})
test('disabled sharing cannot produce remote credentials or fall back to localhost',async()=>{
  const c=component({enabled:false});await c.load();c.target.value='remote'
  assert.equal(c.base.value,'');await c.copy('mcp');assert.equal(c.copied.length,0);assert.equal(c.revealed.length,0);c.dispose()
})
test('changing target during key retrieval discards a stale local copy; local address is labelled for local use only',async()=>{
  let finish
  const c=component({reveal:()=>new Promise(resolve=>finish=resolve)});await c.load();c.target.value='local'
  await c.copySetup();assert.match(c.feedback.value,/仅限网关这台电脑/)
  const pending=c.copy('prompt');c.target.value='remote';finish({token:'cgw-synthetic-stale'});await pending
  assert.equal(c.copied.length,1);assert.equal(c.base.value,'http://192.0.2.5:5199');c.dispose()
})

test('unified access copies only the selected key and never puts it in the Prompt preview', async () => {
  const c = component()
  await c.load()
  c.target.value = 'local'
  await c.copy('model')
  assert.deepEqual(c.revealed, ['fixture-id'])
  assert.match(c.copied[0], /cgw-synthetic-fixture/)
  assert.doesNotMatch(c.prompt.value, /cgw-synthetic-fixture/)
  c.dispose()
})
test('model changes during key retrieval discard the old configuration', async () => {
  let finish
  const c = component({ reveal: () => new Promise(resolve => { finish = resolve }) })
  await c.load()
  c.target.value = 'local'
  const pending = c.copy('json')
  c.model.value = 'another-model'
  finish({ token: 'synthetic-stale' })
  await pending
  assert.equal(c.copied.length, 0)
  c.dispose()
})
test('manual keys and selected models use the unified JSON export without revealing another key', async () => {
  const c = component({ initialModel: 'fixture-text' })
  await c.load()
  assert.equal(c.model.value, 'fixture-text')
  c.target.value = 'remote'
  c.manual.value = true
  c.manualKey.value = '  synthetic-manual  '
  await c.copy('json')
  assert.deepEqual(JSON.parse(c.copied[0]), {
    baseUrl: 'http://192.0.2.5:5199/v1',
    apiKey: 'synthetic-manual',
    model: 'fixture-text'
  })
  assert.equal(c.revealed.length, 0)
  assert.doesNotMatch(c.prompt.value, /synthetic-manual/)
  c.dispose()
})
