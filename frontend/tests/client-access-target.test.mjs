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
  const run=new Function('ref','computed','watch','onMounted','onUnmounted','defineEmits','defineProps','api','BASE','window','copyText','formatAccessConfig','gwRequest','fetch',source+'\nreturn {target,base,keyId,connections,prompt,error,feedback,copy,copySetup,load,device,manual,manualKey,model,mode};')
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


test('update Prompt is independent of selected Key and never decrypts credentials, including with no selected Key', async () => {
  const c=component({reveal:()=>{throw new Error('must not reveal a Key')}});await c.load();c.target.value='remote';c.mode.value='update'
  const preview=c.prompt.value
  c.manual.value=true;c.manualKey.value='cgw-other-user-secret'
  assert.equal(c.prompt.value,preview)
  await c.copy('prompt')
  c.manual.value=false;c.keyId.value=''
  await c.copy('prompt')
  assert.equal(c.revealed.length,0);assert.equal(c.copied.length,2);assert.equal(c.copied[0],c.copied[1])
  assert.doesNotMatch(c.copied[0],/cgw-other-user-secret|Bearer |"Authorization"/)
  assert.match(c.copied[0],/保留现有凭据/);assert.match(c.feedback.value,/不包含 API Key/)
  c.dispose()
})

test('explicit Key change Prompt uses the selected new Key and explains scoped galleries and session reload', async () => {
  const c=component();await c.load();c.target.value='remote';c.mode.value='switch-key';c.manual.value=true;c.manualKey.value='cgw-new-user-fixture'
  assert.doesNotMatch(c.prompt.value,/cgw-new-user-fixture/)
  await c.copy('prompt')
  assert.match(c.copied[0],/Bearer cgw-new-user-fixture/)
  for(const phrase of ['对话模型与生图 MCP 必须使用同一个新 Key','把 A 与 B 两处凭据统一替换','两处 keyId 必须相同','旧图不会自动迁移','当前会话尚未切换'])assert.ok(c.copied[0].includes(phrase),phrase)
  assert.doesNotMatch(c.copied[0],/不修改对话模型 Key/)
  assert.equal(c.revealed.length,0)
  c.dispose()
})

test('uninstall Prompt needs no Key, never reveals one and asks for a single clean reinstall', async () => {
  const c=component({reveal:()=>{throw new Error('must not reveal a Key')}});await c.load();c.target.value='remote';c.mode.value='uninstall'
  c.manual.value=false;c.keyId.value=''
  assert.doesNotMatch(c.prompt.value,/<复制时填入所选 API Key>|Bearer |"Authorization"/)
  await c.copy('prompt')
  assert.equal(c.revealed.length,0)
  const text=c.copied[0]
  for(const phrase of ['完全卸载','不含任何 API Key','先备份','保留其他 MCP','不删除图片','一次性配置模型 + MCP + Skill','http://192.0.2.5:5199/mcp'])assert.ok(text.includes(phrase),phrase)
  assert.doesNotMatch(text,/Bearer |"Authorization"/)
  assert.match(c.feedback.value,/不含 API Key/)
  c.dispose()
})

test('all prompt modes enforce one Key across model config and MCP',()=>{
  const base='http://192.0.2.5:5199'
  const sw=helpers.buildClientPrompt({base,target:'remote',key:'cgw-new-fixture',switchKey:true})
  assert.match(sw,/A\. 对话模型配置/);assert.match(sw,/B\. 生图 MCP/)
  assert.match(sw,/两处 keyId 必须相同/);assert.doesNotMatch(sw,/不修改对话模型 Key/)
  const up=helpers.buildClientPrompt({base,target:'remote',update:true})
  assert.match(up,/凭据分叉/);assert.match(up,/本 Prompt 不授权更换 Key/);assert.doesNotMatch(up,/Bearer /)
  const install=helpers.buildClientPrompt({base,target:'remote',key:'cgw-new-fixture'})
  assert.match(install,/不要静默留下/);assert.match(install,/同一 keyId/)
  const uninstall=helpers.buildClientPrompt({base:'http://127.0.0.1:4173',target:'local',uninstall:true})
  assert.match(uninstall,/禁止转发给其他设备/)
  assert.doesNotMatch(uninstall,/Bearer |"Authorization"/)
  for(const extra of [{update:true,uninstall:true},{switchKey:true,uninstall:true},{update:true,switchKey:true,uninstall:true}])assert.throws(()=>helpers.buildClientPrompt({base,target:'remote',key:'x',...extra}))
})

test('shared helper update never reads supplied Key; conflicting actions are rejected',()=>{
  const options={base:'http://192.0.2.5:4174',target:'remote',update:true,get key(){throw new Error('must not read Key')}}
  assert.match(helpers.buildClientPrompt(options),/不携带新 API Key/)
  assert.throws(()=>helpers.buildClientPrompt({base:options.base,target:'remote',update:true,switchKey:true,key:'test'}))
})
