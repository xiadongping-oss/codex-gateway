import test from 'node:test'
import assert from 'node:assert/strict'
import { optionVerdicts } from '../../scripts/lib/image-option-verdicts.mjs'
function fixtures(){return [
  ...['jpeg','webp'].flatMap(format=>[30,90].map(n=>({id:`${format}-${n}`,hasImage:true,actual:{format},jpegQuantization:format==='jpeg'?[String(n)]:undefined}))),
  {id:'custom-size',hasImage:true,actual:{actual:'1672x941'}},
  ...['xhigh','max'].map((q,i)=>({id:`quality-${q}`,hasImage:true,requested:{tools:[{quality:q}]},returnedTool:{quality:i?'medium':'low'}})),
  {id:'fidelity-high',httpStatus:400,error:"The model does not support the 'input_fidelity' parameter."},
  {id:'continuation-id',httpStatus:400},
  {id:'continuation-context',hasImage:true},{id:'continuation-third',hasImage:true},
  {id:'batch-local-validation',httpStatus:400},
]}
test('success is determined by returned formats, dimensions, effective quality and explicit errors',()=>{
  const evidence=optionVerdicts(fixtures(),{webpBaseQ:[68,12],identityReviewed:true})
  assert.equal(evidence.format.status,'passed');assert.equal(evidence.compression.status,'passed')
  assert.equal(evidence.size.status,'limited');assert.equal(evidence.quality.status,'unsupported')
  assert.equal(evidence.fidelity.status,'unsupported');assert.equal(evidence.advanced.status,'limited')
  assert.equal(evidence.identity.status,'limited');assert.equal(evidence.batch.status,'unsupported')
})
test('file size differences and images alone cannot prove compression, effective quality or identity retention',()=>{
  const input=fixtures();delete input[0].jpegQuantization
  delete input.find(t=>t.id==='quality-xhigh').returnedTool
  const evidence=optionVerdicts(input)
  assert.equal(evidence.compression.status,'limited');assert.equal(evidence.quality.status,'limited')
  assert.equal(evidence.identity.status,'unverified')
  input.find(t=>t.id==='webp-90').actual.format='png'
  assert.equal(optionVerdicts(input).format.status,'limited')
})
test('network failures are not mislabeled as unsupported model parameters',()=>{
  const input=fixtures();input.find(t=>t.id==='fidelity-high').error='temporary upstream 400'
  assert.equal(optionVerdicts(input).fidelity.status,'failed')
  input.find(t=>t.id==='custom-size').actual.actual='1536x864'
  assert.equal(optionVerdicts(input).size.status,'passed')
})
