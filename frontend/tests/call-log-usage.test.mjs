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

test('token column tells an interrupted stream from an upstream that omitted usage', () => {
  assert.equal(callTokenText({method:'POST',status:200,tokens:null,streamEnd:'interrupted',usageState:'interrupted'}), '流中断')
  assert.equal(callTokenText({method:'POST',status:200,tokens:null,streamEnd:'normal',usageState:'no-usage'}), '上游未返回')
  assert.equal(callTokenText({method:'POST',status:200,tokens:null}), '未返回')
  // 有 usage 就优先显示数字：即使流后来被掐断，用量也已经真实发生
  assert.equal(callTokenText({method:'POST',status:200,streamEnd:'interrupted',usage:{totalTokens:9}}), '9')
})
