// Windows debug-only full-desktop soak. No release executable or real profile.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import {spawn, execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {verifyDesktop} from '../prepare-desktop.mjs'
import {freePort, sleep} from '../gateway/tests/lib/desktop-fixture.mjs'

const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('node desktop/soak.mjs --report=<new JSON> [--duration-ms=120000] [--interval-ms=15000] [--expected-exe-sha256=<sha256>] [--expected-resources-sha256=<sha256>]\nWindows debug only; maximum 8 hours. Copies the current debug EXE/resources into an owned cgw-soak-* fixture. Stop cooperatively by creating <report>.stop. Status remains running until normal native exit and cleanup. No sleep/network settings are changed. Working-set sums include shared pages; transient processes between samples can be missed.'); process.exit(0)
}
assert.equal(process.platform, 'win32')
assert.ok(args.every(arg => /^--(?:report|duration-ms|interval-ms|expected-exe-sha256|expected-resources-sha256)=/.test(arg)), 'Unknown option')
const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
assert.ok(option('report'), '--report required')
const durationMs = Number(option('duration-ms') ?? 120000), intervalMs = Number(option('interval-ms') ?? 15000)
assert.ok(Number.isInteger(durationMs) && durationMs >= 5000 && durationMs <= 28800000)
assert.ok(Number.isInteger(intervalMs) && intervalMs >= 5000 && intervalMs <= 60000)
const directory = path.dirname(fileURLToPath(import.meta.url)), reportFile = path.resolve(option('report'))
const samplesFile = reportFile + '.samples.ndjson', stderrFile = reportFile + '.stderr.log', stopFile = reportFile + '.stop'
for (const file of [reportFile, samplesFile, stderrFile, stopFile]) assert.ok(!fs.existsSync(file), 'Refuse to overwrite evidence or reuse a stop request')
fs.mkdirSync(path.dirname(reportFile), {recursive:true})
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const sourceExe = fs.realpathSync(path.join(directory, 'src-tauri/target/debug/codex-gateway-desktop.exe'))
const sourceResources = fs.realpathSync(path.join(path.dirname(sourceExe), 'gateway-resources'))
verifyDesktop({target:'win32-x64', outDir:sourceResources})
const executableSha256 = hash(sourceExe), resourceManifestSha256 = hash(path.join(sourceResources, 'DESKTOP-RESOURCES.json'))
for (const [name, actual] of [['expected-exe-sha256', executableSha256], ['expected-resources-sha256', resourceManifestSha256]]) {
  if (option(name)) assert.equal(actual, option(name), 'Pinned input changed')
}
const tempBase = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(tempBase, 'cgw-soak-'))
const bin = path.join(root, 'bin'), exe = path.join(bin, 'codex-gateway-desktop.exe'), resources = path.join(bin, 'gateway-resources')
const data = path.join(root, '数据 with spaces'), home = path.join(root, 'home')
const report = {schemaVersion:1, status:'preparing', startedAt:new Date().toISOString(), durationMsRequested:durationMs, intervalMs, sourceExe, sourceResources, executableSha256, resourceManifestSha256, root, reportFile, samplesFile, stderrFile, stopFile, sampleCount:0, ownershipEvidence:[], gaps:[], scope:'Debug Tauri shell, its observed descendants including gateway and WebView2; empty accounts and synthetic local gallery reads; no upstream workload', measurementNotes:'Working-set sums double-count shared pages. Sampled peaks are not continuous peaks. PID+creation-time identities and observed ancestry establish ownership; short-lived processes between samples may be missed. CPU is one-core equivalent.', releaseGui:false, realAccounts:false, systemSleepOrNetworkChanges:false, eightHourRun:false}
const save = () => { fs.writeFileSync(reportFile + '.tmp', JSON.stringify(report, null, 2) + '\n'); fs.renameSync(reportFile + '.tmp', reportFile) }
const run = promisify(execFile), known = new Map(), previousCpu = new Map()
let child, exitResult, cancelled = false, completed = false, forced = false
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { cancelled = true })
async function sample(stopOwned = false) {
  const result = await run('powershell.exe', ['-NoProfile','-NonInteractive','-OutputFormat','Text','-File',path.join(directory,'soak-processes.ps1'), ...(stopOwned ? ['-StopOwned'] : [])], {windowsHide:true, timeout:20000, maxBuffer:2*1024*1024, env:{...process.env, CGW_SOAK_PID:String(child.pid), CGW_SOAK_EXE:exe, CGW_SOAK_ROOT:root, CGW_SOAK_KNOWN:JSON.stringify([...known.values()].map(p => ({pid:p.pid,createdAt:p.createdAt})))}})
  const value = JSON.parse(result.stdout)
  for (const p of value.processes) {
    const id = `${p.pid}:${p.createdAt}`
    if (!known.has(id)) known.set(id, {...p, firstObservedAt:value.at})
  }
  return value
}
function nativeEvidence() {
  const file = path.join(root, 'soak-native.json')
  if (!fs.existsSync(file)) return null
  try { return {value:JSON.parse(fs.readFileSync(file,'utf8')), ageMs:Date.now()-fs.statSync(file).mtimeMs} } catch { return null }
}
async function waitExit(ms) {
  const deadline = Date.now() + ms
  while (!exitResult && Date.now() < deadline) await sleep(200)
  return Boolean(exitResult)
}
try {
  save(); fs.mkdirSync(bin); fs.mkdirSync(home)
  const roaming = path.join(home,'AppData/Roaming'), local = path.join(home,'AppData/Local')
  fs.mkdirSync(roaming,{recursive:true});fs.mkdirSync(local,{recursive:true})
  fs.copyFileSync(sourceExe, exe, fs.constants.COPYFILE_EXCL)
  fs.cpSync(sourceResources, resources, {recursive:true, errorOnExist:true, force:false})
  const manifest = verifyDesktop({target:'win32-x64', outDir:resources})
  assert.equal(hash(exe), executableSha256)
  assert.equal(hash(path.join(resources,'DESKTOP-RESOURCES.json')), resourceManifestSha256)
  const {resolveStoragePaths} = await import(pathToFileURL(path.join(resources,'gateway/storage-paths.mjs')))
  const {initializeStorage} = await import(pathToFileURL(path.join(resources,'gateway/storage-init.mjs')))
  const lease = initializeStorage(resolveStoragePaths({CGW_STORAGE_MODE:'managed',CGW_DATA_DIR:data}, path.join(resources,'gateway')))
  assert.equal(lease.release(),true)
  const token = `cgw-${crypto.randomBytes(32).toString('hex')}`, keyId = crypto.randomUUID()
  fs.writeFileSync(path.join(data,'accounts.json'), JSON.stringify({activeId:null,accounts:[]}))
  fs.writeFileSync(path.join(data,'api-keys.json'), JSON.stringify({keys:[{id:keyId,name:'Disposable desktop soak',hash:crypto.createHash('sha256').update(token).digest('hex'),accountIds:null,accountId:null,createdAt:new Date().toISOString(),disabled:false,callCount:0}]}))
  fs.writeFileSync(path.join(root,'soak-config.json'), JSON.stringify({schemaVersion:1,durationMs}))
  let port = await freePort(); while (port === 4173) port = await freePort()
  report.port = port
  const env = {...process.env}
  for (const key of Object.keys(env)) if (/^(CGW_|CHATGPT_|CODEX_HOME$|NODE_OPTIONS$|NODE_PATH$|LAUNCHER_PORT$|BRIDGE_|API_PROVIDERS_STORE_PATH$|ASSETS_STORE_PATH$|FRONTEND_DIR$|DISABLE_AUTOSTART$|WEBVIEW2_)/.test(key)) delete env[key]
  Object.assign(env,{HOME:home,USERPROFILE:home,APPDATA:roaming,LOCALAPPDATA:local})
  child = spawn(exe,[`--data-dir=${data}`,`--resources=${resources}`,`--port=${port}`,'--isolated','--smoke','--smoke-case=soak','--from-autostart'],{cwd:root,env,windowsHide:true,stdio:['ignore','ignore','pipe']})
  child.on('error', error => { exitResult = {error:error.message} })
  child.on('exit',(code,signal) => { exitResult = {code,signal} })
  child.stderr.on('data',chunk => fs.appendFileSync(stderrFile,chunk))
  report.shellPid = child.pid; report.status = 'starting'; save()
  const startupEnd = Date.now() + 90000
  let ready
  while (Date.now() < startupEnd) {
    assert.ok(!exitResult,'Shell exited during startup')
    const evidence = nativeEvidence()
    if (evidence?.value.phase === 'ready' && ['authenticated','mounted','cleanUrl','nativeDenied','coreDenied','cookieHidden','historyClean','navigationSafe'].every(key=>evidence.value.console?.[key]===true)) { ready = evidence; break }
    if (cancelled || fs.existsSync(stopFile)) throw new Error('Cancelled before ready')
    await sleep(500)
  }
  assert.ok(ready,'Native soak helper did not report a ready console')
  const started = Date.now(); let previousWall = started, previousMono = performance.now(), previousSampleAt
  report.status = 'running'; report.measurementStartedAt = new Date(started).toISOString(); save()
  while (true) {
    const wall = Date.now(), mono = performance.now(), wallGap = wall-previousWall, monotonicGap = mono-previousMono
    const maxGap = Math.max(30000,intervalMs*3)
    if (wallGap > maxGap || monotonicGap > maxGap || Math.abs(wallGap-monotonicGap) > 10000) {
      report.gaps.push({at:new Date().toISOString(),wallGapMs:wallGap,monotonicGapMs:monotonicGap}); throw new Error('Scheduling gap or clock discontinuity; uninterrupted duration not established')
    }
    previousWall=wall;previousMono=mono
    assert.ok(!exitResult,'Shell exited before requested measurement ended')
    const evidence = nativeEvidence()
    assert.ok(evidence && evidence.ageMs < 20000,'Native session evidence is stale')
    assert.equal(evidence.value.phase,'ready')
    for (const key of ['authenticated','mounted','cleanUrl','nativeDenied','coreDenied','cookieHidden','historyClean','navigationSafe']) assert.equal(evidence.value.console[key],true,`Console check ${key}`)
    const response = await fetch(`http://127.0.0.1:${port}/v1/gen-images/me`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)})
    assert.equal(response.status,200); const body = await response.json(); assert.equal(body.keyId,keyId);assert.equal(body.images,0)
    const entry = await sample()
    assert.ok(entry.processes.some(p=>p.pid===child.pid),'Shell ownership missing')
    const owner = JSON.parse(fs.readFileSync(path.join(data,'runtime/owner.lock'),'utf8'))
    assert.equal(evidence.value.nodePid,owner.pid)
    assert.ok(entry.processes.some(p=>p.pid===owner.pid && p.executable.toLowerCase()===path.join(resources,manifest.node).toLowerCase()),'Gateway process ownership missing')
    assert.ok(entry.processes.some(p=>p.name.toLowerCase()==='msedgewebview2.exe'),'No owned WebView2 process observed')
    entry.elapsedMs=Date.now()-started; entry.native=evidence.value; entry.syntheticHttp={status:200,fixtureKeyMatched:true,images:0}
    entry.totalWorkingSetBytes=entry.processes.reduce((n,p)=>n+p.workingSetBytes,0)
    entry.totalPrivateBytes=entry.processes.reduce((n,p)=>n+p.privateBytes,0)
    let cpuDelta=0
    for(const p of entry.processes){const id=`${p.pid}:${p.createdAt}`;if(previousCpu.has(id))cpuDelta+=Math.max(0,p.cpuSeconds-previousCpu.get(id));previousCpu.set(id,p.cpuSeconds)}
    entry.cpuOneCorePercent=previousSampleAt ? cpuDelta/((Date.parse(entry.at)-previousSampleAt)/1000)*100 : null
    previousSampleAt=Date.parse(entry.at)
    fs.appendFileSync(samplesFile,JSON.stringify(entry)+'\n')
    report.sampleCount++;report.lastSample=entry;report.ownershipEvidence=[...known.values()]
    report.peakSampledWorkingSetBytes=Math.max(report.peakSampledWorkingSetBytes||0,entry.totalWorkingSetBytes)
    report.peakSampledPrivateBytes=Math.max(report.peakSampledPrivateBytes||0,entry.totalPrivateBytes)
    report.peakSampledCpuOneCorePercent=Math.max(report.peakSampledCpuOneCorePercent||0,entry.cpuOneCorePercent||0)
    save()
    if(cancelled || fs.existsSync(stopFile)){cancelled=true;break}
    if(Date.now()-started>=durationMs){completed=true;break}
    await sleep(Math.min(intervalMs,Math.max(0,durationMs-(Date.now()-started))))
  }
  report.measuredDurationMs=Date.now()-started
} catch(error) {report.error=error.message;process.exitCode=1}
finally {
  report.status='stopping';save()
  if(child?.pid){
    fs.writeFileSync(path.join(root,'soak-stop'),'normal quit requested by owned runner\n')
    report.nativeQuitRequested=true
    if(!await waitExit(45000)){
      forced=true;report.error??='Normal native exit timed out';process.exitCode=1
      child.kill();await waitExit(10000)
    }
    try {
      let remaining=await sample()
      for(let i=0;remaining.processes.length && i<20;i++){await sleep(500);remaining=await sample()}
      if(remaining.processes.length){forced=true;await sample(true);remaining=await sample()}
      report.remainingOwnedProcesses=remaining.processes
    }catch(error){report.error??=error.message;process.exitCode=1}
    report.exit=exitResult;report.forcedCleanup=forced
    if(exitResult?.code!==0 || forced || report.remainingOwnedProcesses?.length){report.error??='Native exit or process tree cleanup failed';process.exitCode=1}
  }
  try {
    assert.equal(fs.existsSync(path.join(data,'runtime/owner.lock')),false,'Ownership lock remains')
    report.lockReleased=true
    verifyDesktop({target:'win32-x64',outDir:resources});assert.equal(hash(exe),executableSha256)
    assert.equal(hash(path.join(resources,'DESKTOP-RESOURCES.json')),resourceManifestSha256)
    report.resourcesUnchanged=true
    const log=path.join(root,'CodexGatewayDesktop/logs/desktop.log')
    if(fs.existsSync(log)){report.nativeLifecycle=fs.readFileSync(log,'utf8').trim().split(/\r?\n/);assert.ok(report.nativeLifecycle.some(line=>line.endsWith(' stopped')),'Native stopped event missing')}
    if(!report.error && (completed || cancelled)){
      const actual=fs.realpathSync(root);assert.equal(actual,root);assert.equal(path.dirname(actual),tempBase);assert.ok(path.basename(actual).startsWith('cgw-soak-'))
      fs.rmSync(actual,{recursive:true,force:true,maxRetries:20,retryDelay:100});report.temporaryDataRemoved=true
    }
  }catch(error){report.error??=error.message;process.exitCode=1}
  report.status=report.error ? 'failed' : completed ? 'passed' : 'cancelled'
  report.eightHourRun=report.status==='passed' && durationMs===28800000
  report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,report:reportFile,sampleCount:report.sampleCount,error:report.error}))
}
