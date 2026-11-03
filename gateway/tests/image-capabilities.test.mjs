import test from 'node:test'
import assert from 'node:assert/strict'
import { generateImage, ImageRequest } from '../node_modules/chatgpt-bridge/dist/index.js'
import { gatewayCapabilities } from '../capabilities.mjs'

async function capture(request) {
  let body
  const upstream = {
    async call(options) {
      body = options.body
      const event = { type:'response.output_item.done', item: { type:'image_generation_call', result:'synthetic-base64' } }
      return new Response('event: response.output_item.done\ndata: '+JSON.stringify(event)+'\n\n', { headers:{'Content-Type':'text/event-stream'} })
    },
    async raiseForStatus() {},
  }
  await generateImage({imageModel:'synthetic-render-model',timeoutMs:1000},upstream,ImageRequest.parse(request))
  return body
}
test('advanced output parameters reach the adapter while aliases stay separate from actual renderer',async()=>{
  const body=await capture({prompt:'Synthetic test',model:'different-image-alias',background:'transparent',input_fidelity:'high',output_format:'webp',output_compression:80})
  assert.equal(body.model,'synthetic-render-model')
  const tool=body.tools[0]
  assert.equal(tool.type,'image_generation')
  for(const field of ['background','input_fidelity','output_format','output_compression'])assert.equal(Object.hasOwn(tool,field),true,field+' must reach upstream')
  const features=gatewayCapabilities().image
  assert.equal(features.find(f=>f.id==='transparent').status,'wired')
  assert.equal(features.find(f=>f.id==='mask').status,'wired')
  assert.equal(features.find(f=>f.id==='advanced').status,'unverified')
})
test('reference images, size and quality reach the real outgoing request; reference path is regeneration',async()=>{
  const ref={mime:'image/png',data:Buffer.from('synthetic-image').toString('base64')}
  const body=await capture({prompt:'Synthetic repaint',reference_images:[ref],size:'1536x1024',quality:'medium'})
  assert.equal(body.tools[0].size,'1536x1024');assert.equal(body.tools[0].quality,'medium')
  assert.equal(body.input[1].content[0].type,'input_image')
  assert.ok(body.input[1].content[0].image_url.startsWith('data:image/png;base64,'))
  assert.match(body.input[0].content,/NEW image/)
})
test('advertised standard-image limits match runtime validation and provider mode stays unverified',()=>{
  for(const extra of [{n:2},{size:'1001x1024'},{quality:'unsupported'},{reference_images:Array(9).fill('data:image/png;base64,eA==')}])assert.equal(ImageRequest.safeParse({prompt:'Synthetic',...extra}).success,false)
  assert.ok(gatewayCapabilities('openai').image.every(feature=>feature.status==='provider'))
})
