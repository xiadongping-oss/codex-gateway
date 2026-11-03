import test from 'node:test'
import assert from 'node:assert/strict'
import { PNG } from 'pngjs'
import { generateImage, ImageRequest, createApp, loadConfig } from '../node_modules/chatgpt-bridge/dist/index.js'
import { prepareMaskedEdit, alphaInfo, parseImageTransport, imageAttachmentSpecs, decodePng } from '../image-edit.mjs'
import { imageFileInfo } from '../image-file.mjs'
import { checkReferencePaths } from '../ref-roots.mjs'
import fs from 'node:fs'
import { imageToolRequest } from '../image-mcp.mjs'

function png(width=32,height=32,alpha=255) {
  const image=new PNG({width,height})
  for(let i=0;i<image.data.length;i+=4)image.data.set([30,80,150,alpha],i)
  return image
}
const spec=image=>({mime:'image/png',data:PNG.sync.write(image).toString('base64')})
const part=image=>({type:'input_image',image_url:'data:image/png;base64,'+spec(image).data})
const eventResponse=()=>new Response('data: '+JSON.stringify({type:'response.output_item.done',item:{type:'image_generation_call',result:spec(png()).data}})+'\n\n',{headers:{'content-type':'text/event-stream'}})
async function capture(request) {
  let body
  const upstream={async call(options){body=options.body;return eventResponse()},async raiseForStatus(){}}
  await generateImage({imageModel:'test-render-model',timeoutMs:1000},upstream,ImageRequest.parse(request))
  return body
}
test('mask reaches upstream and edit prompt preserves the input image',async()=>{
  const image=png(),mask=png();mask.data[3]=0
  const body=await capture({prompt:'Edit',image:spec(image),mask:spec(mask),input_fidelity:'high'})
  assert.equal(body.tools[0].input_image_mask.image_url,part(mask).image_url)
  assert.equal(body.input[1].content[0].image_url,part(image).image_url)
  assert.equal(body.tools[0].action,'edit');assert.equal(body.tools[0].input_fidelity,'high')
  assert.doesNotMatch(body.input[0].content,/NEW image/)
  assert.deepEqual(body.tool_choice,{type:'image_generation'})
})
test('outpainting adds transparent canvas and mask without changing input pixels',async()=>{
  const image=png()
  const result=prepareMaskedEdit({outpaint:{left:16,right:16,top:16,bottom:16},size:'auto'},[part(image)])
  assert.equal(result.size,'64x64')
  const canvas=PNG.sync.read(Buffer.from(result.parts[0].image_url.split(',')[1],'base64'))
  const mask=PNG.sync.read(Buffer.from(result.mask.split(',')[1],'base64'))
  assert.equal(canvas.data[3],0);assert.equal(mask.data[3],0)
  for(let y=0;y<32;y++)for(let x=0;x<32;x++){
    const target=((y+16)*64+x+16)*4,source=(y*32+x)*4
    assert.deepEqual(canvas.data.subarray(target,target+4),image.data.subarray(source,source+4))
    assert.equal(mask.data[target+3],255)
  }
  const body=await capture({prompt:'Extend',image:spec(image),outpaint:{left:16,right:16}})
  assert.equal(body.tools[0].size,'64x32');assert.ok(body.tools[0].input_image_mask)
})
test('invalid masks, huge PNGs and ambiguous expansion fail before upstream',async()=>{
  const source=png(),mask=png(16,16,0)
  assert.throws(()=>prepareMaskedEdit({mask:spec(mask)},[part(source)],[part(mask)]),/尺寸/)
  assert.throws(()=>prepareMaskedEdit({mask:spec(source)},[part(source)],[part(source)]),/透明/)
  assert.throws(()=>prepareMaskedEdit({mask:spec(mask),outpaint:{left:16}},[part(source)],[part(mask)]),/不能同时/)
  for(const outpaint of [{left:-1},{left:15},{left:2049},{left:0},{left:16,unexpected:1}])assert.throws(()=>prepareMaskedEdit({outpaint},[part(source)]))
  assert.throws(()=>prepareMaskedEdit({outpaint:{left:16},size:'1024x1024'},[part(source)]),/size/)
  const huge=PNG.sync.write(source);huge.writeUInt32BE(99999,16)
  assert.throws(()=>decodePng(huge),/超出/)
  await assert.rejects(()=>capture({prompt:'Missing source',mask:spec(mask)}),/必须提供/)
})
test('JSON and multipart edit routes use the adapter, not generic passthrough',async()=>{
  const {app,upstream}=createApp(loadConfig());const calls=[]
  upstream.call=async options=>{calls.push(options);return eventResponse()};upstream.raiseForStatus=async()=>{}
  const mask=png();mask.data[3]=0
  for(const multipart of [false,true]){
    const form=new FormData();form.set('prompt','Edit');form.set('image',new Blob([PNG.sync.write(png())],{type:'image/png'}),'source.png');form.set('mask',new Blob([PNG.sync.write(mask)],{type:'image/png'}),'mask.png')
    const response=await app.request('/v1/images/edits',{method:'POST',...(multipart?{body:form}:{headers:{'content-type':'application/json'},body:JSON.stringify({prompt:'Edit',image:spec(png()),mask:spec(mask)})})})
    assert.equal(response.status,200,await response.clone().text());assert.ok((await response.json()).data[0].b64_json)
  }
  assert.equal(calls.length,2);assert.ok(calls.every(c=>c.path==='/responses'&&c.body.tools[0].input_image_mask))
  const rejected=await app.request('/v1/images/edits',{method:'POST',headers:{'content-type':'application/json'},body:'{"prompt":"No image"}'})
  assert.equal(rejected.status,400);assert.equal(calls.length,2)
})
test('multipart fields and edit paths cannot bypass input validation',async()=>{
  const form=new FormData();form.set('prompt','Edit');form.append('image[]',new Blob([PNG.sync.write(png())],{type:'image/png'}),'a.png');form.set('n','1');form.set('outpaint','{"left":16}')
  const request=new Request('http://localhost/images',{method:'POST',body:form})
  const parsed=await parseImageTransport(Buffer.from(await request.arrayBuffer()),request.headers.get('content-type'),true)
  assert.equal(parsed.n,1);assert.equal(parsed.action,'edit');assert.equal(parsed.image.length,1)
  const specs=imageAttachmentSpecs({image:{path:'../secrets'},mask:{path:'../passwords'}})
  assert.equal(specs.length,2);assert.equal(checkReferencePaths(specs,'/allowed/references').ok,false)
  await assert.rejects(()=>parseImageTransport(Buffer.from('[]'),'application/json',true))
  await assert.rejects(()=>parseImageTransport(Buffer.from('{"image":"data:x","stream":true}'),'application/json',true),/stream/)
})
test('invalid combinations are rejected instead of silently ignoring options',()=>{
  for(const extra of [{n:2},{size:'99999x99999'},{size:'1001x1024'},{quality:'unsupported'},{background:'transparent',output_format:'jpeg'},{output_compression:10},{input_image_mask:{image_url:'x'}}])assert.equal(ImageRequest.safeParse({prompt:'Synthetic',...extra}).success,false,JSON.stringify(extra))
})
test('alpha checks distinguish opaque, empty and useful transparent images',()=>{
  assert.equal(alphaInfo(PNG.sync.write(png())).hasTransparentBackground,false)
  assert.equal(alphaInfo(PNG.sync.write(png(32,32,0))).hasTransparentBackground,false)
  const mixed=png();mixed.data[3]=0
  const info=alphaInfo(PNG.sync.write(mixed));assert.equal(info.hasTransparentBackground,true);assert.equal(info.transparentPixels,1)
  assert.equal(imageFileInfo(PNG.sync.write(mixed).toString('base64')).format,'png')
})
test('MCP mappings expose edits consistently; downloadable client remains standalone',()=>{
  const args={prompt:'Extend',image:'data:image/png;base64,eA==',outpaint:{left:16},background:'transparent',output_format:'png'}
  const request=imageToolRequest(args)
  assert.equal(request.endpoint,'/v1/images/edits');assert.equal(request.body.background,'transparent');assert.deepEqual(request.body.outpaint,{left:16})
  assert.equal(imageToolRequest({prompt:'Reference',reference_paths:['https://example.com/a.png']}).body.reference_images[0],'https://example.com/a.png')
  assert.throws(()=>imageToolRequest({prompt:'Edit',mask:'x'}),/image/)
  assert.throws(()=>imageToolRequest({prompt:'Edit',reference_paths:Array(9).fill('x')}),/8/)
  const shared=fs.readFileSync(new URL('../image-mcp.mjs',import.meta.url),'utf8').replaceAll('export const ','const ').replaceAll('export function ','function ')
  assert.ok(fs.readFileSync(new URL('../../docs/lan-kit/mcp-server.mjs',import.meta.url),'utf8').includes(shared),'shared mapping must stay identical in the zero-dependency client')
})
