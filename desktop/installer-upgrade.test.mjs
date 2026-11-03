import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn,spawnSync} from 'node:child_process'

const desktop=path.dirname(fileURLToPath(import.meta.url))
const compiler=path.join(process.env.LOCALAPPDATA || '', 'tauri/NSIS/makensis.exe')
const utilities=process.env.CGW_NSIS_UTILS_DIR || path.join(desktop,'src-tauri/target/windows-package/release/nsis/x64')
const wait=ms=>new Promise(r=>setTimeout(r,ms))
async function until(predicate){for(let n=0;n<100;n++){if(predicate())return;await wait(100)}assert.fail('Owned fixture did not reach expected state')}
const alive=child=>child.exitCode===null&&child.signalCode===null
const escaped=value=>value.replaceAll('$','$$').replaceAll('"','$\\"')

test('automatic cleanup runs after the running-app check and before new files; passive pages do not read absent controls',()=>{
  const source=fs.readFileSync(path.join(desktop,'src-tauri/installer/template.nsi'),'utf8').replaceAll('\r\n','\n')
  const install=source.slice(source.indexOf('Section Install\n'),source.indexOf('; Copy resources',source.indexOf('Section Install\n')))
  assert.ok(install.indexOf('CheckIfAppIsRunning')<install.indexOf('Call CgwPrepareAutomaticUpgrade'))
  assert.ok(install.indexOf('Call CgwPrepareAutomaticUpgrade')<install.indexOf('File "${MAINBINARYSRCPATH}"'))
  const page=source.slice(source.indexOf('Function PageLeaveReinstall\n'),source.indexOf('  ; $R0 holds whether same'))
  assert.ok(page.indexOf('$PassiveMode = 1')<page.indexOf('${NSD_GetState}'))
  assert.match(source,/!insertmacro CGW_DECLARE_AUTOMATIC_UPGRADE/)
})

test('compiled NSIS upgrades close only the owned app, remove obsolete files, preserve data/startup, and stop before copy on cleanup failure', {
  skip:process.platform!=='win32' || !fs.existsSync(compiler) || !fs.existsSync(path.join(utilities,'utils.nsh')) ? 'Requires Windows and the pinned generated NSIS utilities (run packaging or set CGW_NSIS_UTILS_DIR)' : false,
  timeout:120000
},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cgw-upgrade-')),owned=fs.realpathSync(root)
  let install=path.join(root,'安装目录 with spaces'),caseNumber=0
  const data=path.join(root,'independent-data'),key='Software\\CGWUpgradeFixture\\'+path.basename(root)
  const registry='HKCU\\'+key,uninstallKey=key+'\\Uninstall',settingsKey=key+'\\Settings',startupKey=key+'\\Run',approvedKey=key+'\\Approved'
  const children=[],report={modes:[],failures:[]}
  fs.mkdirSync(data);fs.writeFileSync(path.join(data,'accounts.json'),'{"fixture":true}');fs.writeFileSync(path.join(data,'image.png'),Buffer.from([137,80,78,71,13,10,26,10]))
  const canaries=new Map(['accounts.json','image.png'].map(f=>[f,fs.readFileSync(path.join(data,f))]))
  const run=(exe,args,extra={})=>{const r=spawnSync(exe,args,{windowsHide:true,encoding:'utf8',timeout:30000,...extra});if(r.error)throw r.error;return r}
  const runInstaller=(exe,args)=>run(exe,args,{windowsVerbatimArguments:true})
  const reg=(...args)=>run('reg.exe',args)
  const query=(sub,name)=>{const r=reg('query',registry+'\\'+sub,...(name?['/v',name]:['/ve']));return r.status===0?r.stdout.match(/REG_SZ\s+([^\r\n]*)/)?.[1]:undefined}
  const cleanRegistry=()=>reg('delete',registry,'/f')
  const helper=path.join(root,'fixture-app.exe')
  const ps=path.join(root,'build-helper.ps1')
  fs.writeFileSync(ps,`Add-Type -TypeDefinition 'using System; using System.IO; using System.Diagnostics; using System.Threading; public class Fixture { public static void Main(string[] args) { File.WriteAllText(args[0],Process.GetCurrentProcess().Id.ToString()); while(true) Thread.Sleep(500); } }' -OutputAssembly '${helper.replaceAll("'","''")}' -OutputType WindowsApplication\n`)
  const build=run('powershell.exe',['-NoProfile','-NonInteractive','-File',ps]);assert.equal(build.status,0,build.stderr)
  fs.writeFileSync(path.join(root,'old.txt'),'old');fs.writeFileSync(path.join(root,'new.txt'),'new')
  function compile(version,isNew){
    const out=path.join(root,isNew?'new-setup.exe':'old-setup.exe')
    const source=`Unicode true
!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!include "Win\\RestartManager.nsh"
!include "${escaped(path.join(utilities,'utils.nsh'))}"
!include "${escaped(path.join(desktop,'src-tauri/installer/hooks.nsh'))}"
!addplugindir "${escaped(path.join(process.env.LOCALAPPDATA,'tauri/NSIS/Plugins/x86-unicode/additional'))}"
!define UNINSTKEY "${uninstallKey}"
!define MANUPRODUCTKEY "${settingsKey}"
!define MAINBINARYNAME "codex-gateway-desktop"
Name "Isolated CGW upgrade fixture"
OutFile "${escaped(out)}"
InstallDir "${escaped(install)}"
RequestExecutionLevel user
AutoCloseWindow true
Page instfiles
UninstPage instfiles
Var UpdateMode
Var PassiveMode
!insertmacro CGW_DECLARE_AUTOMATIC_UPGRADE
LoadLanguageFile "\${NSISDIR}\\Contrib\\Language files\\English.nlf"
LangString CGW_UpgradeCleanupFailed 1033 "Old cleanup failed; no new files copied"
LangString appRunning 1033 "Fixture still running"
LangString appRunningOkKill 1033 "Close fixture"
LangString failedToKillApp 1033 "Could not close fixture"
Function .onInit
  StrCpy $UpdateMode 0
  StrCpy $PassiveMode 0
  \${GetOptions} $CMDLINE "/UPDATE" $0
  \${IfNot} \${Errors}
    StrCpy $UpdateMode 1
  \${EndIf}
  \${GetOptions} $CMDLINE "/P" $0
  \${IfNot} \${Errors}
    StrCpy $PassiveMode 1
  \${EndIf}
FunctionEnd
Function un.onInit
  ; An old language chooser can run before /P is parsed. Require intrinsic
  ; silent mode so this regression fails instead of opening a blocking dialog.
  IfSilent fixture_uninstaller_silent
    SetErrorLevel 9
    Quit
  fixture_uninstaller_silent:
  StrCpy $UpdateMode 0
  \${GetOptions} $CMDLINE "/UPDATE" $0
  \${IfNot} \${Errors}
    StrCpy $UpdateMode 1
  \${EndIf}
FunctionEnd
Section Install
  ${isNew?'!insertmacro CheckIfAppIsRunning "$INSTDIR\\codex-gateway-desktop.exe" "Fixture"\n  Call CgwPrepareAutomaticUpgrade':''}
  SetOutPath "$INSTDIR"
  File /oname=codex-gateway-desktop.exe "${escaped(helper)}"
  File /oname=${isNew?'new-version.txt':'obsolete-owned.txt'} "${escaped(path.join(root,isNew?'new.txt':'old.txt'))}"
  WriteUninstaller "$INSTDIR\\uninstall.exe"
  WriteRegStr SHCTX "\${UNINSTKEY}" "UninstallString" '$\\"$INSTDIR\\uninstall.exe$\\"'
  WriteRegStr SHCTX "\${UNINSTKEY}" "DisplayVersion" "${version}"
  WriteRegStr SHCTX "\${MANUPRODUCTKEY}" "" "$INSTDIR"
  ${isNew?'':`WriteRegStr HKCU "${startupKey}" "Fixture" '$\\"$INSTDIR\\codex-gateway-desktop.exe$\\" $\\"--from-autostart$\\"'\n  WriteRegStr HKCU "${approvedKey}" "Fixture" "owned"`}
SectionEnd
Section Uninstall
  IfFileExists "$INSTDIR\\false-cleanup-success" 0 +3
    SetErrorLevel 0
    Quit
  IfFileExists "$INSTDIR\\block-cleanup" 0 +3
    SetErrorLevel 7
    Quit
  !insertmacro CheckIfAppIsRunning "$INSTDIR\\codex-gateway-desktop.exe" "Fixture"
  Delete "$INSTDIR\\codex-gateway-desktop.exe"
  Delete "$INSTDIR\\${isNew?'new-version.txt':'obsolete-owned.txt'}"
  !insertmacro CGW_REMOVE_OWNED_AUTOSTART "${startupKey}" "${approvedKey}" "Fixture"
  DeleteRegKey SHCTX "\${UNINSTKEY}"
  FileOpen $0 "${escaped(path.join(root,isNew?'new-uninstalled.txt':'old-uninstalled.txt'))}" a
  FileSeek $0 0 END
  FileWrite $0 "uninstalled$\\r$\\n"
  FileClose $0
SectionEnd
`
    const script=path.join(root,isNew?'new.nsi':'old.nsi');fs.writeFileSync(script,source)
    const built=run(compiler,['/INPUTCHARSET','UTF8','/V2',script]);assert.equal(built.status,0,built.stdout+'\n'+built.stderr);return out
  }
  const old=compile('1.14.0',false),next=compile('1.14.1',true)
  async function processFixture(exe,name){const marker=path.join(root,name+'-'+children.length+'.ready');const child=spawn(exe,[marker],{windowsHide:true,stdio:'ignore'});children.push(child);await until(()=>fs.existsSync(marker));return child}
  const canaryExe=path.join(root,'unrelated-app.exe');fs.copyFileSync(helper,canaryExe);const unrelated=await processFixture(canaryExe,'unrelated')
  function assertData(){for(const [f,b]of canaries)assert.deepEqual(fs.readFileSync(path.join(data,f)),b);assert.ok(alive(unrelated),'Unrelated process was terminated')}
  async function reset(){
    for(const child of children)if(child!==unrelated&&alive(child))child.kill()
    await wait(100)
    install=path.join(root,++caseNumber+' 安装目录 with spaces')
    assert.equal(fs.existsSync(install),false,'Each case owns a fresh directory')
    cleanRegistry()
    const r=runInstaller(old,['/S','/NS','/D='+install]);assert.equal(r.status,0,r.stderr)
    assert.equal(fs.existsSync(path.join(install,'new-version.txt')),false,'Old fixture must start without new files')
    fs.writeFileSync(path.join(install,'unknown-user-file.txt'),'keep me')
  }
  try {
    for(const mode of [['/S','/UPDATE'],['/P','/UPDATE'],['/S']]){
      await reset();const app=await processFixture(path.join(install,'codex-gateway-desktop.exe'),'old-app')
      const callsBefore=fs.existsSync(path.join(root,'old-uninstalled.txt'))?fs.readFileSync(path.join(root,'old-uninstalled.txt'),'utf8').trim().split(/\r?\n/).length:0
      const startup=query('Run','Fixture'),r=runInstaller(next,[...mode,'/NS','/D='+install]);assert.equal(r.status,0,r.stdout+'\n'+r.stderr)
      await until(()=>!alive(app));assert.equal(fs.existsSync(path.join(install,'obsolete-owned.txt')),false)
      assert.equal(fs.readFileSync(path.join(install,'new-version.txt'),'utf8'),'new');assert.equal(query('Uninstall','DisplayVersion'),'1.14.1')
      assert.equal(query('Run','Fixture'),startup);assert.equal(query('Approved','Fixture'),'owned')
      assert.equal(fs.readFileSync(path.join(install,'unknown-user-file.txt'),'utf8'),'keep me')
      assert.equal(fs.readFileSync(path.join(root,'old-uninstalled.txt'),'utf8').trim().split(/\r?\n/).length,callsBefore+1);assertData();report.modes.push(mode.join(' '))
    }
    for(const failure of ['blocked-uninstaller','false-success','missing-uninstaller','missing-registration','invalid-root']){
      await reset()
      if(failure==='blocked-uninstaller')fs.writeFileSync(path.join(install,'block-cleanup'),'fail')
      if(failure==='false-success')fs.writeFileSync(path.join(install,'false-cleanup-success'),'fail')
      if(failure==='missing-uninstaller')fs.renameSync(path.join(install,'uninstall.exe'),path.join(install,'uninstall.saved'))
      if(failure==='missing-registration')assert.equal(reg('delete',registry+'\\Uninstall','/v','UninstallString','/f').status,0)
      if(failure==='invalid-root')assert.equal(reg('add',registry+'\\Settings','/ve','/t','REG_SZ','/d',path.parse(install).root,'/f').status,0)
      const r=runInstaller(next,['/S','/UPDATE','/NS','/D='+install]);assert.notEqual(r.status,0,'Broken old installation must stop upgrade')
      assert.equal(query('Uninstall','DisplayVersion'),'1.14.0');assert.equal(fs.existsSync(path.join(install,'new-version.txt')),false,failure+': new files must not be copied')
      assert.equal(fs.readFileSync(path.join(install,'obsolete-owned.txt'),'utf8'),'old');assertData();report.failures.push(failure)
    }
    // A previous normal uninstall can leave its preferred directory setting.
    await reset();assert.equal(runInstaller(path.join(install,'uninstall.exe'),['/S','_?='+install]).status,0)
    assert.equal(query('Uninstall','DisplayVersion'),undefined)
    assert.equal(query('Run','Fixture'),undefined);assert.ok(query('Settings',''))
    assert.equal(runInstaller(next,['/S','/UPDATE','/NS','/D='+install]).status,0,'Retained install location must not prevent a fresh installation')
    assertData();console.log(JSON.stringify({fixture:'compiled NSIS automatic upgrade',...report,dataPreserved:true,unrelatedProcessPreserved:true}))
  } finally {
    for(const child of children)if(alive(child))child.kill()
    await wait(200);cleanRegistry()
    assert.equal(fs.realpathSync(root),owned);assert.equal(path.dirname(owned),fs.realpathSync(os.tmpdir()))
    fs.rmSync(owned,{recursive:true,force:true})
  }
})
