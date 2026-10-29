// Chat Completions <-> Codex Responses 的工具调用协议转换（纯函数 / 可单测）
//
// 背景：vendored chatgpt-bridge 的 /v1/chat/completions 会把调用方 tools 硬编码替换为
// [{type:"image_generation"}]，且响应只转换文本与生图，导致 WorkBuddy 的 Agent 工具链断链。
//
// 行为参考成熟实现（代码为本项目自写，不复制第三方源码）：
//   - sub2api（LGPL-3.0，仅参考语义）：tools 字段提升、tool_choice 不存在则降级 auto、
//     role:tool -> function_call_output、arguments.done 只补发剩余片段、finish_reason 映射
//   - 本机 Codex 上游实测（2026-10-29 /v1/responses 探针）：
//       function tools 与扁平化 tool_choice 均被接受；image_generation 可与 function 共存；
//       多轮历史接受 function_call / function_call_output，call_id 可用 call_ 前缀原样回传。
//
// 本模块不处理附件解析与生图落盘，这两件事仍由 bridge 侧负责；这里只产出结构化结果。

const EMPTY_TOOL_OUTPUT = '(empty)'
const DEFAULT_OBJECT_SCHEMA = { type: 'object', properties: {} }

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function asString(v) {
  return typeof v === 'string' ? v.trim() : ''
}

function firstString(...vals) {
  for (const v of vals) {
    const s = asString(v)
    if (s) return s
  }
  return ''
}

function extractTextContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p
        if (!isObj(p)) return ''
        if (typeof p.text === 'string') return p.text
        if (isObj(p.text) && typeof p.text.text === 'string') return p.text.text
        return ''
      })
      .filter((s) => s !== '')
      .join('\n')
  }
  if (isObj(content)) {
    if (typeof content.text === 'string') return content.text
    if (typeof content.output === 'string') return content.output
  }
  return ''
}

function ensureJsonArguments(args) {
  if (typeof args === 'string') {
    const t = args.trim()
    return t === '' ? '{}' : args
  }
  if (args === undefined || args === null) return '{}'
  try {
    return JSON.stringify(args)
  } catch {
    return '{}'
  }
}

function normalizeParameters(params) {
  return isObj(params) ? params : DEFAULT_OBJECT_SCHEMA
}

function pushFunctionTool(out, fn) {
  if (!isObj(fn)) return
  const name = asString(fn.name)
  if (!name) return
  const tool = { type: 'function', name }
  const description = asString(fn.description)
  if (description) tool.description = description
  tool.parameters = normalizeParameters(fn.parameters)
  if (fn.strict !== undefined) tool.strict = !!fn.strict
  out.push(tool)
}

/**
 * Chat Completions tools / legacy functions -> Responses tools
 * @returns {Array<Object>} 一定包含 image_generation（除非 ensureImageTool=false）
 */
export function convertChatToolsToResponses(tools, functions, opts = {}) {
  const out = []
  if (Array.isArray(tools)) {
    for (const t of tools) {
      if (!isObj(t)) continue
      const type = asString(t.type)
      if (type === 'function') {
        const fn = isObj(t.function) ? t.function : t
        pushFunctionTool(out, {
          name: firstString(fn.name, t.name),
          description: firstString(fn.description, t.description),
          parameters: fn.parameters !== undefined ? fn.parameters : t.parameters,
          strict: fn.strict !== undefined ? fn.strict : t.strict
        })
        continue
      }
      if (type) out.push(t)
    }
  }
  if (Array.isArray(functions)) {
    for (const f of functions) pushFunctionTool(out, f)
  }
  if (opts.ensureImageTool !== false) {
    const hasImage = out.some((t) => isObj(t) && asString(t.type) === 'image_generation')
    if (!hasImage) out.push({ type: 'image_generation' })
  }
  return out
}

function toolsContainFunctionName(tools, name) {
  return (tools || []).some((t) => isObj(t) && asString(t.type) === 'function' && asString(t.name) === name)
}

function toolsContainType(tools, type) {
  return (tools || []).some((t) => isObj(t) && asString(t.type) === type)
}

/**
 * Chat Completions tool_choice / legacy function_call -> Responses tool_choice
 * 规则：未知类型或目标函数不存在时降级为 "auto"，绝不把错误抛给上游。
 */
export function convertChatToolChoiceToResponses(toolChoice, functionCall, tools) {
  let raw = toolChoice
  if (raw === undefined || raw === null) raw = functionCall
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'string') return raw
  if (!isObj(raw)) return undefined
  const type = asString(raw.type)
  // legacy function_call: {"name":"X"}，没有 type 字段
  if (!type) {
    const legacyName = firstString(raw.name, isObj(raw.function) ? raw.function.name : '')
    if (!legacyName) return undefined
    return toolsContainFunctionName(tools, legacyName) ? { type: 'function', name: legacyName } : 'auto'
  }
  // allowed_tools 是选择策略，不是具体工具类型，原样保留
  if (type === 'allowed_tools') return raw
  if (type === 'function') {
    const name = firstString(raw.name, isObj(raw.function) ? raw.function.name : '')
    if (!name || !toolsContainFunctionName(tools, name)) return 'auto'
    return { type: 'function', name }
  }
  return toolsContainType(tools, type) ? raw : 'auto'
}

/** assistant.tool_calls -> Responses function_call items */
export function convertChatToolCallsToResponsesItems(toolCalls) {
  if (!Array.isArray(toolCalls)) return []
  const out = []
  toolCalls.forEach((tc, i) => {
    const name = firstString(tc?.function?.name, tc?.name)
    if (!name) return
    const rawArgs = tc?.function?.arguments !== undefined ? tc.function.arguments : tc?.arguments
    out.push({
      type: 'function_call',
      call_id: firstString(tc?.id, tc?.call_id) || `call_legacy_${i + 1}`,
      name,
      arguments: ensureJsonArguments(rawArgs)
    })
  })
  return out
}

/**
 * role:"tool" -> Responses function_call_output
 * 无 call_id 时返回 null：调用方应退回普通 user 消息，避免上游拒绝孤儿输出。
 */
export function convertChatToolMessageToResponsesItem(message) {
  if (!isObj(message)) return null
  const callId = firstString(message.tool_call_id, message.call_id, message.id)
  if (!callId) return null
  const output = extractTextContent(message.content) || asString(message.output) || EMPTY_TOOL_OUTPUT
  return { type: 'function_call_output', call_id: callId, output }
}

/**
 * Codex 上游接受的采样参数白名单。
 * 实测（2026-10-30，gpt-6.1-sol）：temperature 与 top_p 一律被拒
 *   → 400 `Unsupported parameter: temperature` / `top_p`
 * 所以白名单现在是空的：转发任何采样参数都会让整个请求失败，
 * 而且是"客户端明明什么都没做错、却全量 400"这种最难归因的失败。
 * 将来上游若重新支持某个参数，加进白名单即可，别直接转发整个 body。
 */
const SAMPLING_ALLOWED_KEYS = []

export function buildResponsesSampling(body) {
  const out = {}
  if (!isObj(body)) return out
  for (const key of SAMPLING_ALLOWED_KEYS) {
    if (typeof body[key] === 'number') out[key] = body[key]
  }
  return out
}

/**
 * 上游实测接受强度：low / medium / high / xhigh / max（'minimal' 会 400）。
 * 未知强度一律不下发——宁可让上游用默认值，也不能把 400 甩给调用方。
 */
const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

export function buildResponsesReasoning(body) {
  if (!isObj(body)) return undefined
  const nested = isObj(body.reasoning) ? body.reasoning : null
  const raw = body.reasoning_effort !== undefined ? body.reasoning_effort : nested ? nested.effort : undefined
  const effort = asString(raw).toLowerCase()
  if (!REASONING_EFFORTS.includes(effort)) return undefined
  const summary = nested ? asString(nested.summary) : ''
  return { effort, summary: summary || 'auto' }
}

export function usageFromResponses(usage) {
  const src = isObj(usage) ? usage : {}
  const inputTokens = Number(src.input_tokens ?? src.prompt_tokens ?? 0) || 0
  const outputTokens = Number(src.output_tokens ?? src.completion_tokens ?? 0) || 0
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens
  }
}

export function finishReasonFromStatus(status, incompleteReason, sawToolCall) {
  const s = asString(status)
  if (s === 'incomplete') {
    const reason = asString(incompleteReason)
    if (reason === 'max_output_tokens') return 'length'
    if (reason === 'content_filter') return 'content_filter'
    return 'stop'
  }
  if (s === 'completed' || s === 'done') return sawToolCall ? 'tool_calls' : 'stop'
  if (s === 'failed') return 'stop'
  return sawToolCall ? 'tool_calls' : 'stop'
}

function eventPayload(evt) {
  return isObj(evt?.data) ? evt.data : isObj(evt) ? evt : {}
}

function eventItem(evt) {
  const p = eventPayload(evt)
  return isObj(p.item) ? p.item : {}
}

function outputIndexOf(evt, item) {
  const p = eventPayload(evt)
  if (Number.isInteger(p.output_index)) return p.output_index
  if (Number.isInteger(item?.output_index)) return item.output_index
  return 0
}

export function createChatAccumulator() {
  return { role: 'assistant', text: '', toolCalls: [], finishReason: null, usage: null }
}

/**
 * 把流式 chunk 合并进非流式结果对象（流式/非流式共用一套 delta 语义）
 */
export function applyChatChunk(acc, chunk) {
  if (!acc || !isObj(chunk)) return acc
  const choice = Array.isArray(chunk.choices) && chunk.choices.length > 0 ? chunk.choices[0] : null
  const delta = isObj(choice?.delta) ? choice.delta : {}
  if (typeof delta.content === 'string') acc.text += delta.content
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      if (!isObj(tc)) continue
      const idx = Number.isInteger(tc.index) ? tc.index : Math.max(0, acc.toolCalls.length - 1)
      if (!acc.toolCalls[idx]) acc.toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } }
      const cur = acc.toolCalls[idx]
      if (asString(tc.id)) cur.id = tc.id
      if (asString(tc.type)) cur.type = tc.type
      if (isObj(tc.function)) {
        if (asString(tc.function.name)) cur.function.name = tc.function.name
        if (typeof tc.function.arguments === 'string') cur.function.arguments += tc.function.arguments
      }
    }
  }
  if (choice && asString(choice.finish_reason)) acc.finishReason = choice.finish_reason
  if (isObj(chunk.usage)) acc.usage = chunk.usage
  return acc
}

export function finalizeChatAccumulator(acc, fallbackUsage) {
  const toolCalls = (acc.toolCalls || []).filter(Boolean)
  return {
    message: {
      role: 'assistant',
      content: acc.text || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
    },
    finishReason: acc.finishReason || (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
    usage: acc.usage || fallbackUsage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  }
}

/**
 * Responses SSE 事件 -> Chat Completions chunk
 * 流式与非流式共用同一状态机；非流式把 chunk 聚合即可，避免两套逻辑漂移。
 * 返回项有两种形态：
 *   - { chunk }        可直接序列化的 chat.completion.chunk
 *   - { imageResult }  生图产物，由 bridge 落盘后转成 Markdown 再发
 */
export function createResponsesToChatTranslator(opts = {}) {
  const state = {
    id: opts.id || `chatcmpl_${Date.now().toString(36)}`,
    model: opts.model || '',
    created: opts.created || Math.floor(Date.now() / 1000),
    includeUsage: opts.includeUsage === true,
    sawToolCall: false,
    finalized: false,
    nextToolIndex: 0,
    byOutput: new Map(),
    args: new Map(),
    usage: null
  }

  const baseChunk = (extra) => ({
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    ...extra
  })
  const deltaChunk = (delta) => baseChunk({ choices: [{ index: 0, delta, finish_reason: null }] })
  const finishChunk = (finishReason) => baseChunk({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })
  const usageChunk = (usage) => ({ ...baseChunk({ choices: [] }), usage })

  function toolIndexFor(outputIndex) {
    return state.byOutput.get(outputIndex)
  }

  function toChatChunks(evt) {
    if (!isObj(evt)) return []
    const type = asString(evt.type)
    const payload = eventPayload(evt)
    const item = eventItem(evt)

    if (type === 'response.created') {
      const resp = isObj(payload.response) ? payload.response : {}
      if (asString(resp.id)) state.id = resp.id
      if (!state.model && asString(resp.model)) state.model = resp.model
      return []
    }

    if (type === 'response.output_text.delta') {
      const delta = typeof payload.delta === 'string' ? payload.delta : ''
      return delta ? [{ chunk: deltaChunk({ content: delta }) }] : []
    }

    if (type === 'response.output_item.added') {
      const itemType = asString(item.type)
      if (itemType !== 'function_call') return []
      const outputIndex = outputIndexOf(evt, item)
      const idx = state.nextToolIndex++
      state.byOutput.set(outputIndex, idx)
      state.args.set(idx, '')
      state.sawToolCall = true
      return [
        {
          chunk: deltaChunk({
            tool_calls: [
              {
                index: idx,
                id: firstString(item.call_id, item.id),
                type: 'function',
                function: { name: asString(item.name) }
              }
            ]
          })
        }
      ]
    }

    if (type === 'response.function_call_arguments.delta') {
      const outputIndex = outputIndexOf(evt, item)
      const idx = toolIndexFor(outputIndex)
      if (idx === undefined) return []
      const delta = typeof payload.delta === 'string' ? payload.delta : ''
      if (!delta) return []
      state.args.set(idx, (state.args.get(idx) || '') + delta)
      return [{ chunk: deltaChunk({ tool_calls: [{ index: idx, function: { arguments: delta } }] }) }]
    }

    // done 只补发「完整串 - 已累计」的剩余部分，避免参数翻倍
    if (type === 'response.function_call_arguments.done') {
      const outputIndex = outputIndexOf(evt, item)
      const idx = toolIndexFor(outputIndex)
      if (idx === undefined) return []
      const completed = typeof payload.arguments === 'string' ? payload.arguments : ''
      const current = state.args.get(idx) || ''
      if (!completed || !completed.startsWith(current) || completed === current) return []
      const remainder = completed.slice(current.length)
      state.args.set(idx, completed)
      return [{ chunk: deltaChunk({ tool_calls: [{ index: idx, function: { arguments: remainder } }] }) }]
    }

    if (type === 'response.output_item.done') {
      if (asString(item.type) === 'image_generation_call' && typeof item.result === 'string' && item.result) {
        return [{ imageResult: item.result }]
      }
      return []
    }

    if (type === 'response.completed' || type === 'response.done' || type === 'response.incomplete' || type === 'response.failed') {
      const resp = isObj(payload.response) ? payload.response : {}
      const usage = isObj(payload.usage) ? payload.usage : resp.usage
      if (isObj(usage)) state.usage = usageFromResponses(usage)
      const status = asString(resp.status) || (type === 'response.incomplete' ? 'incomplete' : 'completed')
      const incompleteReason = isObj(resp.incomplete_details) ? resp.incomplete_details.reason : ''
      state.finalized = true
      const chunks = [finishChunk(finishReasonFromStatus(status, incompleteReason, state.sawToolCall))]
      if (state.includeUsage && state.usage) chunks.push(usageChunk(state.usage))
      return chunks.map((chunk) => ({ chunk }))
    }

    return []
  }

  function finalize() {
    if (state.finalized) return []
    state.finalized = true
    const chunks = [finishChunk(state.sawToolCall ? 'tool_calls' : 'stop')]
    if (state.includeUsage && state.usage) chunks.push(usageChunk(state.usage))
    return chunks.map((chunk) => ({ chunk }))

  }

  return { state, toChatChunks, finalize }
}
