// Windows managed-gateway endurance probe. No release GUI, real accounts or upstream calls.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {verifyDesktop} from '../prepare-desktop.mjs'
import {desktopFixture,sleep} from '../gateway/tests/lib/desktop-fixture.mjs'

const args=process.argv.slice(2)
if(args.includes('--help')){
 console.log('node desktop/stability.mjs --resources=<fixed resource tree> --report=<new JSON file> [--cycles=20] [--idle-ms=1000]\nWindows only. Sequential bundled Node restarts on the same disposable data. Idle duration applies per cycle; long runs are opt-in. Measures only the owned gateway process, not Tauri/WebView/bridge or a loaded workload.');process.exit(0)
}
assert.ok(args.every(a=>/^--(?:resources|report|cycles|idle-ms)=/.test(a)),'Unknown option')
const option=name=>args.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3)
assert.ok(option('resources')&&option('report'),'--resources and --report required')
assert.equal(process.platform,'win32','Resource sampler currently supports Windows only')
const cycles=Number(option('cycles')??20), idleMs=Number(option('idle-ms')??1000)
assert.ok(Number.isInteger(cycles)&&cycles>=1&&cycles<=1000)
assert.ok(Number.isInteger(idleMs)&&idleMs>=1000&&idleMs<=8*60*60*1000)
const resources=fs.realpathSync(option('resources')),reportFile=path.resolve(option('report'))
assert.ok(!fs.existsSync(reportFile),'Refuse to overwrite prior evidence')
const manifest=verifyDesktop({target:'win32-x64',outDir:resources}),node=path.join(resources,manifest.node)
const resourceHash=crypto.createHash('sha256').update(fs.readFileSync(path.join(resources,'DESKTOP-RESOURCES.json'))).digest('hex')
const tempBase=fs.realpathSync(os.tmpdir()),root=fs.mkdtempSync(path.join(tempBase,'cgw-stability-'))
const dataRoot=path.join(root,'数据 with spaces'),sentinel=path.join(dataRoot,'references/stability-retained.txt'),sentinelText='Disposable stability persistence probe'
const report={status:'running',startedAt:new Date().toISOString(),scope:'sequential managed bundled gateway; same disposable data root; no Tauri/WebView or upstream workload',resources,resourceManifestSha256:resourceHash,nodeVersion:manifest.runtime.version,cyclesRequested:cycles,idleMsPerCycle:idleMs,rounds:[],eightHourRun:false,realAccounts:false,releaseGui:false,systemSleepOrNetworkChanges:false,measurementScope:'Windows Get-Process of owned Node PID only; peakWorkingSet is OS lifetime high-water mark; CPU percent is one-core equivalent over measured idle interval'}
const save=()=>fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n')
function sample(fixture){
 assert.equal(fixture.child.exitCode,null)
 const script="$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $p=Get-Process -Id $env:CGW_STABILITY_PID; [ordered]@{pid=$p.Id;at=[DateTime]::UtcNow.ToString('o');workingSetBytes=$p.WorkingSet64;peakWorkingSetBytes=$p.PeakWorkingSet64;privateBytes=$p.PrivateMemorySize64;cpuSeconds=$p.TotalProcessorTime.TotalSeconds;handles=$p.HandleCount;threads=$p.Threads.Count}|ConvertTo-Json -Compress"
 const raw=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true,timeout:10000,env:{...process.env,CGW_STABILITY_PID:String(fixture.child.pid)}})
 const result=JSON.parse(raw);assert.equal(result.pid,fixture.child.pid);assert.equal(fixture.child.exitCode,null);return result
}
let fixture
try{
 for(let round=1;round<=cycles;round++){
  const started=performance.now(),entry={round,status:'running'};report.rounds.push(entry);save()
  fixture=await desktopFixture({resources,node,root,dataRoot})
  const ready=await fixture.start();entry.readyMs=Math.round(performance.now()-started)
  assert.notEqual(new URL(ready.origin).port,'4173');assert.equal(ready.dataRoot,dataRoot)
  await fixture.login()
  const response=await fixture.request('/__gw/accounts');assert.equal(response.status,200);await response.arrayBuffer()
  if(round===1)fs.writeFileSync(sentinel,sentinelText,{flag:'wx'})
  assert.equal(fs.readFileSync(sentinel,'utf8'),sentinelText)
  entry.beforeIdle=sample(fixture)
  // Bounded sleep increments keep the process responsive; no background job is detached.
  const idleEnd=performance.now()+idleMs
  while(performance.now()<idleEnd){await sleep(Math.min(1000,idleEnd-performance.now()));assert.equal(fixture.child.exitCode,null,'Gateway exited during idle')}
  entry.afterIdle=sample(fixture)
  const seconds=(Date.parse(entry.afterIdle.at)-Date.parse(entry.beforeIdle.at))/1000
  entry.idleCpuOneCorePercent=(entry.afterIdle.cpuSeconds-entry.beforeIdle.cpuSeconds)/seconds*100
  const stopping=performance.now()
  assert.equal((await fixture.command('shutdown',{reason:'user_exit'})).ok,true)
  const stopped=(await fixture.wait(f=>f.type==='stopped')).payload
  assert.equal(stopped.outcome,'graceful');assert.equal(stopped.persisted,true);assert.equal(stopped.childrenExited,true)
  assert.equal((await fixture.exitWithin())[0],0);entry.shutdownMs=Math.round(performance.now()-stopping)
  assert.equal(fs.existsSync(path.join(dataRoot,'runtime/owner.lock')),false)
  assert.equal(fs.readFileSync(sentinel,'utf8'),sentinelText)
  assert.equal(fixture.frames.some(f=>f.invalid),false)
  verifyDesktop({target:'win32-x64',outDir:resources})
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(resources,'DESKTOP-RESOURCES.json'))).digest('hex'),resourceHash)
  entry.gracefulExit=true;entry.lockReleased=true;entry.sentinelPreserved=true;entry.resourcesUnchanged=true;entry.status='passed';entry.elapsedMs=Math.round(performance.now()-started)
  fixture=null;save();console.log(`PASS round ${round}/${cycles}`)
 }
 report.status='passed'
 report.summary={completed:report.rounds.length,peakWorkingSetBytes:Math.max(...report.rounds.map(r=>r.afterIdle.peakWorkingSetBytes)),idleWorkingSetMinBytes:Math.min(...report.rounds.map(r=>r.afterIdle.workingSetBytes)),idleWorkingSetMaxBytes:Math.max(...report.rounds.map(r=>r.afterIdle.workingSetBytes)),maxIdleCpuOneCorePercent:Math.max(...report.rounds.map(r=>r.idleCpuOneCorePercent)),maxReadyMs:Math.max(...report.rounds.map(r=>r.readyMs)),maxShutdownMs:Math.max(...report.rounds.map(r=>r.shutdownMs))}
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1}
finally{
 if(fixture)await fixture.stop()
 if(report.status==='passed'){
  const resolved=fs.realpathSync(root);assert.equal(resolved,root);assert.equal(path.dirname(resolved),tempBase);assert.ok(path.basename(resolved).startsWith('cgw-stability-'))
  fs.rmSync(resolved,{recursive:true,force:true});report.temporaryDataRemoved=true
 }else report.preservedTestRoot=root
 report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,report:reportFile,summary:report.summary}))
}
