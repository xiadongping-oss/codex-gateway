import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const html=fs.readFileSync(new URL('../../gateway/setup.html',import.meta.url),'utf8')
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1]
const KEY_A='cgw-fixture-A-000000',KEY_B='cgw-fixture-B-000000'
function page(origin,{secure=true,fetcher,choose=true,localOrigin}={}){
  const nodes=new Map(),copied=[],requests=[],appended=[]
  const node=id=>{
    if(!nodes.has(id))nodes.set(id,{id,textContent:'',value:'',hidden:false,disabled:false,style:{},listeners:{},children:[],setAttribute(name,value){this[name]=value},replaceChildren(){this.children=[]},appendChild(child){this.children.push(child)},change(value){this.value=value;return this.listeners.change?.call(this)},classList:{add(){},remove(){}},focus(){},select(){},addEventListener(name,fn){this.listeners[name]=fn},click(){return this.listeners.click?.()}})
    return nodes.get(id)
  }
  let created=0
  const document={getElementById:node,createElement:tag=>node(tag+'-'+(++created)),body:{appendChild(n){appended.push(n)},removeChild(){}},execCommand(){copied.push(appended.at(-1).value);return true}}
  const context=vm.createContext({URL,document,location:new URL(origin),window:{isSecureContext:secure},navigator:secure?{clipboard:{writeText(text){copied.push(text);return Promise.resolve()}}}:{},AbortController,setTimeout:()=>1,clearTimeout(){},fetch(url,options){requests.push({url,options});return fetcher?fetcher(url,options):Promise.resolve({ok:true,status:200,json:async()=>({ok:true,keyName:'Fixture',images:0,bytes:0})})}})
  vm.runInContext(fs.readFileSync(new URL('../../gateway/client-setup.js',import.meta.url),'utf8'),context)
  // 模拟 launcher 在伺服 /setup 时把锚点替换为网关本机规范地址；不给 localOrigin 时保留源码占位符。
  vm.runInContext(localOrigin ? script.replace('__CGW_LOCAL_ORIGIN__',localOrigin) : script,context)
  if(choose)node(new URL(origin).hostname==='127.0.0.1'?'targetLocal':'targetRemote').click()
  return {node,copied,requests,async verify(key){node('keyInput').value=key;node('btnVerify').click();await settle()}}
}
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve()}
test('verified local prompt preserves address/port, configures MCP and Skill, and does not generate images',async()=>{
  const p=page('http://127.0.0.1:4173')
  p.node('btnCopyAgentPrompt').click();assert.equal(p.copied.length,0)
  await p.verify(KEY_A)
  assert.ok(!p.node('agentPromptPreview').value.includes(KEY_A))
  assert.match(p.node('agentPromptPreview').value,/密 Key|当前已验证的 API Key/)
  p.node('btnCopyAgentPrompt').click()
  const prompt=p.copied[0]
  assert.match(prompt,/http:\/\/127\.0\.0\.1:4173\/mcp/)
  assert.match(prompt,/http:\/\/127\.0\.0\.1:4173\/lan-kit\/skills\/codex-gateway-image\/SKILL.md/)
  assert.equal(JSON.parse(prompt.match(/```json\n([\s\S]*?)\n```/)[1]).mcpServers['codex-gateway'].headers.Authorization,'Bearer '+KEY_A)
  for(const text of ['备份','保留其他连接器','同名条目','私有配置','不调用 generate_image','当前会话工具已加载','保留现有的其他模型设置','不要静默留下'])assert.ok(prompt.includes(text),text)
  assert.deepEqual(p.requests.map(r=>r.url),['/v1/gen-images/me'])
})
test('LAN prompt and HTTP clipboard fallback retain actual shared port and LAN connector name',async()=>{
  const p=page('http://192.0.2.5:5199',{secure:false})
  await p.verify(KEY_B);p.node('btnCopyAgentPrompt').click()
  const prompt=p.copied[0]
  const config=JSON.parse(prompt.match(/```json\n([\s\S]*?)\n```/)[1])
  assert.equal(config.mcpServers['codex-gateway-lan'].url,'http://192.0.2.5:5199/mcp')
  assert.match(prompt,/http:\/\/192\.0\.2\.5:5199\/gallery/)
  assert.match(prompt,/不需要安装 Codex Gateway、Node.js/)
  assert.match(p.node('connectionHint').textContent,/局域网用户/)
  assert.equal(p.node('mcpName').textContent,'codex-gateway-lan')
  p.node('btnCopyCmd').click();assert.match(p.copied.at(-1),/--name codex-gateway-lan --port 5199/)
  assert.match(p.node('lnkScript').href,/port=5199/)
})

test('loopback setup warns that copying localhost to other machines requires the shared host address',async()=>{
  const p=page('http://127.0.0.1:4173')
  assert.match(p.node('connectionHint').textContent,/仅限网关这台电脑/)
  await p.verify(KEY_A);p.node('btnCopyAgentPrompt').click()
  assert.match(p.copied[0],/连接被拒绝（10061）只证明所连接地址无监听/)
  assert.match(p.copied[0],/不能证明远程网关停机/)
})
test('failed verification cannot expose a prompt; switching identity discards a stale success',async()=>{
  const deferred=[]
  const p=page('http://127.0.0.1:4173',{fetcher:()=>new Promise(resolve=>deferred.push(resolve))})
  p.node('keyInput').value=KEY_A;p.node('btnVerify').click()
  p.node('btnChangeKey').click()
  p.node('keyInput').value=KEY_B;p.node('btnVerify').click()
  deferred[0]({status:200,ok:true,json:async()=>({ok:true,keyName:'Old'})});await settle()
  assert.equal(p.node('agentPromptPreview').value,'')
  p.node('btnCopyAgentPrompt').click();assert.equal(p.copied.length,0)
  deferred[1]({status:401,ok:false});await settle()
  assert.match(p.node('gateErr').textContent,/无效/)
  p.node('btnCopyAgentPrompt').click();assert.equal(p.copied.length,0)
  assert.equal(p.node('mcpJson').textContent,'')
})


test('update Prompt preserves credentials and user settings, verifies hashes, reloads MCP, and migrates the Skill name',async()=>{
  const p=page('http://192.0.2.5:5199')
  await p.verify(KEY_A);p.node('btnCopyUpdatePrompt').click()
  const prompt=p.copied[0]
  for(const text of ['请更新','范围限制','仅端口相同不算匹配','/client-assets.json','SHA-256','保留现有凭据','tools/list','不重复新增','当前会话已重新加载','Skill 发现目录之外','skills/gpt-image/SKILL.md','GPT 图片生成'])assert.ok(prompt.includes(text),text)
  assert.ok(!prompt.includes(KEY_A))
  assert.ok(!prompt.includes('Authorization":'))
  assert.ok(!p.node('agentPromptPreview').value.includes(KEY_A))
})


test('setup requires an explicit user type and cannot verify or copy credentials before selecting one',async()=>{
  const p=page('http://127.0.0.1:4173',{choose:false})
  await p.verify(KEY_A);p.node('btnCopyAgentPrompt').click()
  assert.equal(p.requests.length,0);assert.equal(p.copied.length,0)
  assert.match(p.node('gateErr').textContent,/先选择接入用户类型/)
})

test('gateway-local setup generates a LAN prompt with discovered shared address, while Key verification remains same-origin',async()=>{
  const p=page('http://127.0.0.1:4173',{fetcher:(url,options)=>Promise.resolve({ok:true,status:200,json:async()=>url==='/client-connection.json'?{sharingEnabled:true,sharedOrigins:[{origin:'http://192.0.2.5:5199',preferred:true},{origin:'http://100.64.0.2:5199'}]}:{ok:true,keyName:'Fixture',images:0,bytes:0}})})
  p.node('targetRemote').click();await settle()
  assert.equal(p.node('sharedBase').value,'http://192.0.2.5:5199')
  await p.verify(KEY_A);p.node('btnCopyAgentPrompt').click()
  const text=p.copied[0],config=JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)[1])
  assert.equal(config.mcpServers['codex-gateway-lan'].url,'http://192.0.2.5:5199/mcp')
  for(const route of ['/lan-kit/skills/codex-gateway-image/SKILL.md','/gallery','/client-assets.json'])assert.ok(text.includes('http://192.0.2.5:5199'+route))
  assert.equal(p.node('lnkSkill').href,'http://192.0.2.5:5199/lan-kit/skills/codex-gateway-image/SKILL.md')
  assert.match(p.node('lnkScript').href,/http:\/\/192\.0\.2\.5:5199/)
  assert.deepEqual(p.requests.map(r=>r.url),['/client-connection.json','/v1/gen-images/me'])
  assert.equal(p.requests[0].options.headers,undefined,'discovery never carries the API Key')
  p.node('sharedBase').change('http://100.64.0.2:5199');p.node('btnCopyAgentPrompt').click()
  assert.equal(p.copied.length,1,'changing the shared target invalidates previous credentials and copied configuration')
  await p.verify(KEY_A);p.node('btnCopyMcp').click()
  assert.equal(JSON.parse(p.copied[1]).mcpServers['codex-gateway-lan'].url,'http://100.64.0.2:5199/mcp')
})

test('sharing disabled, discovery failure, or a loopback-only response cannot silently produce a local prompt for a LAN user',async()=>{
  for(const info of [{sharingEnabled:false,sharedOrigins:[]},{sharingEnabled:true,sharedOrigins:[{origin:'http://127.0.0.1:4173'}]}]){
    const p=page('http://127.0.0.1:4173',{fetcher:()=>Promise.resolve({ok:true,status:200,json:async()=>info})})
    p.node('targetRemote').click();await settle();await p.verify(KEY_A);p.node('btnCopyAgentPrompt').click()
    assert.equal(p.node('btnVerify').disabled,true);assert.equal(p.copied.length,0)
    assert.equal(p.requests.length,1,'only address discovery runs when no usable shared address exists')
  }
  const p=page('http://127.0.0.1:4173',{fetcher:()=>Promise.reject(new Error('offline'))})
  p.node('targetRemote').click();await settle();await p.verify(KEY_A)
  assert.equal(p.copied.length,0);assert.equal(p.node('btnVerify').disabled,true)
})

test('switching user type while address discovery is pending ignores the late result',async()=>{
  let finish
  const p=page('http://127.0.0.1:4173',{fetcher:url=>url==='/client-connection.json'?new Promise(resolve=>finish=resolve):Promise.resolve({ok:true,status:200,json:async()=>({ok:true,images:0,bytes:0})})})
  p.node('targetRemote').click();p.node('targetLocal').click()
  finish({ok:true,status:200,json:async()=>({sharingEnabled:true,sharedOrigins:[{origin:'http://192.0.2.5:5199'}]})});await settle()
  await p.verify(KEY_A);p.node('btnCopyMcp').click()
  assert.equal(JSON.parse(p.copied[0]).mcpServers['codex-gateway'].url,'http://127.0.0.1:4173/mcp')
})


test('public setup separates secret-free updates from explicit Key replacement',async()=>{
  const p=page('http://192.0.2.5:5199')
  await p.verify(KEY_A);p.node('btnCopyUpdatePrompt').click();const updateA=p.copied.at(-1)
  await p.verify('cgw-fixture-B');p.node('btnCopyUpdatePrompt').click();assert.equal(p.copied.at(-1),updateA)
  p.node('btnCopySwitchKeyPrompt').click();const replacement=p.copied.at(-1)
  assert.match(replacement,/Bearer cgw-fixture-B/);assert.ok(!replacement.includes(KEY_A))
  assert.match(replacement,/旧图不会自动迁移/);assert.match(replacement,/当前会话尚未切换/)
  assert.match(replacement,/范围限制/);assert.match(replacement,/仅端口相同不算匹配/)
  assert.match(replacement,/指定连接器：codex-gateway-lan/)
  assert.doesNotMatch(replacement,/禁止转发给其他设备/)
})

test('loopback switch-key Prompt bans forwarding and requires a full address match',async()=>{
  const p=page('http://127.0.0.1:4173')
  await p.verify(KEY_A);p.node('btnCopySwitchKeyPrompt').click()
  const prompt=p.copied[0]
  assert.match(prompt,/目标网关：http:\/\/127\.0\.0\.1:4173/)
  assert.match(prompt,/禁止转发给其他设备/)
  assert.match(prompt,/指定连接器：codex-gateway/)
  assert.match(prompt,/不得按端口猜测或改写地址/)
  assert.match(prompt,/仅端口相同但主机地址不同的连接不算匹配/)
})

test('loopback update Prompt also bans forwarding without embedding a Key',async()=>{
  const p=page('http://127.0.0.1:4173')
  await p.verify(KEY_A);p.node('btnCopyUpdatePrompt').click()
  assert.match(p.copied[0],/禁止转发给其他设备/)
  assert.ok(!p.copied[0].includes(KEY_A))
})

test('shared-port loopback setup refuses local user mode and points at the canonical local page',async()=>{
  const p=page('http://127.0.0.1:4174',{localOrigin:'http://127.0.0.1:4173'})
  assert.match(p.node('connectionHint').textContent,/共享端口的回环页/)
  assert.match(p.node('connectionHint').textContent,/http:\/\/127\.0\.0\.1:4173\/setup/)
  assert.equal(p.node('btnVerify').disabled,true)
  await p.verify(KEY_A);p.node('btnCopyAgentPrompt').click();p.node('btnCopySwitchKeyPrompt').click()
  assert.equal(p.requests.length,0,'没有选定有效目标前不能验证 Key')
  assert.equal(p.copied.length,0)
  assert.equal(p.node('mcpJson').textContent,'')
})

test('blocked shared-port page can still switch to a LAN user and generate a shared-address switch prompt',async()=>{
  const p=page('http://127.0.0.1:4174',{localOrigin:'http://127.0.0.1:4173',fetcher:url=>Promise.resolve({ok:true,status:200,json:async()=>url==='/client-connection.json'?{sharingEnabled:true,sharedOrigins:[{origin:'http://192.0.2.5:5199',preferred:true}]}:{ok:true,keyName:'Fixture',images:0,bytes:0}})})
  p.node('targetRemote').click();await settle()
  assert.equal(p.node('sharedBase').value,'http://192.0.2.5:5199')
  await p.verify(KEY_B);p.node('btnCopySwitchKeyPrompt').click()
  const prompt=p.copied.at(-1)
  assert.match(prompt,/目标网关：http:\/\/192\.0\.2\.5:5199/)
  assert.match(prompt,/指定连接器：codex-gateway-lan/)
  assert.doesNotMatch(prompt,/禁止转发给其他设备/)
})

test('uninstall Prompt is reachable without verifying any Key and never embeds credentials',async()=>{
  const p=page('http://127.0.0.1:4174',{localOrigin:'http://127.0.0.1:4173',fetcher:url=>Promise.resolve({ok:true,status:200,json:async()=>url==='/client-connection.json'?{sharingEnabled:true,sharedOrigins:[{origin:'http://192.0.2.5:5199',preferred:true}]}:{ok:true,keyName:'Fixture',images:0,bytes:0}})})
  p.node('targetRemote').click();await settle()
  p.node('btnCopyUninstallPromptGate').click()
  assert.equal(p.copied.length,1,'没有有效 Key 也必须能卸载')
  const text=p.copied[0]
  assert.match(text,/目标网关：http:\/\/192\.0\.2\.5:5199/)
  assert.match(text,/完全卸载/);assert.match(text,/不含任何 API Key/)
  assert.match(text,/先备份/);assert.match(text,/不删除图片/)
  assert.doesNotMatch(text,/Bearer |"Authorization"/)
  assert.ok(!text.includes(KEY_A) && !text.includes(KEY_B))
  p.node('btnCopyUninstallPrompt').click()
  assert.equal(p.copied.length,2);assert.equal(p.copied[0],p.copied[1])
})

test('canonical local page still allows local mode when the injected local origin matches',async()=>{
  const p=page('http://127.0.0.1:4173',{localOrigin:'http://127.0.0.1:4173'})
  await p.verify(KEY_A);p.node('btnCopyAgentPrompt').click()
  assert.equal(JSON.parse(p.copied[0].match(/```json\n([\s\S]*?)\n```/)[1]).mcpServers['codex-gateway'].url,'http://127.0.0.1:4173/mcp')
})
