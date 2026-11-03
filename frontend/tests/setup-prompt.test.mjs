import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const html=fs.readFileSync(new URL('../../gateway/setup.html',import.meta.url),'utf8')
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1]
const KEY_A='cgw-fixture-A-000000',KEY_B='cgw-fixture-B-000000'
function page(origin,{secure=true,fetcher}={}){
  const nodes=new Map(),copied=[],requests=[],appended=[]
  const node=id=>{
    if(!nodes.has(id))nodes.set(id,{id,textContent:'',value:'',hidden:false,disabled:false,style:{},listeners:{},classList:{add(){},remove(){}},focus(){},select(){},addEventListener(name,fn){this.listeners[name]=fn},click(){return this.listeners.click?.()}})
    return nodes.get(id)
  }
  const document={getElementById:node,createElement:()=>node('clipboard-fallback'),body:{appendChild(n){appended.push(n)},removeChild(){}},execCommand(){copied.push(appended.at(-1).value);return true}}
  const context=vm.createContext({URL,document,location:new URL(origin),window:{isSecureContext:secure},navigator:secure?{clipboard:{writeText(text){copied.push(text);return Promise.resolve()}}}:{},AbortController,setTimeout:()=>1,clearTimeout(){},fetch(url,options){requests.push({url,options});return fetcher?fetcher(url,options):Promise.resolve({ok:true,status:200,json:async()=>({ok:true,keyName:'Fixture',images:0,bytes:0})})}})
  vm.runInContext(fs.readFileSync(new URL('../../gateway/client-setup.js',import.meta.url),'utf8'),context)
  vm.runInContext(script,context)
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
  for(const text of ['备份','保留其他连接器','同名条目','私有配置','不调用 generate_image','当前会话工具已加载','保留现有对话模型设置'])assert.ok(prompt.includes(text),text)
  assert.deepEqual(p.requests.map(r=>r.url),['/v1/gen-images/me'])
})
test('LAN prompt and HTTP clipboard fallback retain actual shared port and LAN connector name',async()=>{
  const p=page('http://192.0.2.5:5199',{secure:false})
  await p.verify(KEY_B);p.node('btnCopyAgentPrompt').click()
  const prompt=p.copied[0]
  const config=JSON.parse(prompt.match(/```json\n([\s\S]*?)\n```/)[1])
  assert.equal(config.mcpServers['codex-gateway-lan'].url,'http://192.0.2.5:5199/mcp')
  assert.match(prompt,/http:\/\/192\.0\.2\.5:5199\/gallery/)
  assert.equal(p.node('mcpName').textContent,'codex-gateway-lan')
  p.node('btnCopyCmd').click();assert.match(p.copied.at(-1),/--name codex-gateway-lan --port 5199/)
  assert.match(p.node('lnkScript').href,/port=5199/)
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
  for(const text of ['请更新','/client-assets.json','SHA-256','保留现有凭据','tools/list','不重复新增','当前会话已重新加载','Skill 发现目录之外','skills/gpt-image/SKILL.md','GPT 图片生成'])assert.ok(prompt.includes(text),text)
  assert.match(prompt,/Bearer cgw-fixture-A/)
  assert.ok(!p.node('agentPromptPreview').value.includes(KEY_A))
})
