// Chat Completions <-> Codex Responses 工具调用转换的回归测试（chat-tools.mjs）
//
// 为什么值得测：这块断链是「沉默的」——
//   · 上游只收到 [{type:"image_generation"}]，模型如实回答"我只会生图"，
//     调用方看到的是"模型不支持工具"，而不是"我们的转换层把工具丢了"；
//   · function_call_arguments.done 若整串重发，参数会翻倍成 `{"a":1}{"a":1}`，
//     客户端 JSON.parse 失败，表现为"工具调用偶发报错"这种最难查的现象；
//   · finish_reason 恒为 stop 时，客户端根本不会进入执行工具的分支，
//     连错误都看不到，只是"模型不干活"。
// 所以下面每一条都针对一种"看起来正常、实际断链"的写法。
//
// 事件形状取自 2026-10-29 本机 Codex 上游实测探针（/v1/responses）：
//   response.created / output_item.added / function_call_arguments.delta(带 output_index)
//   / function_call_arguments.done / output_item.done / response.completed

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  convertChatToolsToResponses,
  convertChatToolChoiceToResponses,
  convertChatToolCallsToResponsesItems,
  convertChatToolMessageToResponsesItem,
  usageFromResponses,
  buildResponsesSampling,
  buildResponsesReasoning,
  finishReasonFromStatus,
  createResponsesToChatTranslator,
  createChatAccumulator,
  applyChatChunk,
  finalizeChatAccumulator
} from '../chat-tools.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GW = path.resolve(HERE, '..')
const REPO = path.resolve(GW, '..')
// 变异测试只把 chat-tools.mjs 与本文件复制进沙盒，bridge 与 launcher 都不在；
// 涉及跨文件一致性的用例必须跳过，否则变异体会被"文件不存在"杀死——那是假杀死。
const DIST = path.join(GW, 'node_modules', 'chatgpt-bridge', 'dist', 'cli.js')
const hasBridge = fs.existsSync(DIST)
const needBridge = hasBridge ? false : '只在完整仓库里跑（变异沙盒不含 vendored bridge）'

// ---------- 组装小工具 ----------

const fnTool = (name, extra = {}) => ({
  type: 'function',
  function: {
    name,
    description: 'd',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    ...extra
  }
})

/** 跑一串 Responses 事件，返回 { chunks, images } */
function runEvents(events, opts = {}) {
  const tr = createResponsesToChatTranslator({ id: 'chatcmpl_x', model: 'm', created: 1, ...opts })
  const chunks = []
  const images = []
  for (const ev of events) {
    for (const out of tr.toChatChunks(ev)) {
      if (out.chunk) chunks.push(out.chunk)
      else if (out.imageResult !== undefined) images.push(out.imageResult)
    }
  }
  for (const out of tr.finalize()) if (out.chunk) chunks.push(out.chunk)
  return { chunks, images, tr }
}

/** 从上一步的 chunk 里还原工具调用（模拟客户端的拼接方式） */
function collectTools(chunks) {
  const byIndex = new Map()
  let finish = null
  let usage = null
  let content = ''
  for (const c of chunks) {
    if (c.usage) usage = c.usage
    const ch = c.choices && c.choices[0]
    if (!ch) continue
    const d = ch.delta || {}
    if (typeof d.content === 'string') content += d.content
    if (Array.isArray(d.tool_calls)) {
      for (const t of d.tool_calls) {
        const i = t.index ?? 0
        if (!byIndex.has(i)) byIndex.set(i, { id: '', name: '', arguments: '' })
        const cur = byIndex.get(i)
        if (t.id) cur.id = t.id
        if (t.function && t.function.name && !cur.name) cur.name = t.function.name
        if (t.function && typeof t.function.arguments === 'string') cur.arguments += t.function.arguments
      }
    }
    if (ch.finish_reason) finish = ch.finish_reason
  }
  return { tools: [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v), finish, usage, content }
}

// ---------- convertChatToolsToResponses ----------

test('tools：function 工具的字段提升到顶层，name/description/parameters 一个都不能少', () => {
  const out = convertChatToolsToResponses([fnTool('read_file')], undefined, { ensureImageTool: false })
  assert.equal(out.length, 1)
  assert.deepEqual(out[0], {
    type: 'function',
    name: 'read_file',
    description: 'd',
    parameters: { type: 'object', properties: { path: { type: 'string' } } }
  })
  // 顶层必须有 name：Responses 不认 {type:'function', function:{...}} 这种嵌套写法
  assert.equal(out[0].function, undefined, '不应该保留 function 嵌套层')
})

test('tools：legacy functions 参数也合并成 function 工具（老客户端还在用）', () => {
  const out = convertChatToolsToResponses(undefined, [{ name: 'bash', description: 'run' }], { ensureImageTool: false })
  assert.equal(out.length, 1)
  assert.equal(out[0].type, 'function')
  assert.equal(out[0].name, 'bash')
})

test('tools：非 function 工具原样透传，不能被丢掉', () => {
  const web = { type: 'web_search' }
  const out = convertChatToolsToResponses([web, fnTool('read_file')], undefined, { ensureImageTool: false })
  assert.equal(out.length, 2)
  assert.ok(out.includes(web), 'web_search 必须原样保留')
})

test('tools：缺 name 的 function 直接丢弃，不能发出一个没有名字的工具', () => {
  const out = convertChatToolsToResponses([{ type: 'function', function: { description: 'x' } }], undefined, {
    ensureImageTool: false
  })
  assert.equal(out.length, 0, '没名字的工具会让上游直接拒绝整批请求')
})

test('tools：调用方没给 image_generation 时才追加，已经给了就不能重复', () => {
  const appended = convertChatToolsToResponses([fnTool('read_file')])
  assert.equal(appended.filter((t) => t.type === 'image_generation').length, 1, '默认补一个，保住生图能力')
  const notDup = convertChatToolsToResponses([fnTool('read_file'), { type: 'image_generation' }])
  assert.equal(notDup.filter((t) => t.type === 'image_generation').length, 1, '重复 image_generation 会被上游判为非法工具列表')
})

test('tools：ensureImageTool=false 时一个都不补（调用方明确只要 function）', () => {
  const out = convertChatToolsToResponses([fnTool('read_file')], undefined, { ensureImageTool: false })
  assert.equal(out.some((t) => t.type === 'image_generation'), false)
})

test('tools：parameters 缺失时补默认 object schema，而不是 undefined', () => {
  const out = convertChatToolsToResponses([{ type: 'function', function: { name: 'ping' } }], undefined, {
    ensureImageTool: false
  })
  assert.deepEqual(out[0].parameters, { type: 'object', properties: {} })
})

test('tools：strict 原样保留（调用方开了严格模式不能被悄悄降级）', () => {
  const out = convertChatToolsToResponses([fnTool('read_file', { strict: true })], undefined, { ensureImageTool: false })
  assert.equal(out[0].strict, true)
})

test('tools：输入是垃圾值也不崩，退化成「只有生图」而不是抛异常', () => {
  assert.deepEqual(convertChatToolsToResponses(null, null), [{ type: 'image_generation' }])
  assert.deepEqual(convertChatToolsToResponses([null, 42, 'x'], null), [{ type: 'image_generation' }])
})

// ---------- convertChatToolChoiceToResponses ----------

test('tool_choice：字符串 required/auto/none 原样下发', () => {
  const tools = convertChatToolsToResponses([fnTool('read_file')])
  for (const v of ['auto', 'none', 'required']) {
    assert.equal(convertChatToolChoiceToResponses(v, undefined, tools), v)
  }
})

test('tool_choice：{type:function,function:{name}} 扁平化成 {type:function,name}', () => {
  const tools = convertChatToolsToResponses([fnTool('read_file')])
  const r = convertChatToolChoiceToResponses({ type: 'function', function: { name: 'read_file' } }, undefined, tools)
  assert.deepEqual(r, { type: 'function', name: 'read_file' })
})

test('tool_choice：指定了一个并不存在的函数时降级为 auto，不能把 400 抛给用户', () => {
  const tools = convertChatToolsToResponses([fnTool('read_file')])
  const r = convertChatToolChoiceToResponses({ type: 'function', function: { name: 'nope' } }, undefined, tools)
  assert.equal(r, 'auto')
})

test('tool_choice：legacy function_call {name} 也扁平化（老客户端写法）', () => {
  const tools = convertChatToolsToResponses([fnTool('read_file')])
  assert.deepEqual(convertChatToolChoiceToResponses(undefined, { name: 'read_file' }, tools), {
    type: 'function',
    name: 'read_file'
  })
})

test('tool_choice：legacy function_call 指向不存在函数时同样降级 auto', () => {
  const tools = convertChatToolsToResponses([fnTool('read_file')])
  assert.equal(convertChatToolChoiceToResponses(undefined, { name: 'nope' }, tools), 'auto')
})

test('tool_choice：allowed_tools 是选择策略不是具体工具，原样下发', () => {
  const raw = { type: 'allowed_tools', tools: [{ type: 'function', name: 'read_file' }] }
  const tools = convertChatToolsToResponses([fnTool('read_file')])
  assert.deepEqual(convertChatToolChoiceToResponses(raw, undefined, tools), raw)
})

test('tool_choice：其它类型在 tools 里不存在时降级 auto', () => {
  // 注意 tools 必须是调用方真正下发的那份：默认追加的 image_generation 也算存在，
  // 拿它来测"不存在"只会得到"原样下发"，测不出降级。
  const tools = convertChatToolsToResponses([fnTool('read_file')], undefined, { ensureImageTool: false })
  assert.equal(convertChatToolChoiceToResponses({ type: 'web_search' }, undefined, tools), 'auto')
  assert.equal(convertChatToolChoiceToResponses({ type: 'image_generation' }, undefined, tools), 'auto')
  // 反过来：工具列表里确实有它时必须原样下发，不能一律降级
  const withImage = convertChatToolsToResponses([fnTool('read_file')])
  assert.deepEqual(convertChatToolChoiceToResponses({ type: 'image_generation' }, undefined, withImage), {
    type: 'image_generation'
  })
})

test('tool_choice：都没给就返回 undefined（让上游用自己的默认，不要塞 auto）', () => {
  const tools = convertChatToolsToResponses([fnTool('read_file')])
  assert.equal(convertChatToolChoiceToResponses(undefined, undefined, tools), undefined)
  assert.equal(convertChatToolChoiceToResponses(null, null, tools), undefined)
})

// ---------- convertChatToolCallsToResponsesItems ----------

test('assistant.tool_calls：转成 function_call 并保留 call_id（第二轮要靠它配对）', () => {
  const items = convertChatToolCallsToResponsesItems([
    { id: 'call_abc', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }
  ])
  assert.deepEqual(items, [{ type: 'function_call', call_id: 'call_abc', name: 'read_file', arguments: '{"path":"a"}' }])
})

test('assistant.tool_calls：没有 id 时补 call_legacy_N，且按序编号', () => {
  const items = convertChatToolCallsToResponsesItems([
    { function: { name: 'a', arguments: '{}' } },
    { function: { name: 'b', arguments: '{}' } }
  ])
  assert.equal(items[0].call_id, 'call_legacy_1')
  assert.equal(items[1].call_id, 'call_legacy_2')
})

test('assistant.tool_calls：arguments 空串补 {}，对象则序列化（上游只认字符串）', () => {
  const items = convertChatToolCallsToResponsesItems([
    { id: 'c1', function: { name: 'a', arguments: '' } },
    { id: 'c2', function: { name: 'b', arguments: { x: 1 } } }
  ])
  assert.equal(items[0].arguments, '{}', '空参数必须是合法 JSON，否则上游拒绝整个 input')
  assert.equal(items[1].arguments, '{"x":1}')
})

test('assistant.tool_calls：缺 name 的条目跳过，不产出畸形 function_call', () => {
  assert.deepEqual(convertChatToolCallsToResponsesItems([{ id: 'c1', function: { arguments: '{}' } }]), [])
  assert.deepEqual(convertChatToolCallsToResponsesItems(undefined), [])
})

// ---------- convertChatToolMessageToResponsesItem ----------

test('role:tool：转成 function_call_output，tool_call_id 原样带回', () => {
  const item = convertChatToolMessageToResponsesItem({ role: 'tool', tool_call_id: 'call_abc', content: 'ok' })
  assert.deepEqual(item, { type: 'function_call_output', call_id: 'call_abc', output: 'ok' })
})

test('role:tool：call_id / id 依次兜底，三个都没有则返回 null', () => {
  assert.equal(convertChatToolMessageToResponsesItem({ call_id: 'x', content: 'ok' }).call_id, 'x')
  assert.equal(convertChatToolMessageToResponsesItem({ id: 'y', content: 'ok' }).call_id, 'y')
  // 孤儿输出会让上游拒绝：返回 null 让调用方退回普通 user 消息
  assert.equal(convertChatToolMessageToResponsesItem({ content: 'ok' }), null)
})

test('role:tool：空结果写 (empty)，不能传空字符串（上游会当成无效输出）', () => {
  assert.equal(convertChatToolMessageToResponsesItem({ tool_call_id: 'c', content: '' }).output, '(empty)')
  assert.equal(convertChatToolMessageToResponsesItem({ tool_call_id: 'c' }).output, '(empty)')
})

test('role:tool：数组型 content 也要抽取文本', () => {
  const item = convertChatToolMessageToResponsesItem({
    tool_call_id: 'c',
    content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }]
  })
  assert.equal(item.output, 'A\nB')
})

// ---------- 采样参数与思考强度 ----------

test('采样参数：temperature / top_p 一律剔除（上游实测 400 Unsupported parameter）', () => {
  // 这两个参数几乎所有 OpenAI 客户端都会默认带上（temperature:1 最常见）。
  // 转发它们 = 每个客户端全量 400，而报错里只说"上游不支持"，看不出是网关的锅。
  assert.deepEqual(buildResponsesSampling({ temperature: 0.7, top_p: 0.9 }), {})
  assert.deepEqual(buildResponsesSampling({ temperature: 1 }), {})
  assert.deepEqual(buildResponsesSampling(undefined), {})
  assert.deepEqual(buildResponsesSampling({}), {})
})

test('思考强度：reasoning_effort 映射成 Responses 的 reasoning 对象', () => {
  assert.deepEqual(buildResponsesReasoning({ reasoning_effort: 'high' }), { effort: 'high', summary: 'auto' })
  assert.deepEqual(buildResponsesReasoning({ reasoning: { effort: 'xhigh' } }), { effort: 'xhigh', summary: 'auto' })
})

test('思考强度：顶层 reasoning_effort 优先于嵌套 reasoning.effort', () => {
  assert.deepEqual(buildResponsesReasoning({ reasoning_effort: 'low', reasoning: { effort: 'max' } }), {
    effort: 'low',
    summary: 'auto'
  })
})

test('思考强度：大小写不敏感（客户端可能发 High / MAX）', () => {
  assert.equal(buildResponsesReasoning({ reasoning_effort: 'HIGH' }).effort, 'high')
  assert.equal(buildResponsesReasoning({ reasoning_effort: ' Max ' }).effort, 'max')
})

test('思考强度：未知强度一律不下发，不能把 400 甩给调用方', () => {
  // 'minimal' 是 OpenAI o 系列的取值，Codex 上游明确不支持
  for (const bad of ['minimal', 'none', '', '极致', 'ultra', undefined, null, 3]) {
    assert.equal(buildResponsesReasoning({ reasoning_effort: bad }), undefined, `${JSON.stringify(bad)} 应被忽略`)
  }
  assert.equal(buildResponsesReasoning(undefined), undefined)
})

test('思考强度：调用方显式给了 summary 就沿用', () => {
  assert.deepEqual(buildResponsesReasoning({ reasoning: { effort: 'high', summary: 'detailed' } }), {
    effort: 'high',
    summary: 'detailed'
  })
})

// ---------- usage / finish_reason ----------

test('usage：input/output tokens 映射成 prompt/completion 并算出 total', () => {
  assert.deepEqual(usageFromResponses({ input_tokens: 12, output_tokens: 5 }), {
    prompt_tokens: 12,
    completion_tokens: 5,
    total_tokens: 17
  })
})

test('usage：上游没给 usage 时返回 0，不许是 undefined（客户端会崩）', () => {
  assert.deepEqual(usageFromResponses(undefined), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
  assert.deepEqual(usageFromResponses({}), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
})

test('finish_reason：completed 且有工具调用 -> tool_calls，无工具 -> stop', () => {
  assert.equal(finishReasonFromStatus('completed', '', true), 'tool_calls')
  assert.equal(finishReasonFromStatus('completed', '', false), 'stop')
})

test('finish_reason：incomplete 按原因映射 length / content_filter', () => {
  assert.equal(finishReasonFromStatus('incomplete', 'max_output_tokens', false), 'length')
  assert.equal(finishReasonFromStatus('incomplete', 'content_filter', false), 'content_filter')
  assert.equal(finishReasonFromStatus('incomplete', '', false), 'stop', '未知原因不能返回 null')
})

test('finish_reason：failed 也必须是 stop，不能返回 null 把客户端卡住', () => {
  assert.equal(finishReasonFromStatus('failed', '', false), 'stop')
})

// ---------- 转换器：流式事件 -> Chat chunk ----------

const addedEvt = (outputIndex, callId, name) => ({
  type: 'response.output_item.added',
  data: { output_index: outputIndex, item: { type: 'function_call', id: 'fc_1', call_id: callId, name } }
})
const argsDeltaEvt = (outputIndex, delta) => ({
  type: 'response.function_call_arguments.delta',
  data: { output_index: outputIndex, item_id: 'fc_1', delta }
})
const argsDoneEvt = (outputIndex, args) => ({
  type: 'response.function_call_arguments.done',
  data: { output_index: outputIndex, item_id: 'fc_1', arguments: args }
})
const completedEvt = (usage) => ({
  type: 'response.completed',
  data: { response: { id: 'resp_1', status: 'completed', usage } }
})

test('转换器：output_item.added 发出首帧，带 index / id(=call_id) / name', () => {
  const { chunks } = runEvents([addedEvt(0, 'call_abc', 'read_file'), completedEvt()])
  const first = chunks.find((c) => c.choices[0].delta.tool_calls)
  assert.ok(first, '必须有一帧声明工具，否则客户端只看到一个空 tool_call')
  const tc = first.choices[0].delta.tool_calls[0]
  assert.equal(tc.index, 0)
  assert.equal(tc.id, 'call_abc', 'id 要取 call_id（item_id 是 fc_ 前缀，后续配对会错）')
  assert.equal(tc.type, 'function')
  assert.equal(tc.function.name, 'read_file')
})

test('转换器：arguments.delta 逐片拼接后必须还原成合法 JSON', () => {
  const full = '{"path":"E:/a.json"}'
  const events = [addedEvt(0, 'call_abc', 'read_file')]
  for (const piece of full.match(/.{1,5}/g)) events.push(argsDeltaEvt(0, piece))
  events.push(completedEvt())
  const { chunks } = runEvents(events)
  const { tools, finish } = collectTools(chunks)
  assert.equal(tools[0].arguments, full)
  assert.doesNotThrow(() => JSON.parse(tools[0].arguments), '参数必须能直接 JSON.parse')
  assert.equal(finish, 'tool_calls')
})

test('转换器：arguments.done 在 delta 已收全时不再补发（否则参数翻倍）', () => {
  const full = '{"a":1}'
  const tr = createResponsesToChatTranslator({ id: 'x', model: 'm', created: 1 })
  const chunks = []
  for (const ev of [addedEvt(0, 'call_abc', 'read_file'), argsDeltaEvt(0, full), argsDoneEvt(0, full)]) {
    for (const out of tr.toChatChunks(ev)) if (out.chunk) chunks.push(out.chunk)
  }
  const doneOut = tr.toChatChunks(argsDoneEvt(0, full))
  assert.equal(doneOut.length, 0, `done 不能再发一轮完整参数，否则拼出来是 ${full}${full}`)
  // 端到端看一眼：整条流拼完必须还能 JSON.parse，翻倍的话这里必然抛
  const { tools } = collectTools(chunks)
  assert.equal(tools[0].arguments, full)
  assert.doesNotThrow(() => JSON.parse(tools[0].arguments))
})

test('转换器：delta 漏掉尾部时，done 只补剩余那一段', () => {
  const tr = createResponsesToChatTranslator({ id: 'x', model: 'm', created: 1 })
  tr.toChatChunks(addedEvt(0, 'call_abc', 'read_file'))
  tr.toChatChunks(argsDeltaEvt(0, '{"a"'))
  const doneOut = tr.toChatChunks(argsDoneEvt(0, '{"a":1}'))
  assert.equal(doneOut.length, 1, '缺的那一段必须补上，否则参数是残缺 JSON')
  assert.equal(doneOut[0].chunk.choices[0].delta.tool_calls[0].function.arguments, ':1}')
})

test('转换器：多个工具各占一个 index，参数不会串到一起', () => {
  const events = [
    addedEvt(0, 'call_1', 'read_file'),
    argsDeltaEvt(0, '{"a":1}'),
    addedEvt(1, 'call_2', 'write_file'),
    argsDeltaEvt(1, '{"b":2}'),
    completedEvt()
  ]
  const { chunks } = runEvents(events)
  const { tools } = collectTools(chunks)
  assert.equal(tools.length, 2, '两个工具必须是两条 tool_call')
  assert.equal(tools[0].id, 'call_1')
  assert.equal(tools[0].name, 'read_file')
  assert.equal(tools[0].arguments, '{"a":1}')
  assert.equal(tools[1].id, 'call_2')
  assert.equal(tools[1].name, 'write_file')
  assert.equal(tools[1].arguments, '{"b":2}', 'output_index=1 的参数不能落到第一个工具上')
})

test('转换器：纯文本流结束是 stop，且文本一片都不能丢', () => {
  const events = [
    { type: 'response.output_text.delta', data: { delta: '你好' } },
    { type: 'response.output_text.delta', data: { delta: '，世界' } },
    completedEvt({ input_tokens: 3, output_tokens: 4 })
  ]
  const { chunks } = runEvents(events)
  const { finish, content } = collectTools(chunks)
  assert.equal(content, '你好，世界')
  assert.equal(finish, 'stop')
})

test('转换器：只有 explicit 请求 include_usage 才额外发 usage chunk', () => {
  const events = [{ type: 'response.output_text.delta', data: { delta: 'x' } }, completedEvt({ input_tokens: 7, output_tokens: 2 })]
  const withUsage = runEvents(events, { includeUsage: true })
  const usageChunks = withUsage.chunks.filter((c) => c.usage)
  assert.equal(usageChunks.length, 1)
  assert.deepEqual(usageChunks[0].usage, { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 })

  const without = runEvents(events, { includeUsage: false })
  assert.equal(without.chunks.filter((c) => c.usage).length, 0, '没要求 usage 就不该多发一帧（部分客户端会误判成第二条 choice）')
})

test('转换器：生图结果是 imageResult 而不是 chunk（落盘后再转 Markdown）', () => {
  const { chunks, images } = runEvents(
    [{ type: 'response.output_item.done', data: { item: { type: 'image_generation_call', result: 'BASE64' } } }, completedEvt()]
  )
  assert.deepEqual(images, ['BASE64'])
  assert.equal(chunks.some((c) => (c.choices[0]?.delta?.content || '').includes('BASE64')), false)
})

test('转换器：上游没有 completed（连接中断）时 finalize 兜底给出 finish_reason', () => {
  const tr = createResponsesToChatTranslator({ id: 'x', model: 'm', created: 1 })
  tr.toChatChunks(addedEvt(0, 'call_abc', 'read_file'))
  tr.toChatChunks(argsDeltaEvt(0, '{"a":1}'))
  const out = tr.finalize()
  assert.equal(out.length, 1, '必须补一帧结束，否则客户端永远等不到 finish_reason')
  assert.equal(out[0].chunk.choices[0].finish_reason, 'tool_calls')
  assert.equal(tr.finalize().length, 0, 'finalize 不能重复发')
})

test('转换器：response.created 采用上游的 response id 作为后续 chunk 的 id', () => {
  const { chunks } = runEvents([
    { type: 'response.created', data: { response: { id: 'resp_1', model: 'gpt-6.1-sol' } } },
    { type: 'response.output_text.delta', data: { delta: 'hi' } },
    completedEvt()
  ])
  assert.ok(chunks.length > 0)
  assert.equal(chunks[0].id, 'resp_1')
})

test('转换器：垃圾事件不崩也不产出 chunk', () => {
  const { chunks } = runEvents([null, undefined, {}, { type: 'nope' }, { type: 'response.output_text.delta' }])
  assert.equal(chunks.filter((c) => c.choices[0]?.delta?.content).length, 0)
})

// ---------- 非流式聚合 ----------

test('聚合：文本累积、工具按 index 合并，最后给出 finish_reason', () => {
  let acc = createChatAccumulator()
  acc = applyChatChunk(acc, { choices: [{ index: 0, delta: { content: 'A' } }] })
  acc = applyChatChunk(acc, { choices: [{ index: 0, delta: { content: 'B' } }] })
  acc = applyChatChunk(acc, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file' } }] } }] })
  acc = applyChatChunk(acc, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } }] })
  acc = applyChatChunk(acc, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  const final = finalizeChatAccumulator(acc)
  assert.equal(final.message.content, 'AB')
  assert.equal(final.message.tool_calls.length, 1)
  assert.equal(final.message.tool_calls[0].id, 'call_1')
  assert.equal(final.message.tool_calls[0].function.arguments, '{"a":1}')
  assert.equal(final.finishReason, 'tool_calls')
})

test('聚合：两个 index 必须合成两条 tool_call，不能挤成一条', () => {
  let acc = createChatAccumulator()
  acc = applyChatChunk(acc, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'a' } }] } }] })
  acc = applyChatChunk(acc, { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'b' } }] } }] })
  const final = finalizeChatAccumulator(acc)
  assert.equal(final.message.tool_calls.length, 2)
  assert.equal(final.message.tool_calls[1].function.name, 'b')
})

test('聚合：没有工具时不带 tool_calls 字段，content 为 null（与纯文本响应保持一致）', () => {
  const final = finalizeChatAccumulator(createChatAccumulator())
  assert.equal(final.message.content, null, '空文本必须是 null 而不是 ""，否则部分客户端当成空消息')
  assert.equal(Object.prototype.hasOwnProperty.call(final.message, 'tool_calls'), false)
  assert.equal(final.finishReason, 'stop')
})

test('聚合：usage 缺失时用兜底值，不留 undefined', () => {
  const fallback = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
  assert.deepEqual(finalizeChatAccumulator(createChatAccumulator(), fallback).usage, fallback)
  assert.deepEqual(finalizeChatAccumulator(createChatAccumulator()).usage, {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  })
})

// ---------- bridge 接线一致性（防补丁漂移）----------

test('bridge：dist 里不再硬编码 image_generation 工具列表', { skip: needBridge }, () => {
  for (const f of ['cli.js', 'index.js']) {
    const src = fs.readFileSync(path.join(GW, 'node_modules', 'chatgpt-bridge', 'dist', f), 'utf8')
    assert.doesNotMatch(
      src,
      /tools:\s*\[\s*\{\s*type:\s*"image_generation"\s*\}\s*\]/,
      `${f} 还写死 image_generation —— 调用方的 tools 会被整组丢掉`
    )
    assert.match(src, /chatTools\.convertChatToolsToResponses/, `${f} 必须接上新转换模块`)
    // 采样参数一旦被转发，所有带 temperature 的客户端都会 400
    assert.doesNotMatch(src, /upstreamBody\.temperature\s*=/, `${f} 不能把 temperature 原样转发给上游`)
    assert.doesNotMatch(src, /upstreamBody\.top_p\s*=/, `${f} 不能把 top_p 原样转发给上游`)
    assert.match(src, /chatTools\.buildResponsesReasoning/, `${f} 必须接上思考强度映射`)
  }
})

test('bridge：准备后的 dist 与快照规范化为 LF 后的字节一致', { skip: needBridge }, () => {
  for (const [distName, snapName] of [['cli.js', 'cli.patched.js'], ['index.js', 'index.patched.js']]) {
    const dist = fs.readFileSync(path.join(GW, 'node_modules', 'chatgpt-bridge', 'dist', distName))
    const snap = Buffer.from(fs.readFileSync(path.join(GW, 'patches', snapName)).toString('latin1').replace(/\r\n/g, '\n'), 'latin1')
    assert.deepEqual(dist, snap, `${snapName} 与 dist/${distName} 不一致，请审核快照和清单后运行 npm run prepare:bridge`)
  }
})

test('bridge：当前依赖通过版本与完整哈希校验', { skip: needBridge }, async () => {
  const { verifyBridgePatched } = await import('../bridge-patches.mjs')
  assert.equal(verifyBridgePatched().version, '0.3.0')
})

test('仓库根目录：chat-tools.mjs 必须存在且可独立导入（装机热更只拷这一个文件）', { skip: needBridge }, () => {
  assert.ok(fs.existsSync(path.join(GW, 'chat-tools.mjs')))
  assert.ok(fs.existsSync(path.join(REPO, 'package.json')))
})
