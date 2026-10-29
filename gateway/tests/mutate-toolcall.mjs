#!/usr/bin/env node
// mutate-toolcall.mjs — 证明 tool-call.test.mjs 不是假测试
//
// 这块逻辑的失败方式全是"沉默的"，每一个变异体都对应一种真实会发生的写法：
//   · 非 function 工具被丢掉 → 上游只收到生图工具，模型如实说"我只会生图"；
//   · image_generation 无条件追加 → 工具列表里出现两个生图工具，上游拒绝整批请求；
//   · tool_choice 指向不存在的函数时不降级 → 400 直接甩给用户，看不出是网关的锅；
//   · arguments.done 整串重发 → 参数变成 {"a":1}{"a":1}，客户端 JSON.parse 失败，
//     表现为"工具调用偶发报错"，是最难查的一类现象；
//   · finish_reason 恒为 stop → 客户端根本不进执行分支，连错误都没有，只是"不干活"；
//   · 多个工具共用一个 index → 两个调用挤成一条，第二个工具永远执行不到。
//
// 只复制 chat-tools.mjs 与被测用例（纯函数部分）；涉及 vendored bridge / launcher
// 的跨文件用例在沙盒里自动跳过。
//
//   node gateway/tests/mutate-toolcall.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GW = path.resolve(HERE, '..')
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }

const TARGET = 'chat-tools.mjs'
const TEST = 'tests/tool-call.test.mjs'

const MUTANTS = [
  {
    id: 'MT1',
    desc: '丢掉非 function 工具（web_search 等被静默丢弃，只剩生图）',
    from: '      if (type) out.push(t)',
    to: '      if (false) out.push(t)'
  },
  {
    id: 'MT2',
    desc: '无条件追加 image_generation（调用方已给时变成两个，上游拒绝整批工具）',
    from: "    if (!hasImage) out.push({ type: 'image_generation' })",
    to: "    out.push({ type: 'image_generation' })"
  },
  {
    id: 'MT3',
    desc: '不校验工具名（发出没有 name 的 function，上游拒绝整个请求）',
    from: "  if (!name) return\n  const tool = { type: 'function', name }",
    to: "  const tool = { type: 'function', name }"
  },
  {
    id: 'MT4',
    desc: 'parameters 缺失时不补默认 schema（undefined 直接发给上游）',
    from: '  return isObj(params) ? params : DEFAULT_OBJECT_SCHEMA',
    to: '  return params'
  },
  {
    id: 'MT5',
    desc: 'tool_choice 指向不存在的函数时不降级（400 直接甩给用户）',
    from: "    if (!name || !toolsContainFunctionName(tools, name)) return 'auto'",
    to: "    if (!name) return 'auto'"
  },
  {
    id: 'MT6',
    desc: 'legacy function_call 一律降级 auto（老客户端指定工具失效）',
    from: "    return toolsContainFunctionName(tools, legacyName) ? { type: 'function', name: legacyName } : 'auto'",
    to: "    return 'auto'"
  },
  {
    id: 'MT7',
    desc: 'tool_choice 字符串一律改成 auto（required 变成 auto，模型可能不调工具）',
    from: '  if (typeof raw === \'string\') return raw',
    to: "  if (typeof raw === 'string') return 'auto'"
  },
  {
    id: 'MT8',
    desc: 'allowed_tools 被降级（选择策略被吞，调用方意图丢失）',
    from: "  if (type === 'allowed_tools') return raw",
    to: "  if (type === 'allowed_tools') return 'auto'"
  },
  {
    id: 'MT9',
    desc: 'tool_calls 缺 id 时不补 call_legacy_N（第二轮配对不上，工具结果被当成孤儿丢弃）',
    from: '      call_id: firstString(tc?.id, tc?.call_id) || `call_legacy_${i + 1}`,',
    to: '      call_id: firstString(tc?.id, tc?.call_id),'
  },
  {
    id: 'MT10',
    desc: '空 arguments 不补 {}（空串发上去，上游拒绝整个 input）',
    from: "    return t === '' ? '{}' : args",
    to: '    return args'
  },
  {
    id: 'MT11',
    desc: '孤儿 tool 消息也转 function_call_output（call_id 为空，上游拒绝）',
    from: '  if (!callId) return null',
    to: '  if (false) return null'
  },
  {
    id: 'MT12',
    desc: '空工具结果不再写 (empty)（空字符串被上游判为无效输出）',
    from: '  const output = extractTextContent(message.content) || asString(message.output) || EMPTY_TOOL_OUTPUT',
    to: "  const output = extractTextContent(message.content) || asString(message.output) || ''"
  },
  {
    id: 'MT13',
    desc: 'usage 映射错把 input 当 completion（用量统计全错）',
    from: '    completion_tokens: outputTokens,',
    to: '    completion_tokens: inputTokens,'
  },
  {
    id: 'MT14',
    desc: 'completed 时恒返回 stop（客户端不进执行分支，工具永不执行）',
    from: "  if (s === 'completed' || s === 'done') return sawToolCall ? 'tool_calls' : 'stop'",
    to: "  if (s === 'completed' || s === 'done') return 'stop'"
  },
  {
    id: 'MT15',
    desc: 'max_output_tokens 不再映射 length（被截断的响应当成正常结束）',
    from: "    if (reason === 'max_output_tokens') return 'length'",
    to: "    if (reason === 'max_output_tokens') return 'stop'"
  },
  {
    id: 'MT16',
    desc: '所有工具共用一个 index（多个调用挤成一条，第二个工具执行不到）',
    from: '      const idx = state.nextToolIndex++',
    to: '      const idx = 0'
  },
  {
    id: 'MT17',
    desc: 'byOutput 恒按 0 建索引（output_index=1 的参数无处可去，被丢弃）',
    from: '      state.byOutput.set(outputIndex, idx)',
    to: '      state.byOutput.set(0, idx)'
  },
  {
    id: 'MT18',
    desc: 'arguments.done 整串重发（参数翻倍成 {"a":1}{"a":1}，JSON.parse 必挂）',
    from: '      const remainder = completed.slice(current.length)',
    to: '      const remainder = completed'
  },
  {
    id: 'MT19',
    desc: '不区分 includeUsage，一律多发 usage 帧（部分客户端会误判成第二条 choice）',
    from: '      const chunks = [finishChunk(finishReasonFromStatus(status, incompleteReason, state.sawToolCall))]\n      if (state.includeUsage && state.usage) chunks.push(usageChunk(state.usage))',
    to: '      const chunks = [finishChunk(finishReasonFromStatus(status, incompleteReason, state.sawToolCall))]\n      if (state.usage) chunks.push(usageChunk(state.usage))'
  },
  {
    id: 'MT20',
    desc: '不标记 sawToolCall（有工具调用也报 stop）',
    from: '      state.sawToolCall = true',
    to: '      state.sawToolCall = false'
  },
  {
    id: 'MT21',
    desc: '丢弃生图结果（生图能力静默消失）',
    from: '        return [{ imageResult: item.result }]',
    to: '        return []'
  },
  {
    id: 'MT22',
    desc: '丢弃文本 delta（纯文本回复变空）',
    from: '      return delta ? [{ chunk: deltaChunk({ content: delta }) }] : []',
    to: '      return []'
  },
  {
    id: 'MT23',
    desc: 'finalize 兜底恒为 stop（连接中断时客户端永远等不到 tool_calls）',
    from: "    const chunks = [finishChunk(state.sawToolCall ? 'tool_calls' : 'stop')]",
    to: "    const chunks = [finishChunk('stop')]"
  },
  {
    id: 'MT24',
    desc: '聚合时忽略 index，全部合并到第 0 条（两条调用变一条）',
    from: '      const idx = Number.isInteger(tc.index) ? tc.index : Math.max(0, acc.toolCalls.length - 1)',
    to: '      const idx = 0'
  },
  {
    id: 'MT25',
    desc: '空文本输出空串而不是 null（部分客户端当成空消息直接丢弃）',
    from: '      content: acc.text || null,',
    to: '      content: acc.text,'
  },
  {
    id: 'MT26',
    desc: '忽略 fallbackUsage（非流式拿不到用量，界面永远显示 0）',
    from: '    usage: acc.usage || fallbackUsage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }',
    to: '    usage: acc.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }'
  },
  {
    id: 'MT27',
    desc: '把 temperature 加回采样白名单（上游实测 400，等于让所有客户端全量失败）',
    from: 'const SAMPLING_ALLOWED_KEYS = []',
    to: "const SAMPLING_ALLOWED_KEYS = ['temperature']"
  },
  {
    id: 'MT28',
    desc: '思考强度不做白名单校验（minimal 等无效值直接发上去触发 400）',
    from: '  if (!REASONING_EFFORTS.includes(effort)) return undefined',
    to: '  if (!effort) return undefined'
  },
  {
    id: 'MT29',
    desc: '思考强度不做大小写归一（客户端发 High 时原样转发，被上游拒绝）',
    from: '  const effort = asString(raw).toLowerCase()',
    to: '  const effort = asString(raw)'
  },
  {
    id: 'MT30',
    desc: '不补 reasoning.summary（上游拿不到摘要模式，思考强度形同未设）',
    from: "  return { effort, summary: summary || 'auto' }",
    to: '  return { effort }'
  },
  {
    id: 'MT31',
    desc: '优先级反了：嵌套 reasoning.effort 覆盖顶层 reasoning_effort（调用方意图被吞）',
    from: '  const raw = body.reasoning_effort !== undefined ? body.reasoning_effort : nested ? nested.effort : undefined',
    to: '  const raw = nested ? nested.effort : body.reasoning_effort'
  }
]

function makeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-mut-toolcall-'))
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true })
  fs.copyFileSync(path.join(GW, TARGET), path.join(dir, TARGET))
  fs.copyFileSync(path.join(HERE, 'tool-call.test.mjs'), path.join(dir, TEST))
  return dir
}

function runTest(dir) {
  try {
    execFileSync(process.execPath, ['--test', '--test-timeout=30000', path.join(dir, TEST)], {
      cwd: dir,
      stdio: 'ignore',
      timeout: 120000
    })
    return true
  } catch {
    return false
  }
}

// 语法预检：变异把文件改出语法错误时测试也会「失败」，那是假杀死
function syntaxOk(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

console.log(`${C.b}变异测试 · 验证工具调用转换的用例是否真能抓到缺陷${C.x}`)
console.log(`${C.d}被测对象：gateway/${TARGET} · 变异体 ${MUTANTS.length} 个${C.x}\n`)

const baseline = makeCopy()
const baseOk = runTest(baseline)
fs.rmSync(baseline, { recursive: true, force: true })
if (!baseOk) {
  console.error(`${C.r}✗ 基线失败：未变异的源码就过不了测试${C.x}`)
  console.error(`${C.d}  先单独跑：node --test gateway/tests/tool-call.test.mjs${C.x}`)
  process.exit(1)
}
console.log(`${C.g}✓ 基线通过${C.x}  （chat-tools 纯函数部分全绿）\n`)

const rows = []
for (const m of MUTANTS) {
  const dir = makeCopy()
  try {
    const target = path.join(dir, TARGET)
    const src = fs.readFileSync(target, 'utf8')
    const hit = src.indexOf(m.from)
    if (hit < 0) {
      rows.push({ ...m, result: 'anchor-missing' })
      console.log(`${C.y}! ${m.id} 锚点失效${C.x}  ${m.desc}`)
      continue
    }
    // 锚点必须唯一：出现多次说明它可能改到别处（MF4 那次就栽在这）
    if (src.indexOf(m.from, hit + 1) >= 0) {
      rows.push({ ...m, result: 'anchor-ambiguous' })
      console.log(`${C.y}! ${m.id} 锚点不唯一${C.x}  ${m.desc}`)
      continue
    }
    fs.writeFileSync(target, src.replace(m.from, m.to))
    if (!syntaxOk(target)) {
      rows.push({ ...m, result: 'syntax' })
      console.log(`${C.y}! ${m.id} 变异体本身语法错误（假杀死，不计入）${C.x}  ${m.desc}`)
      continue
    }
    const passed = runTest(dir)
    rows.push({ ...m, result: passed ? 'survived' : 'killed' })
    if (passed) console.log(`${C.r}✗ ${m.id} 存活${C.x}  ${m.desc}`)
    else console.log(`${C.g}✓ ${m.id} 被杀死${C.x}  ${m.desc}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const killed = rows.filter((r) => r.result === 'killed').length
const survived = rows.filter((r) => r.result === 'survived')
const broken = rows.filter((r) => ['anchor-missing', 'anchor-ambiguous', 'syntax'].includes(r.result))

console.log('\n' + '─'.repeat(70))
console.log(`  变异体 ${rows.length} 个 · 杀死 ${killed} · 存活 ${survived.length} · 无效 ${broken.length}`)
console.log('─'.repeat(70))

if (survived.length || broken.length) {
  if (survived.length) console.error(`${C.r}✗ 存在盲区${C.x}：${survived.map((r) => r.id).join(', ')}`)
  if (broken.length) console.error(`${C.y}! 无效变异体${C.x}：${broken.map((r) => r.id).join(', ')}（改了源码请同步更新锚点）`)
  process.exit(1)
}
console.log(`${C.g}✅ 全部变异体被杀死，零盲区${C.x}`)
