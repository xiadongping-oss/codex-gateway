import {test} from 'node:test'
import assert from 'node:assert/strict'
import {extractUsage} from '../response-usage.mjs'
test('JSON and nested Responses SSE preserve actual usage',()=>{
  assert.deepEqual(extractUsage('{"usage":{"prompt_tokens":12,"completion_tokens":3}}'),{promptTokens:12,completionTokens:3,totalTokens:15})
  assert.deepEqual(extractUsage('data: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":2}}}\r\n\r\ndata: [DONE]\r\n'),{promptTokens:8,completionTokens:2,totalTokens:10})
  assert.equal(extractUsage('{"usage":{"total_tokens":7}}').totalTokens,7)
  assert.equal(extractUsage('data: {"choices":[]}\n\n'),null)
  assert.equal(extractUsage('{"usage":{"input_tokens":-1}}'),null)
})
