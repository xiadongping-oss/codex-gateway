#!/usr/bin/env node
// setup-client.mjs — codex-gateway 局域网客户端一键配置（零依赖，Node 16+）
//
// 作用：把「你（局域网成员）」的 WorkBuddy / AGENT 工具接到局域网网关宿主机上，
//       一次完成三件事：
//         1. 写入 mcp.json 远程 MCP 条目（url + Key，零安装，无需本机 Node 以外的任何东西）
//         2. 安装 ImageGen 2.5 skill（可选，让 Agent 生图更可靠）
//         3. 生成 WorkBuddy 模型配置 JSON（可选，对话走宿主机模型）
//
// 用法（三选一）：
//   A. 网页接入页下载（推荐）：在 http://<宿主机IP>:4173/setup 下载本脚本，
//      宿主机地址已自动内嵌，只需：node setup-client.mjs --key cgw-xxxxxxxx
//   B. 手动指定：node setup-client.mjs --host 192.168.1.188 --key cgw-xxxxxxxx
//   C. 交互式：不带参数直接运行 node setup-client.mjs，按提示逐项输入
//   可选：--port 4173  --name codex-gateway-lan  --no-skill  --no-model-config
//         --mcp-json <路径>（默认 ~/.workbuddy/mcp.json）  --dry-run（只预览不写入）
//
// 幂等：重复执行安全（同名条目覆盖为最新配置，其他条目原样保留）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
function argOf(flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : null
}
const has = (f) => argv.includes(f)

// ↑↑ 此行会被网关 /lan-kit/setup-client.mjs?host=<IP> 分发时自动替换为宿主机地址 ↑↑
const EMBEDDED_HOST = ''

function die(msg) {
  console.error('✗ ' + msg)
  process.exit(1)
}
function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(String(a || '').trim()) }))
}

async function main() {
  let host = argOf('--host') || EMBEDDED_HOST || ''
  let key = argOf('--key') || ''

  // 缺参数 → 交互式补齐（仅限终端环境）
  if (!host) {
    if (!process.stdin.isTTY) die('缺少 --host（网关宿主机 IP 或域名，如 192.168.1.188）。也可在 http://<宿主机IP>:4173/setup 网页获取全部配置。')
    host = await ask('① 网关宿主机地址（IP 或域名，如 192.168.1.188）：')
    if (!host) die('宿主机地址不能为空。')
  }
  if (!key) {
    if (!process.stdin.isTTY) die('缺少 --key（宿主机给你分配的 cgw- API Key）。')
    key = await ask('② 你的 cgw- API Key：')
    if (!key) die('Key 不能为空。')
  }
  if (!key.startsWith('cgw-')) console.warn('⚠ 提示：Key 通常以 cgw- 开头，请确认是否填对。')

  const port = Number(argOf('--port') || 4173)
  const name = argOf('--name') || 'codex-gateway-lan'
  const mcpJsonPath = argOf('--mcp-json') || path.join(os.homedir(), '.workbuddy', 'mcp.json')
  const dryRun = has('--dry-run')
  const doSkill = !has('--no-skill')
  const doModelConfig = !has('--no-model-config')
  const base = `http://${host}:${port}`

  console.log(`\n== codex-gateway 客户端配置 ==`)
  console.log(`   网关地址 : ${base}`)
  console.log(`   MCP 名称 : ${name}`)
  console.log(`   mcp.json : ${mcpJsonPath}`)
  console.log(`   模式     : ${dryRun ? '预览（不写入）' : '写入'}\n`)

  // ---------- 1. mcp.json：合并写入远程 MCP 条目 ----------
  let mcp = { mcpServers: {} }
  try {
    const parsed = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'))
    if (parsed && typeof parsed === 'object') {
      mcp = parsed
      if (!mcp.mcpServers || typeof mcp.mcpServers !== 'object') mcp.mcpServers = {}
    }
  } catch (e) {
    if (e.code !== 'ENOENT') die(`mcp.json 存在但无法解析（${e.message}），请先手工修复再运行。`)
    console.log('· mcp.json 不存在，将新建。')
  }
  const existed = !!mcp.mcpServers[name]
  mcp.mcpServers[name] = {
    url: `${base}/mcp`,
    headers: { Authorization: `Bearer ${key}` }
  }
  console.log(`${existed ? '↑' : '+'} mcpServers["${name}"] → ${base}/mcp ${existed ? '（覆盖旧条目）' : '（新增）'}`)
  const others = Object.keys(mcp.mcpServers).filter((k) => k !== name)
  if (others.length) console.log(`  保留其他条目：${others.join(', ')}`)
  if (!dryRun) {
    fs.mkdirSync(path.dirname(mcpJsonPath), { recursive: true })
    fs.writeFileSync(mcpJsonPath, JSON.stringify(mcp, null, 2) + '\n')
    console.log('  已写入。')
  }

  // ---------- 2. ImageGen 2.5 skill（可选） ----------
  if (doSkill) {
    const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'skills', 'codex-gateway-image')
    const dstDir = path.join(os.homedir(), '.workbuddy', 'skills', 'codex-gateway-image')
    const srcFile = path.join(srcDir, 'SKILL.md')
    if (fs.existsSync(srcFile)) {
      console.log(`+ skill ImageGen 2.5 → ${dstDir}`)
      if (!dryRun) {
        fs.mkdirSync(dstDir, { recursive: true })
        fs.copyFileSync(srcFile, path.join(dstDir, 'SKILL.md'))
      }
    } else {
      console.log('· 未找到随包 skill 文件（skills/codex-gateway-image/SKILL.md），跳过。不影响 MCP 生图，仅少一层触发保障。')
    }
  } else {
    console.log('· 按参数跳过 skill 安装。')
  }

  // ---------- 3. WorkBuddy 模型配置（可选） ----------
  if (doModelConfig) {
    const out = path.resolve(`workbuddy-models-codex-gateway-lan.json`)
    const conf = {
      models: [{
        id: 'codex-gateway-lan',
        name: 'Codex (局域网网关)',
        vendor: 'Custom',
        url: `${base}/v1/chat/completions`,
        apiKey: key,
        supportsToolCall: true,
        supportsReasoning: true,
        extra: {
          comment: `局域网网关（宿主机 ${host}）。前提：宿主机网关在跑（--lan 模式）。url 填 ${base}/v1 也可，由 WorkBuddy 自动拼路径。`,
          modelNameHint: `模型名从 ${base}/v1/models 的返回里挑，默认主力 gpt-6.1-sol；生图走 MCP 工具 generate_image，网页素材站 ${base}/gallery`
        }
      }]
    }
    console.log(`+ 模型配置 → ${out}`)
    if (!dryRun) fs.writeFileSync(out, JSON.stringify(conf, null, 2) + '\n')
  } else {
    console.log('· 按参数跳过模型配置。')
  }

  // ---------- 收尾：验证步骤 ----------
  console.log(`
== 下一步（验证） ==
1. 重启 WorkBuddy（或重新加载 MCP 连接器），首次使用远程 MCP 前在「连接器」页对 ${name} 点一次「信任」
2. 验证连通（本机有 curl/Node 任一即可）：
     curl -s ${base}/health
     curl -s -X POST ${base}/mcp -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
3. 在 WorkBuddy 里对 Agent 说「画一张测试图」→ 成功后 Agent 会给出网页素材站链接：
     ${base}/gallery   （浏览器打开，首次输入你的 cgw- Key 后会记住，之后免登录管理你自己的全部图片）
4. 网页接入页（含全部配置的可视化复制/下载）：${base}/setup
${dryRun ? '\n（以上为预览；去掉 --dry-run 重新执行即正式写入）\n' : '\n完成。\n'}`)
}

main().catch((e) => die(e && e.message ? e.message : String(e)))
