// setup-client.test.mjs — 局域网客户端一键配置脚本的回归
//
// 为什么单独测它：docs/lan-kit/setup-client.mjs 是所有局域网用户的**唯一入口**
// （写 mcp.json + 装 skill + 生成模型配置），却一直没有任何自动化覆盖。
// 这条链路已经出过两次事：一次是安装提示把 /health 503 当失败导致装不下去，
// 一次是宿主机地址注入静默失效。前者靠人肉发现，后者至今没人验证过。
//
// 隔离做法：每个用例一个临时 HOME + 临时 cwd，脚本用 --mcp-json 指向临时文件，
// 不碰真实的 ~/.workbuddy。模型配置写在 cwd，所以 cwd 也必须是临时的。
// 全部用 spawnSync 跑**真实的脚本**，不 mock——它本来就是个 CLI。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
// 默认测仓库里的真源；变异测试用 CGW_SETUP_SCRIPT 指向改过的副本，
// 这样注入缺陷不必碰真实文件（改坏了原文件是最没必要的风险）。
const SCRIPT = process.env.CGW_SETUP_SCRIPT || path.join(REPO, 'docs', 'lan-kit', 'setup-client.mjs')

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-setup-'))
}

// 跑脚本：HOME 指到临时目录，cwd 也指到临时目录（模型配置落在 cwd）。
// stdin 设为 ignore 让 process.stdin.isTTY 为假，从而覆盖「非交互终端」这条分支；
// 否则缺参数时会挂在 readline 上等输入。
function run(args, { home, cwd, script = SCRIPT } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: cwd || home,
    env: { ...process.env, USERPROFILE: home, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 30000
  })
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
}

const HOST = '192.168.1.188'
const KEY = 'cgw-TestKey_1234567890'

test('新建 mcp.json：条目指向 <host>:<port>/mcp，带 Bearer Key', () => {
  const home = tmpdir()
  const mcpJson = path.join(home, 'mcp.json')
  const r = run(['--host', HOST, '--key', KEY, '--mcp-json', mcpJson, '--no-skill', '--no-model-config'], { home })
  assert.equal(r.code, 0, r.out)

  const cfg = JSON.parse(fs.readFileSync(mcpJson, 'utf8'))
  const entry = cfg.mcpServers['codex-gateway-lan']
  assert.ok(entry, '应写入默认名称 codex-gateway-lan')
  assert.equal(entry.url, `http://${HOST}:4173/mcp`)
  assert.equal(entry.headers.Authorization, `Bearer ${KEY}`)
})

test('幂等：重复执行覆盖同名条目，不产生第二份', () => {
  const home = tmpdir()
  const mcpJson = path.join(home, 'mcp.json')
  const args = ['--key', KEY, '--mcp-json', mcpJson, '--no-skill', '--no-model-config']
  assert.equal(run(['--host', HOST, ...args], { home }).code, 0)
  const second = run(['--host', '10.0.0.9', ...args], { home })
  assert.equal(second.code, 0, second.out)
  assert.match(second.out, /覆盖旧条目/)

  const cfg = JSON.parse(fs.readFileSync(mcpJson, 'utf8'))
  assert.deepEqual(Object.keys(cfg.mcpServers), ['codex-gateway-lan'])
  assert.equal(cfg.mcpServers['codex-gateway-lan'].url, 'http://10.0.0.9:4173/mcp')
})

test('不破坏已有条目：其他 MCP 服务原样保留', () => {
  const home = tmpdir()
  const mcpJson = path.join(home, 'mcp.json')
  const before = {
    mcpServers: {
      github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
      'some-other': { url: 'http://127.0.0.1:9999/mcp' }
    }
  }
  fs.writeFileSync(mcpJson, JSON.stringify(before, null, 2))

  const r = run(['--host', HOST, '--key', KEY, '--mcp-json', mcpJson, '--no-skill', '--no-model-config'], { home })
  assert.equal(r.code, 0, r.out)

  const cfg = JSON.parse(fs.readFileSync(mcpJson, 'utf8'))
  assert.deepEqual(cfg.mcpServers.github, before.mcpServers.github)
  assert.deepEqual(cfg.mcpServers['some-other'], before.mcpServers['some-other'])
  assert.ok(cfg.mcpServers['codex-gateway-lan'])
})

test('已有 mcp.json 但无法解析：明确失败，且绝不覆盖原文件', () => {
  const home = tmpdir()
  const mcpJson = path.join(home, 'mcp.json')
  const broken = '{ "mcpServers": { 这段坏掉了 '
  fs.writeFileSync(mcpJson, broken)

  const r = run(['--host', HOST, '--key', KEY, '--mcp-json', mcpJson, '--no-skill', '--no-model-config'], { home })
  assert.equal(r.code, 1, '坏 JSON 必须失败，不能"帮用户修好"')
  assert.match(r.out, /无法解析/)
  // 关键：用户文件里可能有他没备份的配置，覆盖等于数据丢失
  assert.equal(fs.readFileSync(mcpJson, 'utf8'), broken, '原文件被改动了')
})

test('--dry-run：只预览，不写 mcp.json、不生成模型配置', () => {
  const home = tmpdir()
  const mcpJson = path.join(home, 'mcp.json')
  const r = run(['--host', HOST, '--key', KEY, '--mcp-json', mcpJson, '--dry-run', '--no-skill'], { home })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /预览/)
  assert.equal(fs.existsSync(mcpJson), false, 'dry-run 不应创建文件')
  assert.equal(fs.existsSync(path.join(home, 'workbuddy-models-codex-gateway-lan.json')), false)
})

test('非交互终端缺 --host：明确报错并指出怎么补', () => {
  const home = tmpdir()
  const r = run(['--key', KEY, '--no-skill', '--no-model-config'], { home })
  assert.equal(r.code, 1, '缺 host 不能静默继续')
  assert.match(r.out, /缺少 --host/)
  // 报错文案要给出两条出路：命令行补参数 / 网页接入页
  assert.match(r.out, /\/setup/)
})

test('非交互终端缺 --key：明确报错', () => {
  const home = tmpdir()
  const r = run(['--host', HOST, '--no-skill', '--no-model-config'], { home })
  assert.equal(r.code, 1)
  assert.match(r.out, /缺少 --key/)
})

test('Key 前缀不是 cgw-：只警告不阻断（自定义 Key 场景）', () => {
  const home = tmpdir()
  const mcpJson = path.join(home, 'mcp.json')
  const r = run(['--host', HOST, '--key', 'sk-something', '--mcp-json', mcpJson, '--no-skill', '--no-model-config'], { home })
  assert.equal(r.code, 0, '前缀只是提示，不能当成硬校验')
  assert.match(r.out, /cgw-/)
  assert.ok(fs.existsSync(mcpJson))
})

test('自定义 --name 与 --port：URL 随之变化', () => {
  const home = tmpdir()
  const mcpJson = path.join(home, 'mcp.json')
  const r = run(['--host', HOST, '--key', KEY, '--port', '5000', '--name', 'my-gw',
    '--mcp-json', mcpJson, '--no-skill', '--no-model-config'], { home })
  assert.equal(r.code, 0, r.out)
  const cfg = JSON.parse(fs.readFileSync(mcpJson, 'utf8'))
  assert.equal(cfg.mcpServers['my-gw'].url, `http://${HOST}:5000/mcp`)
})

test('随包 skill 缺失：降级跳过，不阻断主流程', () => {
  const home = tmpdir()
  // 把脚本挪到没有 skills/ 的目录，模拟「用户只下载了单个 .mjs」
  const loneDir = tmpdir()
  const lone = path.join(loneDir, 'setup-client.mjs')
  fs.copyFileSync(SCRIPT, lone)
  const mcpJson = path.join(home, 'mcp.json')

  const r = run(['--host', HOST, '--key', KEY, '--mcp-json', mcpJson, '--no-model-config'],
    { home, script: lone })
  assert.equal(r.code, 0, '缺 skill 文件不该让整个安装失败')
  assert.match(r.out, /未找到随包 skill/)
  assert.ok(fs.existsSync(mcpJson), 'mcp.json 仍要写好')
})

test('随包 skill 存在：复制到 ~/.workbuddy/skills/codex-gateway-image', () => {
  const home = tmpdir()
  const r = run(['--host', HOST, '--key', KEY, '--mcp-json', path.join(home, 'mcp.json'), '--no-model-config'], { home })
  assert.equal(r.code, 0, r.out)
  const installed = path.join(home, '.workbuddy', 'skills', 'codex-gateway-image', 'SKILL.md')
  assert.ok(fs.existsSync(installed), 'skill 未安装到临时 HOME')
  assert.match(fs.readFileSync(installed, 'utf8'), /^---/, 'SKILL.md 应带 frontmatter')
})

test('模型配置：内容指向 /v1/chat/completions，Key 与地址正确', () => {
  const home = tmpdir()
  const r = run(['--host', HOST, '--key', KEY, '--mcp-json', path.join(home, 'mcp.json'), '--no-skill'], { home })
  assert.equal(r.code, 0, r.out)

  const out = path.join(home, 'workbuddy-models-codex-gateway-lan.json')
  assert.ok(fs.existsSync(out), '模型配置未生成')
  const cfg = JSON.parse(fs.readFileSync(out, 'utf8'))
  const m = cfg.models[0]
  assert.equal(m.url, `http://${HOST}:4173/v1/chat/completions`)
  assert.equal(m.apiKey, KEY)
  assert.equal(m.supportsToolCall, true)
})

test('--no-skill --no-model-config：只写 mcp.json，不多造文件', () => {
  const home = tmpdir()
  const r = run(['--host', HOST, '--key', KEY, '--mcp-json', path.join(home, 'mcp.json'),
    '--no-skill', '--no-model-config'], { home })
  assert.equal(r.code, 0, r.out)
  assert.equal(fs.existsSync(path.join(home, '.workbuddy', 'skills', 'codex-gateway-image')), false)
  assert.equal(fs.existsSync(path.join(home, 'workbuddy-models-codex-gateway-lan.json')), false)
})

// ---------- 与网关分发侧的契约 ----------
// 网关用精确字符串替换把宿主机地址注入 EMBEDDED_HOST。这条断言守的是**模板不能被
// 悄悄改动**：一旦这一行的引号、空格或变量名变了，替换就空转，而响应仍是 200。
// 端到端的那一半（真的发请求看有没有注入）在 audit.mjs 的 K9 组。
test('契约：EMBEDDED_HOST 注入锚点仍存在且格式未变', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8')
  assert.ok(
    src.includes("const EMBEDDED_HOST = ''"),
    '注入锚点被改动——网关的字符串替换会静默失效，请同步修改 launcher.mjs 的 LAN_KIT_HOST_ANCHOR'
  )
  // 锚点必须是「默认空串」，否则注入逻辑会覆盖掉一个已有地址
  const line = src.split('\n').find((l) => l.includes('EMBEDDED_HOST ='))
  assert.equal(line.trim(), "const EMBEDDED_HOST = ''")
})
