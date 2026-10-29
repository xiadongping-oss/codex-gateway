// 加固回归：针对本轮全仓审查修掉的缺陷。
//
// 写这些用例时守住项目既有的两条规矩（见 tests/README.md）：
//   1. 断言**结果与数据变化**，不看状态码 —— 这里没有 HTTP 层，对应到
//      「磁盘上到底成了什么样」。
//   2. 一个用例只打破一层校验。例如临时文件名唯一性和原子替换是两件事，
//      必须各自有一条用例证明它单独被抓住，否则是假测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

// 被测路径可注入：变异测试会把缺陷打进**沙盒副本**，
// 若这里写死相对 '../atomic-write.mjs'，测试就一直对着真源码跑，
// 所有变异体都会「存活」并伪装成成功的防护。
//
// 另一处坑：这里不能用 __dirname（ESM 里没有这个变量）。实际发生过的情况是
// 变异 runner 总会设 CGW_TEST_SRC，把默认分支短路掉，于是只有单独直接跑
// 才会暴露 ReferenceError —— 默认值这条路径必须自己走过。
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = process.env.CGW_TEST_SRC || path.join(HERE, '..')
const toUrl = (f) => pathToFileURL(path.join(SRC, f)).href
const { writeTextAtomic, writeJsonAtomic, sweepStaleTmpFiles } = await import(toUrl('atomic-write.mjs'))
const { assertOutboundUrl } = await import(toUrl('assets.mjs'))

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-hardening-'))
}

// ---------- 原子落盘 ----------

test('写入后目标文件内容完整，且磁盘上没有留下临时文件', () => {
  const dir = tmpDir()
  const target = path.join(dir, 'accounts.json')
  writeJsonAtomic(target, { accounts: [{ id: 'a' }] })
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf-8')), { accounts: [{ id: 'a' }] })
  // 临时文件不能被留在数据目录里，否则用户排障时会被干扰
  assert.deepEqual(fs.readdirSync(dir), ['accounts.json'])
})

test('目标已存在时是整份替换，不存在半截内容', () => {
  const dir = tmpDir()
  const target = path.join(dir, 'q.json')
  const longA = 'A'.repeat(50000)
  const longB = 'B'.repeat(50000)
  fs.writeFileSync(target, JSON.stringify({ v: longA }))
  writeJsonAtomic(target, { v: longB })
  // 半截写入的典型特征是「混合了新旧内容」或「JSON 解析失败」
  const parsed = JSON.parse(fs.readFileSync(target, 'utf-8'))
  assert.equal(parsed.v, longB)
  assert.ok(!fs.readFileSync(target, 'utf-8').includes(longA), '不应残留旧内容的片段')
})

test('并发写入用各自的临时文件名，互不踩踏', () => {
  const dir = tmpDir()
  // 直接观察写入过程中临时文件名是否被唯一化：
  // 固定 tmp 名（旧实现）会让并发写互相覆盖同一份内容。
  const seen = []
  const orig = fs.writeFileSync
  try {
    fs.writeFileSync = (p, ...rest) => {
      if (typeof p === 'string' && p.includes('.tmp')) seen.push(path.basename(p))
      return orig(p, ...rest)
    }
    writeTextAtomic(path.join(dir, 'x.json'), '{"n":1}')
    writeTextAtomic(path.join(dir, 'x.json'), '{"n":2}')
    writeTextAtomic(path.join(dir, 'x.json'), '{"n":3}')
  } finally {
    fs.writeFileSync = orig
  }
  assert.equal(seen.length, 3)
  assert.equal(new Set(seen).size, 3, `三次写入应产出三个互不相同的临时文件名，实际 ${new Set(seen).size} 个`)
})

test('临时文件名带 pid 与随机段（同一行程多次写不会撞名）', () => {
  const dir = tmpDir()
  const names = []
  const orig = fs.writeFileSync
  try {
    fs.writeFileSync = (p, ...rest) => {
      if (typeof p === 'string' && p.includes('.tmp')) names.push(path.basename(p))
      return orig(p, ...rest)
    }
    writeTextAtomic(path.join(dir, 'y.json'), '{}')
  } finally {
    fs.writeFileSync = orig
  }
  assert.equal(names.length, 1)
  const m = /^\..+\.\d+\.[0-9a-f]{12}\.tmp$/.exec(names[0])
  assert.ok(m, `临时文件名形状不符合「.<名>.<pid>.<12位hex>.tmp」规范：${names[0]}`)
})

test('写入失败必须抛出，不能被静默吞掉', () => {
  const dir = tmpDir()
  // 关键：要让失败发生在 try 块**内部**（写临时文件或 rename 那一步），
  // 而不是外层的 mkdirSync —— 否则测的就不是「失败有没有被吞掉」这条逻辑了。
  // 文件名含 NUL 会被 fs 明确拒绝（ERR_INVALID_ARG_VALUE），且 mkdir 阶段先通过了。
  assert.throws(() => writeTextAtomic(path.join(dir, 'bad\0.json'), '{}'))
})

test('rename 失败同样要抛出（目标路径本身是个目录）', () => {
  const dir = tmpDir()
  // 目标是已存在的目录：写临时文件会成功，但 rename 到目录必然 EISDIR，
  // 这同样发生在 try 块内部。
  // 目标目录要建在本次的临时目录**内部**：直接拿 tmpDir() 当目标的话，
  // 临时文件会生成到系统 temp 根目录，那里有其它程序的 .tmp 文件，
  // 断言「没有残留」就会读到一堆无关内容。
  const target = path.join(dir, 'as-dir')
  fs.mkdirSync(target)
  assert.throws(() => writeTextAtomic(target, '{}'))
  const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))
  assert.equal(leftovers.length, 0, `失败后留下了临时文件：${leftovers.join(', ')}`)
})

test('凭据文件按 0o600 落盘（非 Windows 时才校验权限位）', () => {
  if (process.platform === 'win32') return // Windows ACL 不体现在 mode 的低 9 位上
  const dir = tmpDir()
  const target = path.join(dir, 'secret.json')
  writeJsonAtomic(target, { key: 'value' })
  const mode = fs.statSync(target).mode & 0o777
  assert.equal(mode, 0o600, `期望 0600，实际 ${mode.toString(8)}`)
})

test('sweepStaleTmpFiles 只清理我们自己写出的陈旧临时文件', () => {
  const dir = tmpDir()
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
  const aged = (f, content) => {
    fs.writeFileSync(f, content)
    fs.utimesSync(f, old, old)
  }
  // 唯一的清理目标：形状符合 + 足够陈旧
  const stale = path.join(dir, '.q.json.1234.abcdef123456.tmp')
  aged(stale, '{"half":true')
  // 下面三个各自**只**在一层上与目标不同 —— 这是项目的硬规矩：
  // 多重校验叠加时，用例一次只打破一层，否则失效的那一层会被别的层掩盖，
  // 测试全绿而防护其实已经破了。
  const keepTxt = path.join(dir, 'keep.txt')
  aged(keepTxt, 'keep')                                   // 打破「后缀是 .tmp」
  // 前导点和 .tmp 后缀都具备（能走到结构校验那一行），但 pid/hex 形状不符。
  // 用 notes.tmp（不带前导点）是无效的：它在更早的 startsWith('.') 就被 continue 了，
  // 无论结构校验是否存在都不会被删，测试会假绿。
  const notesTmp = path.join(dir, '.notes.tmp')
  aged(notesTmp, 'keep')                                  // 打破「pid/hex 形状」
  const fresh = path.join(dir, '.q.json.9999.aaaaaaaaaaaa.tmp')
  fs.writeFileSync(fresh, 'fresh')                        // 打破「足够陈旧」

  const n = sweepStaleTmpFiles(dir)
  assert.equal(n, 1, `应只清理那一个陈旧文件，实际 ${n}`)
  assert.ok(!fs.existsSync(stale))
  assert.ok(fs.existsSync(keepTxt), '普通文件不能被误删')
  assert.ok(fs.existsSync(notesTmp), '形状不符的 tmp 不能被误删')
  assert.ok(fs.existsSync(fresh), '新鲜临时文件不能被删')
})

test('sweepStaleTmpFiles 递归进入子目录：data/ 里的残留也在清理范围', () => {
  // 安装布局下数据根里还有 data/、accounts/ 子目录，tmp 与目标同目录，
  // 只扫顶层会漏掉子目录里的残留 —— 递归化就是为这个。
  const dir = tmpDir()
  const sub = path.join(dir, 'data')
  fs.mkdirSync(sub)
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
  const staleSub = path.join(sub, '.call-logs.json.77.abcdef123456.tmp')
  fs.writeFileSync(staleSub, '{"half":true')
  fs.utimesSync(staleSub, old, old)
  const keepSub = path.join(sub, 'call-logs.json')
  fs.writeFileSync(keepSub, '{}')
  fs.utimesSync(keepSub, old, old)

  const n = sweepStaleTmpFiles(dir)
  assert.equal(n, 1, `子目录里的陈旧 tmp 应被清掉，实际 ${n}`)
  assert.ok(!fs.existsSync(staleSub))
  assert.ok(fs.existsSync(keepSub), '子目录里的正式数据文件不能被误删')
})

// ---------- 数据目录解析（data-root.mjs） ----------
// 安装布局（CGW_DATA_DIR）与绿色版（数据长在程序目录）的分岔点。
// 这里出错的直接后果是「升级后账号凭空消失」，所以四个分支都要有独立用例。

const { resolveDataRoot, isInstalledLayout, normalizeAuthFilePath, DATA_DIR_ENV } = await import(toUrl('data-root.mjs'))

test('未设置 CGW_DATA_DIR 时回退程序目录（绿色版布局不变）', () => {
  const mod = path.join(os.tmpdir(), 'cgw-program-' + process.pid)
  assert.equal(resolveDataRoot({}, mod), mod)
  assert.equal(resolveDataRoot({ CGW_DATA_DIR: '' }, mod), mod, '空字符串视为未设置')
  assert.equal(resolveDataRoot({ CGW_DATA_DIR: '   ' }, mod), mod, '纯空白视为未设置')
  assert.equal(isInstalledLayout({}), false)
  assert.equal(isInstalledLayout({ CGW_DATA_DIR: '' }), false)
})

test('CGW_DATA_DIR 为绝对路径时生效（安装布局）', () => {
  const mod = path.join(os.tmpdir(), 'cgw-program-' + process.pid)
  const abs = path.join(os.tmpdir(), 'cgw-data-' + process.pid)
  assert.equal(resolveDataRoot({ CGW_DATA_DIR: abs }, mod), path.resolve(abs))
  assert.equal(isInstalledLayout({ CGW_DATA_DIR: abs }), true)
})

test('CGW_DATA_DIR 为相对路径时按未设置处理（不允许随启动姿势漂移）', () => {
  const mod = path.join(os.tmpdir(), 'cgw-program-' + process.pid)
  assert.equal(resolveDataRoot({ CGW_DATA_DIR: 'relative/data' }, mod), mod)
  assert.equal(resolveDataRoot({ CGW_DATA_DIR: '.\\data' }, mod), mod)
  assert.equal(isInstalledLayout({ CGW_DATA_DIR: 'relative/data' }), false)
})

test('normalizeAuthFilePath：程序目录内的旧路径重定向到数据根，外部路径保留', () => {
  const program = path.join(os.tmpdir(), 'cgw-program-' + process.pid)
  const fallback = path.join(os.tmpdir(), 'cgw-data-' + process.pid, 'auth.json')
  const legacy = path.join(program, 'auth.json')
  // 打破一层：路径为空 → 直接用 fallback，不该被丢进 isInsideRoot
  assert.equal(normalizeAuthFilePath('', program, fallback), fallback)
  assert.equal(normalizeAuthFilePath(undefined, program, fallback), fallback)
  // 打破一层：落在程序目录内 → 视为默认值重定向（绿色版升级的核心场景）
  assert.equal(normalizeAuthFilePath(legacy, program, fallback), fallback)
  // 打破一层：程序目录之外 → 用户显式配置，保留
  const outside = path.join(os.tmpdir(), 'cgw-elsewhere-auth.json')
  assert.equal(normalizeAuthFilePath(outside, program, fallback), outside)
})

test('DATA_DIR_ENV 常量名就是文档承诺的 CGW_DATA_DIR', () => {
  // 安装器写入 installed.env 的键名与 launcher/脚本读取的键名必须一字不差
  assert.equal(DATA_DIR_ENV, 'CGW_DATA_DIR')
})

// ---------- 云存储地址 SSRF 防护 ----------
// 这一段守的是一个已经实测确认过的绕过：
// 黑名单原本只做字符串前缀匹配，IPv4-mapped IPv6 写法整体漏网。

const SHOULD_BLOCK = [
  ['http://[::ffff:127.0.0.1]:9000', 'IPv4-mapped IPv6 回环'],
  ['http://[::ffff:169.254.169.254]', 'IPv4-mapped 云元数据'],
  ['http://[::ffff:a9fe:a9fe]', 'IPv4-mapped 十六进制写法'],
  ['http://[::ffff:a9fe:a9fe]/latest/meta-data/', '带路径的十六进制写法'],
  ['http://[::]', 'IPv6 未指定地址'],
  ['http://[::1]', 'IPv6 回环（原有能力，防止这次改动把它弄坏）'],
  ['http://127.0.0.1', 'IPv4 回环'],
  ['http://169.254.169.254', '云元数据'],
  ['http://10.1.2.3', '私网 A'],
  ['http://172.17.31.5', '私网 B'],
  ['http://192.168.1.1', '私网 C'],
  ['http://0177.0.0.1', '带前导零的回环写法'],
  ['http://2130706433', '十进制整数形式的回环'],
  ['http://localhost', 'localhost'],
  // nip.io 这类通配 DNS 会把任意 IP 前缀映射回该 IP，是绕过 SSRF 防护的常用手法。
  // 既有的前缀式黑名单恰好拦住了它，这里固化下来防止被「优化」成精确比对。
  ['https://127.0.0.1.nip.io', '通配 DNS 域名（DNS rebinding 常用手法）']
]

const SHOULD_ALLOW = [
  ['https://example.com', '普通外网'],
  ['https://play.min.io:9000', '公开示例 MinIO'],
  ['https://my-storage.example.com', '名字里带 "my" 的正常域名'],
  ['https://1000items.example-cdn.net', '域名首段含数字但不构成 IP']
]

for (const [url, label] of SHOULD_BLOCK) {
  test(`SSRF 拦截：${label}`, () => {
    assert.throws(() => assertOutboundUrl(url, 'endpoint'), /拒绝|不支持|http/, `${url} 应被拒绝`)
  })
}

for (const [url, label] of SHOULD_ALLOW) {
  test(`SSRF 不误伤：${label}`, () => {
    assert.doesNotThrow(() => assertOutboundUrl(url, 'endpoint'), `${url} 不应被拒绝`)
  })
}

test('allowInternal 显式放行内网地址（自建 NAS / MinIO 场景本来就要用内网）', () => {
  assert.doesNotThrow(() => assertOutboundUrl('http://192.168.1.10:9000', 'endpoint', { allowInternal: true }))
  // 但 LAN 以外的情况不受影响 —— 这里只确认开关确实只由参数控制
  assert.throws(() => assertOutboundUrl('http://192.168.1.10:9000', 'endpoint', { allowInternal: false }))
})

test('非 http(s) 协议一律拒绝', () => {
  for (const u of ['file:///etc/passwd', 'ftp://example.com', 'javascript:alert(1)', 'gopher://127.0.0.1']) {
    assert.throws(() => assertOutboundUrl(u, 'endpoint'), `${u} 应被拒绝`)
  }
})

// ---------- 参考图路径白名单（ref-roots.mjs） ----------

const {
  isInsideRoot, isRemoteRef, resolveReferencePath, checkReferencePaths, defaultReferenceRoot
} = await import(toUrl('ref-roots.mjs'))

test('白名单内的绝对路径放行，且返回归一化后的绝对路径', () => {
  const root = tmpDir()
  const r = resolveReferencePath(path.join(root, 'a.png'), root)
  assert.ok(r.ok)
  assert.equal(path.resolve(r.path), path.resolve(path.join(root, 'a.png')))
})

test('相对路径按根目录解析，而不是按进程 cwd 解析', () => {
  const root = tmpDir()
  const r = resolveReferencePath('a.png', root)
  assert.ok(r.ok)
  assert.equal(path.resolve(r.path), path.resolve(path.join(root, 'a.png')))
})

test('越界绝对路径拒绝', () => {
  const root = tmpDir()
  const outside = path.join(path.dirname(root), 'elsewhere.png')
  const r = resolveReferencePath(outside, root)
  assert.deepEqual(r, { ok: false, reason: 'outside' })
})

test('目录穿越（..）拒绝', () => {
  const root = tmpDir()
  const r = resolveReferencePath(path.join('..', 'secret.png'), root)
  assert.equal(r.ok, false)
})

test('前缀相似但不构成子目录的名字不放进白名单（/refs 不能放进 /refs-other）', () => {
  const parent = tmpDir()
  const refs = path.join(parent, 'refs')
  const other = path.join(parent, 'refs-other')
  assert.equal(isInsideRoot(other, refs), false)
  // 反向也要成立：refs-other 里的文件不能通过 refs 的校验
  assert.equal(resolveReferencePath(path.join(other, 'a.png'), refs).ok, false)
})

test('Windows 大小写不敏感：盘符与目录名大小写差异不造成放行', () => {
  const root = tmpDir()
  const inside = path.join(root, 'A.png')
  assert.ok(isInsideRoot(inside, root.toUpperCase()))
  const outside = path.join(path.dirname(root), 'OTHER', 'x.png')
  assert.equal(isInsideRoot(outside, root), false)
})

test('URL 与 data-URL 不经本地磁盘，直接放行', () => {
  const root = tmpDir()
  for (const raw of ['https://example.com/a.png', 'http://example.com/a.png', 'data:image/png;base64,iVBORw0KGgo=']) {
    const r = resolveReferencePath(raw, root)
    assert.ok(r.ok && r.remote, `${raw} 应作为远程引用放行`)
  }
  assert.ok(isRemoteRef('data:image/png;base64,x'))
  assert.ok(!isRemoteRef('a.png'))
})

test('空条目与含 NUL 的条目拒绝', () => {
  const root = tmpDir()
  assert.equal(resolveReferencePath('', root).ok, false)
  assert.equal(resolveReferencePath('   ', root).ok, false)
  assert.equal(resolveReferencePath('a\0.png', root).ok, false)
})

test('checkReferencePaths：全部合规时通过，有越界时拒绝且不回显路径', () => {
  const root = tmpDir()
  const good = checkReferencePaths([path.join(root, 'a.png'), 'b.png'], root)
  assert.ok(good.ok && good.paths.length === 2)
  const bad = checkReferencePaths([path.join(root, 'a.png'), path.join(path.dirname(root), 'x.png')], root)
  assert.equal(bad.ok, false)
  assert.ok(!('resolved' in bad) && !('path' in bad), '拒绝结果里不应携带具体路径，否则就是文件存在性 oracle')
})

test('defaultReferenceRoot 落在网关目录下', () => {
  const r = defaultReferenceRoot(path.join(os.tmpdir(), 'fake-gw'))
  assert.ok(r.endsWith(path.join('fake-gw', 'references')))
})

// ---------- 凭据 ACL（secret-perms.mjs + atomic-write 接线） ----------

const { icaclsArgsFor, currentUserForAcl, hardenSecretFile } = await import(toUrl('secret-perms.mjs'))

test('icacls 参数形状：去掉继承 + 只授予当前用户', () => {
  const args = icaclsArgsFor('C://x//api-keys.json', 'alice')
  assert.ok(Array.isArray(args))
  assert.ok(args.includes('/inheritance:r'), '必须去掉继承，否则父目录的 Users/Everyone 仍生效')
  assert.ok(args.includes('/grant:r'), '必须用替换而非追加')
  assert.ok(args.some((a) => /^alice:(F|:F)$/.test(a) || a === 'alice:F'), '授权对象应是当前用户')
})

test('缺文件或缺用户名时不拼参数', () => {
  assert.equal(icaclsArgsFor('', 'alice'), null)
  assert.equal(icaclsArgsFor('x.json', ''), null)
})

test('hardenSecretFile：非 Windows 走 chmod，Windows 走 icacls；失败不抛出', () => {
  if (process.platform !== 'win32') {
    const dir = tmpDir()
    const f = path.join(dir, 'k.json')
    fs.writeFileSync(f, '{}')
    assert.ok(hardenSecretFile(f))
    assert.equal(fs.statSync(f).mode & 0o777, 0o600)
    return
  }
  const user = currentUserForAcl()
  assert.ok(user, 'Windows 上必须能取到当前用户名')
  const dir = tmpDir()
  const f = path.join(dir, 'k.json')
  fs.writeFileSync(f, '{}')
  assert.ok(hardenSecretFile(f))
  const out = require_child_process().execFileSync('icacls', [f], { encoding: 'utf8' })
  assert.ok(out.includes(user), '应保留当前用户权限')
  // 判断「收紧成功」的正确信号是**没有任何 (I) 继承标记**，而不是枚举宽权限名单：
  // 新建文件继承自父目录，条目随环境变化（有的机器是 Users，有的只有
  // SYSTEM/Administrators），枚举永远追不全；(I) 则是继承的直接标记。
  assert.ok(!/\(I\)/.test(out), `不应再有任何继承来的权限：${out}`)
})

test('写入凭据文件后 ACL 自动收紧（atomic-write 接线）', () => {
  if (process.platform !== 'win32') return
  const user = currentUserForAcl()
  const dir = tmpDir()
  const target = path.join(dir, '.gw-config.json')
  writeJsonAtomic(target, { openaiApiKey: 'CANARY' })
  const out = require_child_process().execFileSync('icacls', [target], { encoding: 'utf8' })
  assert.ok(out.includes(user))
  assert.ok(!/\(I\)/.test(out), `原子写入后仍带着继承权限：${out}`)
})

test('hardenSecretFile 对不存在的文件返回 false 而不抛出', () => {
  assert.equal(hardenSecretFile(path.join(tmpDir(), 'nope.json')), false)
})

// ======================= 本机 Codex CLI 登录无感导入 =======================
// 官方 Codex CLI 的 auth.json（~/.codex/auth.json，CODEX_HOME 可覆盖）结构与
// bridge 形态同构，inspectCodexCliAuth 只读探测。错误码是机器契约：
// not_found / read_error / parse_error / unsupported —— 前端按钮靠它分支。
const { codexCliAuthPath, inspectCodexCliAuth } = await import(toUrl('auth-core.mjs'))

test('codexCliAuthPath：默认 ~/.codex/auth.json；CODEX_HOME 覆盖且剥离残留引号', () => {
  const home = tmpDir()
  const p1 = codexCliAuthPath({}, () => home)
  assert.equal(p1, path.join(home, '.codex', 'auth.json'))
  // setx / shell 常见残留：成对引号 + 空白。留在这会把 auth.json 写进带引号的目录名
  const custom = tmpDir()
  const p2 = codexCliAuthPath({ CODEX_HOME: '  "' + custom + '"  ' }, () => home)
  assert.equal(p2, path.join(custom, 'auth.json'))
})

test('inspectCodexCliAuth：不存在 → not_found（不抛出）', () => {
  const codexHome = path.join(tmpDir(), '.codex')
  const r = inspectCodexCliAuth({ CODEX_HOME: codexHome })
  assert.equal(r.exists, false)
  assert.equal(r.error, 'not_found')
})

test('inspectCodexCliAuth：完整 tokens → email/accountId/hasRefresh 全部解出', () => {
  const codexHome = path.join(tmpDir(), '.codex')
  fs.mkdirSync(codexHome, { recursive: true })
  // 手搓一个最小 JWT（header.payload.signature，payload 带 email 与 chatgpt_account_id）
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const idToken = ['x', b64({ email: 'someone@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' } }), 'y'].join('.')
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { id_token: idToken, access_token: 'at', refresh_token: 'rt', account_id: 'acct-123' },
    last_refresh: '2026-10-29T00:00:00.000Z'
  }))
  const r = inspectCodexCliAuth({ CODEX_HOME: codexHome })
  assert.equal(r.exists, true)
  assert.equal(r.error, null)
  assert.equal(r.authMode, 'chatgpt')
  assert.equal(r.email, 'someone@example.com')
  assert.equal(r.accountId, 'acct-123')
  assert.equal(r.hasRefresh, true)
  assert.equal(r.lastRefresh, '2026-10-29T00:00:00.000Z')
})

test('inspectCodexCliAuth：坏 JSON → parse_error；API Key 形态 → authMode api_key', () => {
  const home1 = path.join(tmpDir(), '.codex')
  fs.mkdirSync(home1, { recursive: true })
  fs.writeFileSync(path.join(home1, 'auth.json'), '{"tokens": {"access_tr')
  const r1 = inspectCodexCliAuth({ CODEX_HOME: home1 })
  assert.equal(r1.exists, false)
  assert.equal(r1.error, 'parse_error')

  const home2 = path.join(tmpDir(), '.codex')
  fs.mkdirSync(home2, { recursive: true })
  fs.writeFileSync(path.join(home2, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-xx' }))
  const r2 = inspectCodexCliAuth({ CODEX_HOME: home2 })
  assert.equal(r2.exists, true)
  assert.equal(r2.error, null)
  assert.equal(r2.authMode, 'api_key')
})

test('inspectCodexCliAuth：tokens 缺 refresh_token → unsupported（导入后无法续期）', () => {
  const codexHome = path.join(tmpDir(), '.codex')
  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
    tokens: { access_token: 'at', id_token: null }
  }))
  const r = inspectCodexCliAuth({ CODEX_HOME: codexHome })
  assert.equal(r.exists, true)
  assert.equal(r.error, 'unsupported')
})

// 小工具：hardenSecretFile 的断言要在 win32 上看真实 ACL
import { execFileSync } from 'node:child_process'
function require_child_process() {
  return { execFileSync }
}

// ---------- 系统代理检测（只读） ----------

const { detectSystemProxies, normalizeProxyUrl } = await import(toUrl('proxy.mjs'))

test('detectSystemProxies：环境变量代理命中（HTTPS_PROXY 优先级高于 HTTP_PROXY）', async () => {
  const r1 = await detectSystemProxies({
    env: { HTTPS_PROXY: 'http://10.0.0.1:7890', HTTP_PROXY: 'http://10.0.0.2:7890' },
    platform: 'linux'
  })
  assert.equal(r1.primary, 'http://10.0.0.1:7890')
  assert.equal(r1.candidates[0].source, 'env')
  const r2 = await detectSystemProxies({ env: { all_proxy: 'http://10.0.0.3:7890' }, platform: 'linux' })
  assert.equal(r2.primary, 'http://10.0.0.3:7890')
  // 空环境 → 无候选
  assert.equal((await detectSystemProxies({ env: {}, platform: 'linux' })).primary, null)
})

test('detectSystemProxies：Windows 注册表系统代理只在 ProxyEnable=1 时采纳，分协议条目取 https', async () => {
  const regOut = (enable, server) =>
    [
      '',
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '    ProxyEnable    REG_DWORD    ' + enable,
      '    ProxyServer    REG_SZ    ' + server,
      ''
    ].join('\r\n')
  const fakeExec = (out) => (cmd, args, opts, cb) => cb(null, out)
  const r1 = await detectSystemProxies({
    env: {}, platform: 'win32', execFileImpl: fakeExec(regOut('0x1', 'http=127.0.0.1:7890;https=127.0.0.1:7891'))
  })
  assert.equal(r1.primary, 'http://127.0.0.1:7891')
  // 开关关着 → 不采纳
  const r2 = await detectSystemProxies({
    env: {}, platform: 'win32', execFileImpl: fakeExec(regOut('0x0', '127.0.0.1:7890'))
  })
  assert.equal(r2.primary, null)
  // 裸地址形态
  const r3 = await detectSystemProxies({
    env: {}, platform: 'win32', execFileImpl: fakeExec(regOut('0x1', '127.0.0.1:7897'))
  })
  assert.equal(r3.primary, 'http://127.0.0.1:7897')
  // reg 命令失败（未开启/权限）→ 静默无候选，不抛
  const r4 = await detectSystemProxies({ env: {}, platform: 'win32', execFileImpl: (c, a, o, cb) => cb(new Error('fail')) })
  assert.equal(r4.primary, null)
  // 去重：env 与系统代理相同地址只留一条
  const r5 = await detectSystemProxies({
    env: { HTTPS_PROXY: 'http://127.0.0.1:7897' }, platform: 'win32',
    execFileImpl: fakeExec(regOut('0x1', '127.0.0.1:7897'))
  })
  assert.equal(r5.candidates.length, 1)
})
