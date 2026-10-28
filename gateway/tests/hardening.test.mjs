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
