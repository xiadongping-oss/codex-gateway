import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IMAGE_ADAPTER_REVISION, readImageVerification } from '../image-verification.mjs'
import { gatewayCapabilities } from '../capabilities.mjs'
test('live evidence is scoped to account, renderer, adapter version and age',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'image-evidence-'))
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const now=Date.now(),file=path.join(dir,'image-verification.json')
  const record={schemaVersion:1,adapterRevision:IMAGE_ADAPTER_REVISION,checkedAt:new Date(now).toISOString(),accountId:'account-a',model:'renderer-a',features:{transparent:{status:'passed',detail:'Alpha checked'},mask:{status:'limited',detail:'Dimensions changed'},unknown:{status:'passed',detail:'Do not expose'}}}
  fs.writeFileSync(file,JSON.stringify(record))
  const valid=readImageVerification(dir,'account-a','renderer-a',now)
  assert.deepEqual(Object.keys(valid.features),['transparent','mask'])
  assert.equal(gatewayCapabilities('bridge',valid).image.find(f=>f.id==='mask').verification.status,'limited')
  assert.ok(gatewayCapabilities('openai',valid).image.every(f=>!f.verification))
  assert.equal(readImageVerification(dir,'account-b','renderer-a',now),null)
  assert.equal(readImageVerification(dir,'account-a','renderer-b',now),null)
  assert.equal(readImageVerification(dir,'account-a','renderer-a',now+31*86400000),null)
  for(const change of [{adapterRevision:'old'},{checkedAt:new Date(now+120000).toISOString()},{schemaVersion:2}]){
    fs.writeFileSync(file,JSON.stringify({...record,...change}));assert.equal(readImageVerification(dir,'account-a','renderer-a',now),null)
  }
  fs.writeFileSync(file,'invalid');assert.equal(readImageVerification(dir,'account-a','renderer-a',now),null)
})
test('partial option audits cannot renew expired evidence from earlier image tests',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'image-options-'))
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const now=Date.now(),checkedAt=new Date(now).toISOString(),old=new Date(now-31*86400000).toISOString()
  fs.writeFileSync(path.join(dir,'image-verification.json'),JSON.stringify({schemaVersion:1,adapterRevision:IMAGE_ADAPTER_REVISION,checkedAt,accountId:'a',model:'m',features:{mask:{status:'passed',detail:'old',checkedAt:old},size:{status:'limited',detail:'dimensions differ',checkedAt},quality:{status:'limited',detail:'no effective quality returned',checkedAt},advanced:{status:'limited',detail:'explicit image context works',checkedAt},batch:{status:'unsupported',detail:'n=1 only',checkedAt}}}))
  const evidence=readImageVerification(dir,'a','m',now)
  assert.ok(!evidence.features.mask)
  assert.deepEqual(Object.keys(evidence.features),['size','quality','advanced','batch'])
  assert.equal(evidence.features.batch.status,'unsupported')
  assert.equal(gatewayCapabilities('bridge',evidence).image.find(f=>f.id==='quality').verification.status,'limited')
})
