import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ref, computed, watch, nextTick } from 'vue'
const source = fs.readFileSync(new URL('../src/components/SetupModal.vue', import.meta.url), 'utf8').split('<script setup>')[1].split('</script>')[0].replace(/^import .*$/gm, '')
function component(overrides = {}) {
  const intervals = new Map(), emitted = [], unmounted = []
  let id = 0
  const api = { officialLoginCancel: async () => ({ok:true}), cancelBrowserLoginApi: async () => ({}), cancelDeviceFlowApi: async () => ({}), getProviders: async () => ({}), ...overrides }
  const run = new Function('api','ref','computed','watch','nextTick','onMounted','onUnmounted','defineEmits','setInterval','clearInterval','window','PROVIDER_PRESETS','CUSTOM_PROVIDER_ID','writeClipboard','vModalFocus', source + '\nreturn {active,authMode,tempPhase,tempSession,tempError,tempRetryable,tempImporting,error,okMsg,browser,device,pendingOAuthImport,polling,continueAuth,startTempLogin,finishTempLogin,retryTempImport,cancelTempLogin,startAuth,getLocalAccount};')
  const state=run(api,ref,computed,watch,nextTick,()=>{},fn=>unmounted.push(fn),()=> (...args)=>emitted.push(args),fn=>{intervals.set(++id,fn);return id},i=>intervals.delete(i),{},[],'custom',()=>{},()=>{})
  return {...state,emitted,intervals,unmount:()=>unmounted.forEach(fn=>fn()),tick:async()=>{for(const fn of [...intervals.values()])await fn()}}
}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
const flush=async()=>{await Promise.resolve();await nextTick();await Promise.resolve()}

test('official import retry keeps same session and emits only after successful commit',async()=>{
 let n=0;const ids=[];const c=component({officialLoginStart:async()=>({ok:true,sessionId:'session'}),officialLoginFinish:async id=>{ids.push(id);if(!n++)throw Object.assign(new Error('保存失败'),{status:503});return{ok:true}}})
 await c.startTempLogin();await c.finishTempLogin();assert.equal(c.tempRetryable.value,true);assert.equal(c.emitted.length,0);await c.retryTempImport();assert.deepEqual(ids,['session','session']);assert.equal(c.tempPhase.value,'completed');assert.equal(c.emitted.length,1);c.unmount()
})
test('closing during finish ignores late success and cannot update another dialog',async()=>{
 const d=deferred();const c=component({officialLoginStart:async()=>({ok:true,sessionId:'session'}),officialLoginFinish:()=>d.promise})
 await c.startTempLogin();const pending=c.finishTempLogin();c.unmount();d.resolve({ok:true});await pending;assert.equal(c.emitted.length,0);assert.equal(c.okMsg.value,'');assert.equal(c.tempPhase.value,'idle')
})
test('unknown sessions and 400/401/403 stop waiting and allow another entry',async()=>{
 for(const status of [0,400,401,403]){const c=component({officialLoginStart:async()=>({ok:true,sessionId:'session'}),officialLoginStatus:async()=>{if(status)throw Object.assign(new Error('会话不可用'),{status});return{phase:'unknown'}}});await c.startTempLogin();await c.tick();assert.equal(c.tempPhase.value,'failed');assert.equal(c.intervals.size,0);assert.equal(c.tempRetryable.value,false);assert.ok(c.tempError.value);c.unmount()}
})
test('closing local inspection prevents a subsequent import request',async()=>{
 const d=deferred();let imports=0;const c=component({inspectCodexLocal:()=>d.promise,importCodexLocal:async()=>{imports++;return{ok:true}}});const pending=c.getLocalAccount();c.unmount();d.resolve({exists:true});await pending;assert.equal(imports,0);assert.equal(c.emitted.length,0)
})
test('OAuth polling is single flight and switching mode discards late success',async()=>{
 const d=deferred();let polls=0;const c=component({startBrowserLoginApi:async()=>({ok:true,hostedUrl:'http://example.invalid'}),pollBrowserLoginApi:()=>{polls++;return d.promise}});await c.startAuth();const one=c.tick();await c.tick();assert.equal(polls,1);c.authMode.value='device';await flush();d.resolve({ok:true});await one;assert.equal(c.emitted.length,0);assert.equal(c.browser.value,null);assert.equal(c.polling.value,false);c.unmount()
})
test('closing while official start is pending cancels the late-created session',async()=>{
 const d=deferred();const cancelled=[];const c=component({officialLoginStart:()=>d.promise,officialLoginCancel:async id=>cancelled.push(id)});const pending=c.startTempLogin();c.unmount();d.resolve({ok:true,sessionId:'late'});await pending;assert.deepEqual(cancelled,['late']);assert.equal(c.emitted.length,0)
})

test('finish HTTP 400 only offers retry when server retains the credentials session',async()=>{
 for(const phase of ['ready','unknown']){const c=component({officialLoginStart:async()=>({ok:true,sessionId:'session'}),officialLoginFinish:async()=>{throw Object.assign(new Error('导入失败'),{status:400})},officialLoginStatus:async()=>({phase})});await c.startTempLogin();await c.finishTempLogin();assert.equal(c.tempRetryable.value,phase==='ready');c.unmount()}
})
test('cancel failure stays visible and does not claim the session was cancelled',async()=>{
 const c=component({officialLoginStart:async()=>({ok:true,sessionId:'session'}),officialLoginCancel:async()=>{throw new Error('正在导入，暂时不能取消')}});await c.startTempLogin();assert.equal(await c.cancelTempLogin(),false);assert.equal(c.tempSession.value.sessionId,'session');assert.equal(c.tempPhase.value,'running');assert.match(c.tempError.value,/不能取消/);c.unmount()
})

test('recovered browser and device results remain retryable after save failure',async()=>{
 for(const source of ['browser','device']){let starts=0,polls=0;const c=component({startBrowserLoginApi:async()=>{starts++;return{ok:true,pendingImport:true,loginId:'recovered'}},startDeviceFlowApi:async()=>{starts++;return{ok:true,pendingImport:true,loginId:'recovered'}},pollBrowserLoginApi:async()=>{if(!polls++)throw new Error('保存失败');return{ok:true}},pollDeviceFlowApi:async()=>{if(!polls++)throw new Error('保存失败');return{ok:true}}});c.authMode.value=source;await flush();await c.startAuth();assert.equal(c.pendingOAuthImport.value,true);assert.equal(c.polling.value,false);await c.continueAuth();assert.match(c.error.value,/保存失败/);assert.equal(c.pendingOAuthImport.value,true);await c.continueAuth();assert.equal(c.pendingOAuthImport.value,false);assert.equal(c.emitted.length,1);assert.equal(starts,1);assert.equal(polls,2);c.unmount()}
})
test('closing or switching a device authorization cancels only the device source',async()=>{
 for(const action of ['close','mode','tab']){const cancelled=[];const c=component({startDeviceFlowApi:async()=>({ok:true,pendingImport:true}),cancelBrowserLoginApi:async()=>cancelled.push('browser'),cancelDeviceFlowApi:async()=>cancelled.push('device')});c.authMode.value='device';await flush();await c.startAuth();if(action==='close')c.unmount();else{if(action==='mode')c.authMode.value='browser';else c.active.value='json';await flush();c.unmount()}await flush();assert.deepEqual(cancelled,['device'])}
})
test('busy OAuth cancellation keeps the pending save reachable with its error',async()=>{
 const c=component({startDeviceFlowApi:async()=>({ok:true,pendingImport:true}),cancelDeviceFlowApi:async()=>{throw new Error('授权正在保存，请稍后重试')}});c.authMode.value='device';await flush();await c.startAuth();c.authMode.value='browser';await flush();assert.equal(c.authMode.value,'device');assert.equal(c.pendingOAuthImport.value,true);assert.match(c.error.value,/正在保存/);c.unmount()
})
test('late device start after closing is cancelled without publishing its state',async()=>{
 const d=deferred(),cancelled=[];const c=component({startDeviceFlowApi:()=>d.promise,cancelDeviceFlowApi:async()=>cancelled.push('device')});c.authMode.value='device';await flush();const starting=c.startAuth();c.unmount();d.resolve({ok:true,pendingImport:true});await starting;assert.equal(c.device.value,null);assert.ok(cancelled.length>=1);assert.deepEqual([...new Set(cancelled)],['device']);assert.equal(c.emitted.length,0)
})
