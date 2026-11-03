import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ref,computed,watch } from 'vue'
const source=fs.readFileSync(new URL('../src/components/AccessConfig.vue',import.meta.url),'utf8').split('<script setup>')[1].split('</script>')[0].replace(/^import .*$/gm,'')
function component(reveal,copyText) {
  const unmounted=[]
  const run=new Function('ref','computed','watch','onMounted','onUnmounted','defineProps','defineEmits','api','BASE','window','copyText','formatAccessConfig',source+'\nreturn {modelId,keyId,preview,copyConfig,message,manual,manualKey};')
  const state=run(ref,computed,watch,()=>{},fn=>unmounted.push(fn),()=>({models:[],model:'test-model'}),()=>()=>{}, {revealApiKey:reveal},'',{location:{origin:'http://127.0.0.1:4173'}},copyText,(base,key,model)=>[base,key||'<placeholder>',model].join('\n'))
  return {...state,dispose:()=>unmounted.forEach(fn=>fn())}
}
test('access copy reveals only the selected key and formats the clipboard after retrieval, keeping the DOM preview masked',async()=>{
  const copied=[];const c=component(async id=>{assert.equal(id,'selected-key');return{token:'synthetic-secret'}},async text=>copied.push(text));c.keyId.value='selected-key'
  assert.ok(!c.preview.value.includes('synthetic-secret'));await c.copyConfig('env')
  assert.ok(copied[0].includes('synthetic-secret'));assert.ok(!c.preview.value.includes('synthetic-secret'));c.dispose()
})
test('changing the model while a key is being revealed cannot copy an outdated selection',async()=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve});const copied=[];const c=component(()=>pending,async text=>copied.push(text));c.keyId.value='selected-key'
  const copying=c.copyConfig('json');c.modelId.value='new-model';finish({token:'synthetic-secret'});await copying;assert.equal(copied.length,0);c.dispose()
})
