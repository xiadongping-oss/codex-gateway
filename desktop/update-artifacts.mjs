import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {execFileSync} from 'node:child_process'

// Publication-side verification using Node's Ed25519 implementation and the
// minisign envelope used by Tauri. The installed app independently verifies with
// the official updater plugin, including its requireSignedVersion check.
export function verifyUpdaterSignature(bytes, signature, pubkey, version) {
  const publicLines=Buffer.from(pubkey.trim(),'base64').toString('utf8').trim().split(/\r?\n/)
  const lines=Buffer.from(signature.trim(),'base64').toString('utf8').trim().split(/\r?\n/)
  const key=Buffer.from(publicLines[1] || '','base64'), sig=Buffer.from(lines[1] || '','base64'), global=Buffer.from(lines[3] || '','base64')
  if(key.length!==42 || sig.length!==74 || global.length!==64 || !lines[2]?.startsWith('trusted comment: ') || !key.subarray(2,10).equals(sig.subarray(2,10)))throw new Error('Invalid updater signature envelope or signing key')
  const publicKey=crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),key.subarray(10)]),format:'der',type:'spki'})
  const algorithm=sig.subarray(0,2).toString('ascii')
  if(!['ED','Ed'].includes(algorithm))throw new Error('Unsupported updater signature algorithm')
  const payload=algorithm==='ED'?crypto.createHash('blake2b512').update(bytes).digest():bytes
  const comment=lines[2].slice(17)
  if(!crypto.verify(null,payload,publicKey,sig.subarray(10)) || !crypto.verify(null,Buffer.concat([sig.subarray(10),Buffer.from(comment)]),publicKey,global))throw new Error('Updater signature verification failed')
  const signedVersion=comment.split('\t').find(s=>s.startsWith('version:'))?.slice(8)
  if(signedVersion?.replace(/^v/,'')!==version.replace(/^v/,''))throw new Error('Updater signature version mismatch')
  return true
}

export function updaterSigningEnvironment(inherited=process.env) {
  if(inherited.TAURI_SIGNING_PRIVATE_KEY || inherited.TAURI_SIGNING_PRIVATE_KEY_PATH)return {...inherited}
  const key=path.join(inherited.LOCALAPPDATA || os.homedir(),'CodexGatewaySigning','updater.key')
  if(!fs.existsSync(key))return null
  return {...inherited,TAURI_SIGNING_PRIVATE_KEY_PATH:key,TAURI_SIGNING_PRIVATE_KEY_PASSWORD:inherited.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || ''}
}

export function signUpdateArtifact({desktop,installer,version,notes,env=updaterSigningEnvironment(),cli=path.join(desktop,'node_modules/@tauri-apps/cli/tauri.js')}) {
  if(!env)return null
  const config=JSON.parse(fs.readFileSync(path.join(desktop,'src-tauri/tauri.conf.json'),'utf8'))
  const signingEnv={...env,TAURI_SIGNING_PRIVATE_KEY_PASSWORD:env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || ''}
  if(signingEnv.TAURI_SIGNING_PRIVATE_KEY?.length<1024 && fs.existsSync(signingEnv.TAURI_SIGNING_PRIVATE_KEY)) {
    signingEnv.TAURI_SIGNING_PRIVATE_KEY_PATH=signingEnv.TAURI_SIGNING_PRIVATE_KEY
    delete signingEnv.TAURI_SIGNING_PRIVATE_KEY
  }
  // Capture CLI output: a private-key string from the environment must never
  // become a logged command argument. Sign after any Authenticode mutation.
  execFileSync(process.execPath,[cli,'signer','sign','--app-version',version,installer],{env:signingEnv,windowsHide:true,stdio:'pipe'})
  const signature=fs.readFileSync(installer+'.sig','utf8').trim()
  const bytes=fs.readFileSync(installer)
  verifyUpdaterSignature(bytes,signature,config.plugins.updater.pubkey,version)
  const manifest={version,notes:notes || `Codex Gateway ${version}。安装后保留账号、配置与图片。`,pub_date:new Date().toISOString(),platforms:{'windows-x86_64':{signature,url:`https://github.com/xiadongping-oss/codex-gateway/releases/download/v${version}/${encodeURIComponent(path.basename(installer))}`,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}}}
  const file=path.join(path.dirname(installer),'latest.json')
  fs.writeFileSync(file,JSON.stringify(manifest,null,2)+'\n')
  return {manifest:file,signature:installer+'.sig',verified:true}
}
