// Exact installed migration worker and Node; never launch release UI into a real profile.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { verifyDesktop } from '../prepare-desktop.mjs'
import { desktopFixture } from '../gateway/tests/lib/desktop-fixture.mjs'

const args=process.argv.slice(2)
assert.ok(args.every(a=>a.startsWith('--resources=')||a.startsWith('--report=')))
const option=name=>args.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3)
assert.ok(option('resources')&&option('report'),'--resources and --report required')
const resources=fs.realpathSync(option('resources')), reportFile=path.resolve(option('report'))
assert.ok(!fs.existsSync(reportFile),'Do not overwrite evidence')
const manifest=verifyDesktop({target:`${process.platform}-${process.arch}`,outDir:resources})
const node=path.join(resources,manifest.node), worker=path.join(resources,'desktop/migration-service.mjs')
const tempBase=fs.realpathSync(os.tmpdir()), root=fs.mkdtempSync(path.join(tempBase,'cgw-installed-migration-'))
const source=path.join(root,'旧 数据'), gallery=path.join(root,'旧 图库'), target=path.join(root,'新 数据'), home=path.join(root,'home')
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
const report={status:'running',scope:'installed bundled worker and gateway; no release window, real accounts or upstream requests',startedAt:new Date().toISOString(),resourcesManifestSha256:hash(fs.readFileSync(path.join(resources,'DESKTOP-RESOURCES.json'))),steps:[],releaseWindowTested:false,realDataMigrated:false}
const save=()=>fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n')
const put=(base,relative,value)=>{const file=path.join(base,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value))}
function inventory(dir){
 const entries={}
 const walk=(current,prefix='')=>{for(const name of fs.readdirSync(current).sort()){const file=path.join(current,name),stat=fs.lstatSync(file);assert.ok(!stat.isSymbolicLink());if(stat.isDirectory())walk(file,prefix+name+'/');else entries[prefix+name]=hash(fs.readFileSync(file))}}
 walk(dir);return entries
}
const env={...process.env}
for(const key of Object.keys(env))if(/^(CGW_|CHATGPT_|CODEX_HOME$|NODE_OPTIONS$|NODE_PATH$|LAUNCHER_PORT$|BRIDGE_|API_PROVIDERS_STORE_PATH$|ASSETS_STORE_PATH$)/.test(key))delete env[key]
Object.assign(env,{HOME:home,USERPROFILE:home,APPDATA:home,LOCALAPPDATA:home})
function call(request,expectedCode){
 const reply=spawnSync(node,[worker,target,resources],{input:JSON.stringify(request),encoding:'utf8',env,windowsHide:true,timeout:120000,maxBuffer:65536})
 assert.equal(reply.error,undefined);assert.equal(reply.stderr,'')
 const result=JSON.parse(reply.stdout)
 if(expectedCode){assert.equal(reply.status,1);assert.equal(result.code,expectedCode)}
 else{assert.equal(reply.status,0,reply.stdout);assert.equal(result.ok,true)}
 return result
}
function step(name){report.steps.push({name,status:'passed'});save()}
let fixture
try{
 fs.mkdirSync(home)
 put(source,'accounts.json',{activeId:null,accounts:[]})
 put(source,'data/call-logs.json',[])
 put(source,'references/保留.txt','installed migration fixture')
 put(gallery,'index.json',{'fixture.png':{keyId:'fixture-owner',createdAt:1}})
 fs.writeFileSync(path.join(gallery,'fixture.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC6kAAAAASUVORK5CYII=','base64'))
 const sourceBefore=inventory(source),galleryBefore=inventory(gallery),selection={sourceRoot:source,sourceKind:'data',galleryRoot:gallery}
 assert.equal(call({operation:'context'}).targetExists,false)
 let plan=call({operation:'plan',selection})
 call({operation:'apply',selection,fingerprint:plan.fingerprint,sourceStopped:false},'MIGRATION_STOP_CONFIRMATION_REQUIRED')
 assert.equal(fs.existsSync(target),false);step('plan-and-stop-confirmation')
 const apply=()=>call({operation:'apply',selection,fingerprint:plan.fingerprint,sourceStopped:true})
 let migrated=apply();assert.equal(migrated.phase,'committed')
 assert.equal(fs.readFileSync(path.join(target,'accounts.json'),'utf8'),fs.readFileSync(path.join(source,'accounts.json'),'utf8'))
 assert.deepEqual(inventory(path.join(target,'gen-images')),galleryBefore)
 assert.equal(call({operation:'rollback',archive:migrated.archive,sourceStopped:true}).phase,'aborted')
 assert.equal(fs.existsSync(target),false);step('migrate-and-rollback')
 plan=call({operation:'plan',selection});migrated=apply()
 assert.equal(migrated.phase,'committed');step('migrate-again')
 fixture=await desktopFixture({resources,node,root,dataRoot:target})
 await fixture.start();await fixture.login()
 const response=await fixture.request('/__gw/accounts');assert.equal(response.status,200);await response.arrayBuffer()
 await fixture.command('shutdown',{reason:'user_exit'})
 assert.equal((await fixture.wait(f=>f.type==='stopped')).payload.outcome,'graceful')
 assert.equal((await fixture.exitWithin())[0],0)
 assert.equal(fs.existsSync(path.join(target,'runtime/owner.lock')),false)
 step('migrated-gateway-start-bootstrap-and-graceful-exit')
 put(target,'data/new-history.json',{entry:'keep-new-data'})
 const afterStart=inventory(target)
 call({operation:'rollback',archive:migrated.archive,sourceStopped:true},'MIGRATION_CONTENT_CHANGED')
 assert.deepEqual(inventory(target),afterStart);step('refuse-rollback-after-new-writes')
 assert.deepEqual(inventory(source),sourceBefore);assert.deepEqual(inventory(gallery),galleryBefore)
 verifyDesktop({target:`${process.platform}-${process.arch}`,outDir:resources})
 assert.equal(hash(fs.readFileSync(path.join(resources,'DESKTOP-RESOURCES.json'))),report.resourcesManifestSha256)
 report.sourceAndGalleryUnchanged=true;report.resourcesUnchanged=true
 step('preserve-source-gallery-and-installed-resources');report.status='passed'
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1}
finally{
 if(fixture)await fixture.stop()
 if(report.status==='passed'){
  const resolved=fs.realpathSync(root)
  assert.equal(resolved,root);assert.equal(path.dirname(resolved),tempBase);assert.ok(path.basename(resolved).startsWith('cgw-installed-migration-'))
  fs.rmSync(resolved,{recursive:true,force:true});report.temporaryDataRemoved=true
 }else report.preservedTestRoot=root
 report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,steps:report.steps.length,report:reportFile}))
}
