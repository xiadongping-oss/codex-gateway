import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {signUpdateArtifact,verifyUpdaterSignature,updaterSigningEnvironment} from './update-artifacts.mjs'

const desktop=path.dirname(fileURLToPath(import.meta.url))
const cli=path.join(desktop,'node_modules/@tauri-apps/cli/tauri.js')

test('actual Tauri signatures verify; tampered files, wrong versions and wrong keys cannot produce a publishable manifest',t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'cgw-updater-sign-'))
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}))
  const key=path.join(temp,'fixture.key'),installer=path.join(temp,'Fixture Setup.exe')
  execFileSync(process.execPath,[cli,'signer','generate','--ci','--password','','--write-keys',key],{stdio:'pipe',windowsHide:true})
  const pubkey=fs.readFileSync(key+'.pub','utf8').trim()
  fs.mkdirSync(path.join(temp,'src-tauri'));fs.writeFileSync(path.join(temp,'src-tauri/tauri.conf.json'),JSON.stringify({plugins:{updater:{pubkey}}}))
  fs.writeFileSync(installer,'non-executable updater test fixture')
  const env={...process.env,TAURI_SIGNING_PRIVATE_KEY:key,TAURI_SIGNING_PRIVATE_KEY_PASSWORD:''}
  const output=signUpdateArtifact({desktop:temp,installer,version:'2.0.0',notes:'测试更新',env,cli})
  const manifest=JSON.parse(fs.readFileSync(output.manifest,'utf8')),signature=fs.readFileSync(output.signature,'utf8')
  assert.equal(output.verified,true);assert.equal(manifest.version,'2.0.0');assert.equal(manifest.notes,'测试更新')
  assert.equal(manifest.platforms['windows-x86_64'].url,'https://github.com/xiadongping-oss/codex-gateway/releases/download/v2.0.0/Fixture%20Setup.exe')
  assert.equal(verifyUpdaterSignature(fs.readFileSync(installer),signature,pubkey,'2.0.0'),true)
  assert.throws(()=>verifyUpdaterSignature(Buffer.from('tampered'),signature,pubkey,'2.0.0'),/verification/)
  assert.throws(()=>verifyUpdaterSignature(fs.readFileSync(installer),signature,pubkey,'3.0.0'),/version mismatch/)
  const changed=Buffer.from(signature.trim(),'base64').toString().replace('version:2.0.0','version:3.0.0')
  assert.throws(()=>verifyUpdaterSignature(fs.readFileSync(installer),Buffer.from(changed).toString('base64'),pubkey,'3.0.0'),/verification/)
  fs.writeFileSync(path.join(temp,'src-tauri/tauri.conf.json'),JSON.stringify({plugins:{updater:{pubkey:Buffer.from('untrusted comment: test\n'+Buffer.alloc(42,1).toString('base64')).toString('base64')}}}))
  assert.throws(()=>signUpdateArtifact({desktop:temp,installer,version:'2.0.0',env,cli}),/Invalid updater/)
  assert.equal(signUpdateArtifact({desktop:temp,installer,version:'2.0.0',env:null}),null)
})

test('missing signing key never silently generates a feed',()=>{
  assert.equal(updaterSigningEnvironment({LOCALAPPDATA:path.join(os.tmpdir(),'missing-cgw-key-'+Date.now())}),null)
})

function ui() {
  const nodes=new Map(),calls=[]
  const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',hidden:false,disabled:false,attributes:{},classList:{toggle(){}},setAttribute(k,v){this.attributes[k]=v},removeAttribute(k){delete this.attributes[k]}});return nodes.get(id)}
  const window={__TAURI__:{core:{invoke:(command,args)=>new Promise((resolve,reject)=>calls.push({command,args,resolve,reject}))}}}
  const context=vm.createContext({window,document:{getElementById:node}})
  vm.runInContext(fs.readFileSync(path.join(desktop,'ui/updater-ui.js'),'utf8'),context)
  return {node,calls,update:window.cgwUpdaterUi.update}
}
test('UI reports failures honestly, shows progress and permits install retry only with verified cached bytes',async()=>{
  const page=ui(),base={currentVersion:'1.13.1',phase:'idle',version:null,notes:'',readyToInstall:false}
  page.update(base);assert.equal(page.node('updater-install').hidden,true)
  page.node('updater-check').onclick();assert.equal(page.calls[0].command,'workspace_update');assert.equal(page.calls[0].args.action,'check')
  page.node('updater-check').onclick();assert.equal(page.calls.length,1,'double clicks cannot overlap requests')
  page.calls[0].resolve({...base,phase:'error',error:'通道尚未发布'});await new Promise(resolve=>setImmediate(resolve))
  assert.match(page.node('updater-status').textContent,/通道尚未发布/);assert.doesNotMatch(page.node('updater-status').textContent,/已是最新/)
  page.update({...base,phase:'downloading',version:'2.0.0',downloaded:500,total:1000})
  assert.equal(page.node('updater-progress').value,50);assert.equal(page.node('updater-check').disabled,true)
  page.update({...base,phase:'error',version:'2.0.0',readyToInstall:true,error:'等待任务结束'})
  assert.equal(page.node('updater-install').hidden,false);assert.equal(page.node('updater-install').disabled,false);assert.equal(page.node('updater-download').hidden,true)
})

test('updater DOM contracts, private IPC boundary and signed-version requirement remain present',()=>{
  const html=fs.readFileSync(path.join(desktop,'ui/index.html'),'utf8'),script=fs.readFileSync(path.join(desktop,'ui/updater-ui.js'),'utf8')
  for(const [,id] of script.matchAll(/\$\('([^']+)'\)/g))assert.ok(html.includes(`id="${id}"`),id)
  const config=JSON.parse(fs.readFileSync(path.join(desktop,'src-tauri/tauri.conf.json')))
  assert.equal(config.plugins.updater.requireSignedVersion,true)
  assert.ok(config.plugins.updater.endpoints.every(url=>url.startsWith('https://github.com/xiadongping-oss/codex-gateway/')))
  const main=fs.readFileSync(path.join(desktop,'src-tauri/src/main.rs'),'utf8')
  assert.match(main,/async fn workspace_update[\s\S]*?local\(&window\)\?;[\s\S]*?updater::action/)
  assert.deepEqual(config.app.security.capabilities,[],'remote webviews receive no updater plugin permission')
})
