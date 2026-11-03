// Exercises full generated NSIS scripts with isolated product/registry names
// and a harmless app stub. Never starts the production desktop/data workspace.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import {spawn,spawnSync} from 'node:child_process'

const options=Object.fromEntries(process.argv.slice(2).map(a=>{const n=a.indexOf('=');if(n<0)throw Error('Use --old-nsis= --new-nsis= --report=');return[a.slice(0,n),a.slice(n+1)]}))
for(const name of ['--old-nsis','--new-nsis','--report'])if(!options[name])throw Error('Missing '+name)
if(process.platform!=='win32')throw Error('Windows required')
const reportFile=path.resolve(options['--report']);if(fs.existsSync(reportFile))throw Error('Report already exists')
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cgw-full-upgrade-')),owned=fs.realpathSync(root),install=path.join(root,'安装目录 with spaces')
const id='CGWUpgradeFixture-'+crypto.randomUUID(),namespace='Software\\'+id
const registry='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+id
const settings='HKCU\\Software\\'+id+'\\'+id
const compiler=path.join(process.env.LOCALAPPDATA,'tauri/NSIS/makensis.exe'),children=[]
const report={status:'running',scope:'Full generated old/new NSIS scripts; isolated product/registry identity; harmless running app stub; no production desktop launch',steps:[],testRoot:root}
const hash=b=>crypto.createHash('sha256').update(b).digest('hex')
const readHash=f=>hash(fs.readFileSync(f))
const escape=v=>v.replaceAll('$','$$').replaceAll('"','$\\"')
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const run=(exe,args,extra={})=>{const r=spawnSync(exe,args,{windowsHide:true,encoding:'utf8',timeout:120000,maxBuffer:1024*1024,...extra});if(r.error)throw r.error;assert.equal(r.status,0,r.stdout+'\n'+r.stderr);return r}
const runSetup=(exe,args)=>run(exe,args,{windowsVerbatimArguments:true})
const alive=child=>child.exitCode===null&&child.signalCode===null
async function until(p){for(let n=0;n<100;n++){if(p())return;await sleep(100)}throw Error('Owned app fixture did not reach expected state')}
const record=(name,extra={})=>{report.steps.push({name,status:'passed',...extra});console.log('PASS '+name)}
function registration(){const r=run('reg.exe',['query',registry,'/v','DisplayVersion']);return r.stdout.match(/REG_SZ\s+([^\r\n]*)/)?.[1]}

// NSIS File preserves its input basename, so retain the production filename.
const helper=path.join(root,'codex-gateway-desktop.exe'),ready=path.join(root,'owned.ready')
const ps=path.join(root,'build-app.ps1')
fs.writeFileSync(ps,`Add-Type -TypeDefinition 'using System.IO; using System.Threading; public class Fixture { public static void Main(string[] args) { File.WriteAllText(args[0],"ready"); while(true) Thread.Sleep(500); } }' -OutputAssembly '${helper.replaceAll("'","''")}' -OutputType WindowsApplication\n`)
run('powershell.exe',['-NoProfile','-NonInteractive','-File',ps])
fs.writeFileSync(path.join(root,'obsolete.mjs'),'// Fixture owned by the old installer only.\n')
const data=path.join(root,'independent-data');fs.mkdirSync(data)
for(const [name,value]of Object.entries({'accounts.json':'{"fixture":true}','settings.json':'{"fixture":true}','image.png':'fixture image bytes'}))fs.writeFileSync(path.join(data,name),value)
const originals=new Map(fs.readdirSync(data).map(f=>[f,readHash(path.join(data,f))]))

function compile(generated,name,legacy){
  const dir=path.join(root,name);fs.mkdirSync(dir)
  let script=fs.readFileSync(path.join(generated,'installer.nsi'),'utf8').replaceAll('\r\n','\n')
  const version=script.match(/^!define VERSION "([^"]+)"$/m)?.[1];assert.ok(version)
  for(const file of ['utils.nsh','FileAssociation.nsh','English.nsh','SimpChinese.nsh'])fs.copyFileSync(path.join(generated,file),path.join(dir,file))
  const originalHooks=script.match(/^!include "([^\n"]*hooks\.nsh)"$/m)?.[1];assert.ok(originalHooks)
  let hooks=fs.readFileSync(originalHooks,'utf8').replaceAll('\r\n','\n')
  hooks=hooks.replaceAll('Software\\Microsoft\\Windows\\CurrentVersion\\Run',namespace+'\\Run')
    .replaceAll('Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run',namespace+'\\Approved')
  fs.writeFileSync(path.join(dir,'hooks.nsh'),hooks)
  const upgrade=path.join(path.dirname(originalHooks),'upgrade.nsh')
  if(fs.existsSync(upgrade))fs.copyFileSync(upgrade,path.join(dir,'upgrade.nsh'))
  script=script.replace(/^!include "[^\n"]*hooks\.nsh"$/m,'!include "'+escape(path.join(dir,'hooks.nsh'))+'"')
  const output=path.join(dir,name+'-setup.exe')
  for(const [key,value]of Object.entries({PRODUCTNAME:id,MANUFACTURER:id,BUNDLEID:'com.cgw.upgradefixture.'+id.toLowerCase(),OUTFILE:output,MAINBINARYSRCPATH:helper,DISPLAYLANGUAGESELECTOR:'false'})){
    const expression=new RegExp('^!define '+key+' .*$', 'm');assert.ok(expression.test(script),key)
    script=script.replace(expression,()=>'!define '+key+' "'+escape(value)+'"')
  }
  if(legacy){
    const copy='  ; Copy main executable\n  File "${MAINBINARYSRCPATH}"'
    assert.ok(script.includes(copy));script=script.replace(copy,copy+'\n  File /oname=obsolete-owned.mjs "'+escape(path.join(root,'obsolete.mjs'))+'"')
    const removal='  Delete "$INSTDIR\\${MAINBINARYNAME}.exe"'
    assert.ok(script.includes(removal));script=script.replace(removal,removal+'\n  Delete "$INSTDIR\\obsolete-owned.mjs"')
  }
  const file=path.join(dir,'installer.nsi');fs.writeFileSync(file,script)
  run(compiler,['/INPUTCHARSET','UTF8','/V2',file],{cwd:dir})
  return {file:output,version}
}
function verifyResources(version){
  const base=path.join(install,'gateway-resources'),manifest=JSON.parse(fs.readFileSync(path.join(base,'DESKTOP-RESOURCES.json')))
  assert.equal(manifest.appVersion,version)
  for(const [name,entry]of Object.entries(manifest.files)){
    const file=path.join(base,name);assert.equal(fs.statSync(file).size,entry.bytes,name);assert.equal(readHash(file),entry.sha256,name)
  }
  assert.equal(readHash(path.join(install,'codex-gateway-desktop.exe')),readHash(helper))
  return Object.keys(manifest.files).length
}
function assertCanaries(){for(const [f,h]of originals)assert.equal(readHash(path.join(data,f)),h);assert.equal(fs.readFileSync(path.join(install,'unknown-user-file.txt'),'utf8'),'keep');assert.equal(fs.readFileSync(path.join(install,'gateway-resources','custom-user-file.txt'),'utf8'),'keep')}
try {
  const old=compile(path.resolve(options['--old-nsis']),'old',true),next=compile(path.resolve(options['--new-nsis']),'new',false)
  assert.notEqual(old.version,next.version)
  runSetup(old.file,['/S','/UPDATE','/NS','/D='+install]);assert.equal(registration(),old.version)
  record('old-full-installer',{version:old.version,verifiedFiles:verifyResources(old.version)})
  fs.writeFileSync(path.join(install,'unknown-user-file.txt'),'keep');fs.writeFileSync(path.join(install,'gateway-resources','custom-user-file.txt'),'keep')
  const marker=path.join(root,'unrelated.ready'),unrelatedExe=path.join(root,'unrelated-app.exe');fs.copyFileSync(helper,unrelatedExe)
  const unrelated=spawn(unrelatedExe,[marker],{windowsHide:true,stdio:'ignore'});children.push(unrelated);await until(()=>fs.existsSync(marker))
  const app=spawn(path.join(install,'codex-gateway-desktop.exe'),[ready],{windowsHide:true,stdio:'ignore'});children.push(app);await until(()=>fs.existsSync(ready))
  runSetup(next.file,['/P','/UPDATE','/NS','/D='+install]);await until(()=>!alive(app));assert.ok(alive(unrelated))
  assert.equal(registration(),next.version);assert.equal(fs.existsSync(path.join(install,'obsolete-owned.mjs')),false)
  assertCanaries();record('automatic-upgrade-with-running-app',{from:old.version,to:next.version,verifiedFiles:verifyResources(next.version),dataAndUnknownFilesPreserved:true,unrelatedProcessPreserved:true})
  assert.equal(run(path.join(install,'gateway-resources/runtime/node.exe'),['--version']).stdout.trim(),'v22.22.2')
  record('installed-node-runtime')
  runSetup(path.join(install,'uninstall.exe'),['/S','_?='+install])
  assertCanaries();assert.equal(fs.existsSync(path.join(install,'codex-gateway-desktop.exe')),false)
  record('normal-uninstall-preserves-data-and-unknown-files')
  report.status='passed'
} catch(e){report.status='failed';report.error=e.stack;throw e}
finally {
  for(const child of children)if(alive(child))child.kill()
  await sleep(300)
  // Only the fresh fixture's registry namespaces and verified temporary root.
  for(const key of [registry,settings,'HKCU\\'+namespace])spawnSync('reg.exe',['delete',key,'/f'],{windowsHide:true,stdio:'ignore'})
  assert.equal(fs.realpathSync(root),owned);assert.equal(path.dirname(owned),fs.realpathSync(os.tmpdir()))
  if(report.status==='passed')fs.rmSync(owned,{recursive:true,force:true})
  fs.mkdirSync(path.dirname(reportFile),{recursive:true});fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n')
  console.log('Upgrade verification report: '+reportFile)
}
