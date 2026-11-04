import {test} from 'node:test'
import assert from 'node:assert/strict'
import {extractUsage,createUsageCollector,createUsageTap,createChatUsageFilter} from '../response-usage.mjs'
test('JSON and nested Responses SSE preserve actual usage',()=>{
  assert.deepEqual(extractUsage('{"usage":{"prompt_tokens":12,"completion_tokens":3}}'),{promptTokens:12,completionTokens:3,totalTokens:15})
  assert.deepEqual(extractUsage('data: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":2}}}\r\n\r\ndata: [DONE]\r\n'),{promptTokens:8,completionTokens:2,totalTokens:10})
  assert.equal(extractUsage('{"usage":{"total_tokens":7}}').totalTokens,7)
  assert.equal(extractUsage('data: {"choices":[]}\n\n'),null)
  assert.equal(extractUsage('{"usage":{"input_tokens":-1}}'),null)
})

import { Readable } from 'node:stream'
import { gzipSync, brotliCompressSync } from 'node:zlib'

async function through(bytes, ...streams) {
  let output = Readable.from([...bytes].map(byte => Buffer.from([byte])))
  for (const stream of streams) output = output.pipe(stream)
  const chunks = []
  for await (const chunk of output) chunks.push(chunk)
  return Buffer.concat(chunks)
}

test('large JSON retains usage at either end without parsing response text as usage', () => {
  const usage = { input_tokens: 12, output_tokens: 6, total_tokens: 18 }
  for (const body of [{ usage, output: '图片'.repeat(100000) }, { output: '图片'.repeat(100000), usage }]) {
    const collector = createUsageCollector()
    const bytes = Buffer.from(JSON.stringify(body))
    for (let start = 0; start < bytes.length; start += 101) collector.write(bytes.subarray(start, start + 101))
    assert.equal(collector.end().totalTokens, 18)
  }
  assert.equal(extractUsage(JSON.stringify({ output: { usage }, message: JSON.stringify({usage}) })), null)
  assert.equal(extractUsage('{"usage":{}}'), null)
})

test('gzip and brotli observation preserves response bytes and reports usage once', async () => {
  const json = Buffer.from(JSON.stringify({ output:'文本', usage:{input_tokens:8,output_tokens:4} }))
  for (const [encoding, compress] of [['gzip',gzipSync], ['br',brotliCompressSync]]) {
    const input = compress(json), usages = []
    const output = await through(input, createUsageTap({ encoding, onUsage: usage => usages.push(usage) }))
    assert.deepEqual(output, input)
    assert.deepEqual(usages, [{promptTokens:8,completionTokens:4,totalTokens:12}])
  }
})

test('bridge SSE counts usage internally without adding unsolicited client chunks', async () => {
  const content = 'data: '+JSON.stringify({choices:[{delta:{content:'中文与😀'}}]})+'\r\n\r\n'
  const usage = 'data: '+JSON.stringify({choices:[],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}})+'\r\n\r\n'
  const done = 'data: [DONE]\r\n\r\n', usages = []
  const input = Buffer.from(content + usage + done)
  const output = await through(input, createUsageTap({onUsage: usage => usages.push(usage)}), createChatUsageFilter())
  assert.equal(output.toString(), content + done)
  assert.deepEqual(usages, [{promptTokens:3,completionTokens:2,totalTokens:5}])
})

test('chat filtering preserves oversized events, split delimiters, and ordinary finish chunks', async () => {
  const big = 'data: '+JSON.stringify({choices:[{delta:{content:'a'.repeat(1024*1024+10)}}]})+'\n\n'
  const tail = 'data: '+JSON.stringify({choices:[{finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n'
  const stream = Readable.from([Buffer.from(big.slice(0,-1)), Buffer.from(big.slice(-1)+tail)]).pipe(createChatUsageFilter())
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  assert.equal(Buffer.concat(chunks).toString(),big+tail)
})
