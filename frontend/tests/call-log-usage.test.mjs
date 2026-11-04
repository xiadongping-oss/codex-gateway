import test from 'node:test'
import assert from 'node:assert/strict'
import { callTokenCount, callTokenText } from '../src/callLogUsage.js'

test('token column supports stored usage, old records and actual zero counts', () => {
  assert.equal(callTokenCount({tokens:42}),42)
  assert.equal(callTokenCount({usage:{promptTokens:8,completionTokens:4}}),12)
  assert.equal(callTokenCount({tokens:0,usage:{totalTokens:27}}),27)
  assert.equal(callTokenText({tokens:0}), '0')
  assert.equal(callTokenText({method:'GET',tokens:null}), '—')
  assert.equal(callTokenText({method:'POST',status:200,tokens:null}), '未返回')
  assert.equal(callTokenText({method:'POST',status:401,tokens:null}), '—')
})
