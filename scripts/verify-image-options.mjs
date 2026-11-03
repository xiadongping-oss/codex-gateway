// Explicit live capability audit. Generates images and consumes account quota.
// No automatic retries; reuse prior images and retain earlier acceptance records.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { parseSSE } from '../gateway/node_modules/chatgpt-bridge/dist/index.js'
import { imageFileInfo } from '../gateway/image-file.mjs'
import { IMAGE_ADAPTER_REVISION } from '../gateway/image-verification.mjs'
import { writeJsonAtomic } from '../gateway/atomic-write.mjs'
import { optionVerdicts } from './lib/image-option-verdicts.mjs'
const arg = name => process.argv.slice(2).find(a => a.startsWith(`--${name}=`))?.slice(name.length+3)
const dataDir = arg('data'), outDir = path.resolve(arg('out') || `output/image-options-${Date.now()}`)
if (!dataDir || !path.isAbsolute(dataDir)) throw Error('Explicit absolute --data required')
const base = new URL(arg('base') || 'http://127.0.0.1:4173')
if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:' || base.username || base.password) throw Error('Only the local current gateway can be audited')
const token = JSON.parse(fs.readFileSync(path.join(dataDir,'admin-token.json'))).token
const status = async () => {
  const response = await fetch(new URL('/__gw/status',base),{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)})
  if(!response.ok)throw Error('Cannot read current account');return response.json()
}
const before = await status()
if(before.mode!=='bridge'||!before.activeAccountId||before.health?.ok!==true)throw Error('Healthy current bridge account required')
fs.mkdirSync(outDir,{recursive:false})
const report = {schemaVersion:1,adapterRevision:IMAGE_ADAPTER_REVISION,accountId:before.activeAccountId,model:before.imageModel,checkedAt:new Date().toISOString(),features:{},tests:[]}
const save = () => fs.writeFileSync(path.join(outDir,'report.json'),JSON.stringify(report,null,2)+'\n')
const headers = () => ({'content-type':'application/json',...(process.env.CGW_LIVE_API_KEY?{authorization:`Bearer ${process.env.CGW_LIVE_API_KEY}`}:{})})
const safeError = value => String(value?.message || value?.code || value || '').replace(/Bearer\s+\S+|(?:sk-|cgw-)[A-Za-z0-9_-]{12,}/g,'[redacted]').slice(0,1200)
async function request(id,endpoint,body) {
  console.log(`Testing ${id}…`)
  const started=Date.now(), record={id,endpoint,requested:Object.fromEntries(Object.entries(body).filter(([k])=>!['image','input','previous_response_id'].includes(k)))}
  // Tool definitions have no input image bytes; keep useful requested parameters.
  let b64, completed, imageItem
  try {
    const response=await fetch(new URL(endpoint,base),{method:'POST',headers:headers(),body:JSON.stringify(body),signal:AbortSignal.timeout(430000)})
    record.httpStatus=response.status
    if(response.ok&&endpoint==='/v1/responses'){
      for await(const event of parseSSE(response)){
        if(event.type==='response.output_item.done'&&event.data?.item?.type==='image_generation_call'){
          imageItem=event.data.item
          if(typeof imageItem.result==='string')b64=imageItem.result
        }
        if(event.type==='response.completed')completed=event.data.response
        if(['error','response.failed','response.incomplete'].includes(event.type))record.error=safeError(event.data?.response?.error||event.data?.error||event.data)
      }
      if(imageItem)record.returnedTool=Object.fromEntries(Object.entries(imageItem).filter(([k])=>!['result','revised_prompt'].includes(k)))
      record.responseId=completed?.id
    }else{
      const payload=await response.json();b64=payload.data?.[0]?.b64_json
      if(!response.ok||!b64)record.error=safeError(payload.error||payload.detail||'No image')
    }
    if(b64){
      const bytes=Buffer.from(b64,'base64');record.actual=imageFileInfo(b64,body.size||body.tools?.[0]?.size||'auto');record.bytes=bytes.length
      record.file=`${id}.${record.actual.format||'bin'}`;record.sha256=crypto.createHash('sha256').update(bytes).digest('hex')
      fs.writeFileSync(path.join(outDir,record.file),bytes)
      if(record.actual.format==='jpeg')record.jpegQuantization=jpegQuantization(bytes)
    }
  }catch(error){record.error=safeError(error)}
  record.seconds=Math.round((Date.now()-started)/1000);record.hasImage=!!b64
  report.tests.push(record);save();console.log(JSON.stringify(record))
  return {record,b64,imageItem,completed}
}
function jpegQuantization(bytes){
  const tables=[]
  for(let p=2;p+4<=bytes.length;){
    if(bytes[p]!==255)break
    const marker=bytes[p+1];if(marker===0xda||marker===0xd9)break
    const length=bytes.readUInt16BE(p+2);if(length<2||p+2+length>bytes.length)break
    if(marker===0xdb)tables.push(bytes.subarray(p+4,p+2+length).toString('hex'))
    p+=length+2
  }
  return tables
}
const fixturePrompt='A studio photograph of a completely fictional adult woman, short dark curly hair, brown eyes, thin round gold glasses, pale blue sweater, holding a small white card clearly marked LAB 27. Plain light gray background. Frontal head and shoulders, centered, soft even light, no real person likeness.'
const raw = (input,tool={},extra={}) => ({model:before.imageModel,stream:true,input,tools:[{type:'image_generation',quality:'low',size:'1024x1024',output_format:'png',...tool}],tool_choice:{type:'image_generation'},...extra})
const seed=await request('portrait-base','/v1/responses',raw([{role:'user',content:fixturePrompt}]))
const formatResults={}
for(const format of ['jpeg','webp']){
  const low=await request(`${format}-30`,'/v1/images/generations',{prompt:'A minimal orange teapot icon on a pale gray background, clean flat illustration, no text.',quality:'low',size:'1024x1024',output_format:format,output_compression:30})
  formatResults[format]=[low.record]
  // Compression cannot be validated if the requested format is not returned.
  if(low.record.actual?.format===format){
    const high=await request(`${format}-90`,'/v1/images/generations',{prompt:'A minimal orange teapot icon on a pale gray background, clean flat illustration, no text.',quality:'low',size:'1024x1024',output_format:format,output_compression:90})
    formatResults[format].push(high.record)
  }
}
const size=await request('custom-size','/v1/images/generations',{prompt:'A wide horizontal minimalist mountain landscape, width exactly 1536 pixels and height exactly 864 pixels.',quality:'low',size:'1536x864',output_format:'png'})
const qualityResults=[]
for(const quality of ['xhigh','max'])qualityResults.push((await request(`quality-${quality}`,'/v1/responses',raw([{role:'user',content:'A single simple blue ceramic mug on a white background. No text.'}],{quality}))).record)
let fidelity
if(seed.b64){
  fidelity=await request('fidelity-high','/v1/images/edits',{prompt:'Change ONLY the plain gray background to solid teal. Preserve exactly the same fictional woman, identity, facial features, curly hairstyle, round gold glasses, blue sweater and LAB 27 card. Do not remove or rewrite the card.',image:`data:image/png;base64,${seed.b64}`,input_fidelity:'high',quality:'low',size:'1024x1024'})
}
let continuation, explicit, third
if(seed.b64&&seed.completed?.id){
  continuation=await request('continuation-id','/v1/responses',raw([{role:'user',content:'Edit the previous image: change ONLY the background to solid teal. Preserve the same fictional woman and her LAB 27 card.'}],{action:'edit'},{previous_response_id:seed.completed.id}))
}
if(seed.b64&&!continuation?.b64){
  explicit=await request('continuation-context','/v1/responses',raw([{role:'user',content:[{type:'input_image',image_url:`data:image/png;base64,${seed.b64}`},{type:'input_text',text:'This is the first-round generated image. In this second round, change ONLY the background to solid teal. Preserve the woman, her round glasses, blue sweater and LAB 27 card.'}]}],{action:'edit'}))
}
const second=continuation?.b64?continuation:explicit
if(second?.b64){
  third=await request('continuation-third','/v1/responses',raw([{role:'user',content:'First round: generate a fictional woman with curly hair, round glasses, a blue sweater and a LAB 27 card. Second round: change the background to teal.'},{role:'assistant',content:[{type:'output_text',text:'The second-round image has been generated.'}]},{role:'user',content:[{type:'input_image',image_url:`data:image/png;base64,${second.b64}`},{type:'input_text',text:'Third round: change ONLY the sweater to burgundy red. Preserve the teal background, same woman, hairstyle, round glasses and LAB 27 card.'}]}],{action:'edit'}))
}
report.features.format={status:Object.values(formatResults).every(t=>t[0].actual?.format===t[0].requested.output_format)?'passed':'limited',detail:Object.entries(formatResults).map(([format,tests])=>`${format.toUpperCase()} 请求实际返回 ${tests[0].actual?.format?.toUpperCase()||'失败'}`).join('；')+'。PNG 已有真实出图记录。'}
report.features.compression={status:'limited',detail:Object.entries(formatResults).map(([format,tests])=>`${format.toUpperCase()}：${tests.length===2?`已比较 30/90 两档（${tests[0].bytes}/${tests[1].bytes} 字节），独立生成内容不同，不能单靠文件大小证明压缩档位效果`: '未返回要求格式，压缩效果无法验收'}`).join('；')+'。'}
report.features.size={status:size.record.actual?.actual==='1536x864'?'passed':'limited',detail:`请求自定义 1536×864，实际返回 ${size.record.actual?.actual||'失败'}；网关保留原图，不自动缩放。`}
report.features.quality={status:qualityResults.every(r=>r.hasImage&&r.returnedTool?.quality===r.requested.tools[0].quality)?'passed':'limited',detail:qualityResults.map(r=>`${r.id.replace('quality-','')}：${r.hasImage?'已出图':'未出图'}${r.returnedTool?.quality?`，上游报告 ${r.returnedTool.quality}`: '，未返回实际画质档位'}`).join('；')+'。仅参数接受不证明画质提升。'}
report.features.fidelity={status:fidelity?.record.hasImage?'limited':fidelity?.record.httpStatus===400?'unsupported':'failed',detail:fidelity?.record.hasImage?'input_fidelity=high 请求已出图；需要对照合成人像、眼镜和 LAB 27 卡片检查，不能承诺身份或文字完全一致。':`input_fidelity=high 未完成出图：${fidelity?.record.error||'基础合成人像未生成'}`}
report.features.advanced={status:second?.b64&&third?.b64?'limited':'failed',detail:`previous_response_id：${continuation?.b64?'续图成功':continuation?.record.error||'未返回可续接 ID'}；显式回传上一轮图像：${second?.b64&&third?.b64?'二、三轮已出图，需检查上一轮改动是否保留':'未完成连续两轮编辑'}。`}
report.features.batch={status:'unsupported',detail:'当前标准接口明确限制 n=1；n=2 被本地参数校验拒绝，未发送上游，也未消耗多图额度。'}
const batch=await fetch(new URL('/v1/images/generations',base),{method:'POST',headers:headers(),body:JSON.stringify({prompt:'A blue dot',n:2}),signal:AbortSignal.timeout(15000)})
report.tests.push({id:'batch-local-validation',httpStatus:batch.status});await batch.arrayBuffer()
if(batch.status!==400)report.features.batch={status:'limited',detail:`n=2 返回 HTTP ${batch.status}，与预期本地校验不一致，未记为支持。`}
const after=await status()
if(after.activeAccountId!==before.activeAccountId||after.imageModel!==before.imageModel)throw Error('Account/model changed; do not attach evidence')
report.features=optionVerdicts(report.tests)
// A separate visual review / codec inspection may upgrade only the observed
// cases. The automated runner does not invent identity or compression results.
save()
const file=path.join(dataDir,'cache/image-verification.json');let prior
try{prior=JSON.parse(fs.readFileSync(file))}catch{}
const merge=prior?.adapterRevision===report.adapterRevision&&prior?.accountId===report.accountId&&prior?.model===report.model
const previousFeatures=Object.fromEntries(Object.entries(merge?prior.features:{}).map(([id,feature])=>[id,{...feature,checkedAt:feature.checkedAt||prior.checkedAt}]))
report.features=Object.fromEntries(Object.entries(report.features).map(([id,feature])=>[id,{...feature,checkedAt:report.checkedAt}]))
const combined={...report,features:{...previousFeatures,...report.features},tests:[...(merge?prior.tests:[]),...report.tests]}
writeJsonAtomic(file,combined)
console.log('Saved live option evidence: '+outDir)
