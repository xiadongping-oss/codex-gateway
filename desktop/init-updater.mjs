// One-time local setup. Only the public key enters the repository.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

const desktop=path.dirname(fileURLToPath(import.meta.url))
const configPath=path.join(desktop,'src-tauri/tauri.conf.json')
const config=JSON.parse(fs.readFileSync(configPath,'utf8'))
const directory=path.join(process.env.LOCALAPPDATA || os.homedir(),'CodexGatewaySigning')
const key=path.join(directory,'updater.key')
fs.mkdirSync(directory,{recursive:true,mode:0o700})
if(process.platform==='win32') {
  const user=execFileSync('whoami.exe',[],{encoding:'utf8',windowsHide:true}).trim()
  execFileSync('icacls.exe',[directory,'/inheritance:r','/grant:r',`${user}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F'],{stdio:'pipe',windowsHide:true})
}
if(!fs.existsSync(key)) {
  if(config.plugins?.updater?.pubkey)throw new Error('An updater public key already exists. Restore the matching private key instead of generating a replacement.')
  execFileSync(process.execPath,[path.join(desktop,'node_modules/@tauri-apps/cli/tauri.js'),'signer','generate','--ci','--password','','--write-keys',key],{stdio:'pipe',windowsHide:true})
}
const pubkey=fs.readFileSync(key+'.pub','utf8').trim()
if(config.plugins?.updater?.pubkey && config.plugins.updater.pubkey!==pubkey)throw new Error('Local signing key does not match the public key trusted by installed clients')
config.plugins={...config.plugins,updater:{pubkey,endpoints:['https://github.com/xiadongping-oss/codex-gateway/releases/latest/download/latest.json'],requireSignedVersion:true,windows:{installMode:'passive'}}}
fs.writeFileSync(configPath,JSON.stringify(config,null,2)+'\n')
console.log('Updater public key configured. Private signing key remains outside the repository: '+key)
