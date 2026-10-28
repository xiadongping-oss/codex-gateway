// 端口解析与冲突诊断的回归测试（port-util.mjs + launcher 的 --port 接线）
//
// 为什么值得测：这块的失败方式全是「沉默的」——
//   · 端口字符串拼错（"--port 41 74"）被 Number() 悄悄变成 NaN → 监听 port NaN → 崩在更远的地方；
//   · 端口被占时进程直接抛未捕获异常，双击启动的用户只看到窗口一闪；
//   · --port 在 launcher 里接了但启动脚本没传，自启就会另起一个默认端口的网关（两个网关抢账号）。
// 前两条在这里用纯函数守住，第三条用真起一个 launcher 来守。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  parsePort, alternativePort, portInUseAdvice, portPermissionAdvice,
  DEFAULT_LAUNCHER_PORT, DEFAULT_BRIDGE_PORT
} from '../port-util.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const LAUNCHER = path.join(REPO, 'gateway', 'launcher.mjs')
// 变异测试会把 port-util.mjs 单独复制进沙盒（只跑纯函数部分）；此时 launcher 与
// service 脚本都不在，涉及真进程和跨文件一致性的用例必须跳过，否则变异体会被
// 「文件不存在」而不是「断言失败」杀掉——那是假杀死。
const hasRepo = fs.existsSync(LAUNCHER)
const needRepo = hasRepo ? false : '只在完整仓库里跑（变异沙盒不含 launcher）'

// ---------- parsePort ----------

test('parsePort：没给值就用默认，不报错', () => {
  for (const v of [undefined, null, '', '   ']) {
    const r = parsePort(v, 4173)
    assert.deepEqual(r, { port: 4173, error: '' }, `输入 ${JSON.stringify(v)} 应回落默认值`)
  }
})

test('parsePort：正常数字原样通过，前后空格不算错', () => {
  assert.equal(parsePort('4174', 4173).port, 4174)
  assert.equal(parsePort(4174, 4173).port, 4174)
  assert.equal(parsePort(' 4174 ', 4173).port, 4174)
  assert.equal(parsePort('4174', 4173).error, '')
})

test('parsePort：边界 1 与 65535 合法，两侧越界都拒绝', () => {
  assert.deepEqual(parsePort('1', 4173), { port: 1, error: '' })
  assert.deepEqual(parsePort('65535', 4173), { port: 65535, error: '' })
  assert.match(parsePort('0', 4173).error, /超出范围/)
  assert.match(parsePort('65536', 4173).error, /超出范围/)
})

test('parsePort：非纯数字一律拒绝并说明错在哪', () => {
  // 这几个都是 Number() 会"宽容"接受的写法，正是要靠正则挡住的：
  // '41 74' → NaN，'0x1051' → 4177，'4174.0' → 4174，'+4174' → 4174
  for (const bad of ['abc', '41 74', '0x1051', '4174.0', '+4174', '4174abc', '-1', '1e3']) {
    const r = parsePort(bad, 4173)
    assert.notEqual(r.error, '', `"${bad}" 应被拒绝，实际得到 ${r.port}`)
    assert.equal(r.port, 4173, '校验失败时必须回落默认值，不能把半成品传下去')
  }
})

test('parsePort：校验失败时 port 回落到传入的 fallback，而不是写死 4173', () => {
  assert.equal(parsePort('abc', 5000).port, 5000)
})

// ---------- alternativePort ----------

test('alternativePort：默认 +1，到顶回落到 4000 避开特权端口', () => {
  assert.equal(alternativePort(4173), 4174)
  assert.equal(alternativePort(65535), 4000)
  assert.equal(alternativePort(65534), 65535)
})

test('alternativePort：输入不合法时给一个可用的默认建议', () => {
  assert.equal(alternativePort(undefined), DEFAULT_LAUNCHER_PORT + 1)
  assert.equal(alternativePort(0), DEFAULT_LAUNCHER_PORT + 1)
  assert.equal(alternativePort(-5), DEFAULT_LAUNCHER_PORT + 1)
})

// ---------- portInUseAdvice ----------

test('portInUseAdvice：说清是谁、怎么查、怎么换，别只说「启动失败」', () => {
  const msg = portInUseAdvice({ port: 4173, platform: 'win32', launcherKind: 'windows' })
  assert.match(msg, /4173/)
  assert.match(msg, /已被占用/)
  assert.match(msg, /netstat -ano \| findstr :4173/, 'Windows 上必须给出能直接复制的排查命令')
  assert.match(msg, /tasklist/, 'netstat 只给 PID，还要说怎么查进程名')
  assert.match(msg, /--port 4174/, '要给出换端口的具体写法，而不是「请更换端口」')
  assert.match(msg, /run-gateway\.cmd 4174/, '双击启动的用户要能看懂改用哪个脚本')
  assert.match(msg, /重新下发/, '换端口会导致已发出去的配置失效，必须提前说')
})

test('portInUseAdvice：unix 平台给 lsof，不提 Windows 命令', () => {
  const msg = portInUseAdvice({ port: 4173, platform: 'darwin', launcherKind: 'unix' })
  assert.match(msg, /lsof -nP -iTCP:4173 -sTCP:LISTEN/)
  assert.doesNotMatch(msg, /netstat/, 'macOS/Linux 上给 netstat 等于没说')
  assert.match(msg, /start-gateway\.sh --port 4174/)
})

test('portInUseAdvice：只有 4173 才提 vite preview，别的端口不能瞎套', () => {
  const at4173 = portInUseAdvice({ port: 4173, platform: 'win32' })
  assert.match(at4173, /vite preview/)
  const at5000 = portInUseAdvice({ port: 5000, platform: 'win32' })
  assert.doesNotMatch(at5000, /4173 正是/, '5000 被占跟 vite preview 无关，套上去是误导')
  assert.match(at5000, /5000/)
  // 排查命令里的端口也必须是真正冲突的那个：写死 4173 时，换过端口的人照着敲什么都查不到
  assert.match(at5000, /findstr :5000/)
  assert.doesNotMatch(at5000, /findstr :4173/)
})

test('portInUseAdvice：局域网模式多一条「接入地址也会变」的提醒', () => {
  const off = portInUseAdvice({ port: 4173, platform: 'linux', lanEnabled: false })
  const on = portInUseAdvice({ port: 4173, platform: 'linux', lanEnabled: true })
  assert.doesNotMatch(off, /局域网/)
  assert.match(on, /局域网/)
  assert.ok(on.length > off.length)
})

test('portInUseAdvice：默认按当前平台选命令（不传 platform 也不能崩）', () => {
  const msg = portInUseAdvice({ port: 4173 })
  assert.match(msg, /已被占用/)
  assert.ok(process.platform === 'win32' ? msg.includes('netstat') : msg.includes('lsof'))
})

// ---------- portPermissionAdvice ----------

test('portPermissionAdvice：解释特权端口并给出可执行的替代方案', () => {
  const msg = portPermissionAdvice({ port: 80 })
  assert.match(msg, /80/)
  assert.match(msg, /1024/)
  assert.match(msg, /--port 4173/)
  assert.match(msg, /Caddy|nginx/, '真想用 80/443 的人要知道正确做法是挂反代')
})

// ---------- launcher 接线（真起一个进程）----------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
}

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-port-'))
  fs.mkdirSync(path.join(dir, '.codex'), { recursive: true })
  return dir
}

function launcherEnv(home, extra = {}) {
  return {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    // 端口相关的用例不需要拉 bridge：不起实例，就只是绑端口、写日志
    DISABLE_AUTOSTART: '1',
    LAUNCHER_PORT: '',
    BRIDGE_PORT: '',
    ...extra
  }
}

test('launcher：端口被占用时以退出码 2 结束，并打出中文诊断', { skip: needRepo }, async () => {
  const port = await freePort()
  const occupied = http.createServer((q, r) => r.end('not-the-gateway'))
  await new Promise((r) => occupied.listen(port, '127.0.0.1', r))
  try {
    const home = tmpHome()
    const r = spawnSync(process.execPath, [LAUNCHER, '--port', String(port)], {
      env: launcherEnv(home),
      encoding: 'utf8',
      timeout: 20000
    })
    assert.equal(r.status, 2, `端口冲突必须以 2 退出（供启动脚本区分原因），实际 ${r.status}\n${r.stderr}`)
    assert.match(r.stderr, new RegExp(`端口 ${port} 已被占用`))
    assert.match(r.stderr, /netstat|lsof/, '要给出排查命令')
    assert.match(r.stderr, new RegExp(`--port ${port + 1}`), '要给出换端口的具体写法')
  } finally {
    await new Promise((r) => occupied.close(r))
  }
})

test('launcher：--port 非法时立刻报错退出，不去绑一个莫名其妙的端口', { skip: needRepo }, () => {
  const home = tmpHome()
  const r = spawnSync(process.execPath, [LAUNCHER, '--port', '41 74'], {
    env: launcherEnv(home),
    encoding: 'utf8',
    timeout: 20000
  })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /端口必须是纯数字/)
})

test('launcher：--port 生效，且不会顺带占住默认的 4173', { skip: needRepo }, async () => {
  const port = await freePort()
  const home = tmpHome()
  const child = spawn(process.execPath, [LAUNCHER, '--port', String(port)], {
    env: launcherEnv(home),
    stdio: 'ignore'
  })
  try {
    // 轮询到起来为止（bridge 没起，所以 /health 会是 503——只要有 HTTP 响应就说明端口通了）
    let status = 0
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      status = await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, (res) => {
          res.resume()
          resolve(res.statusCode)
        })
        req.on('error', () => resolve(0))
        req.on('timeout', () => { req.destroy(); resolve(0) })
      })
      if (status) break
      await new Promise((r) => setTimeout(r, 150))
    }
    assert.ok(status >= 200 && status < 600, `--port ${port} 应该真的在监听，实际状态 ${status}`)
    assert.equal(child.exitCode, null, 'launcher 不该在监听成功后自行退出')
  } finally {
    child.kill()
    await new Promise((r) => setTimeout(r, 300))
  }
})

test('launcher：--bridge-port 也走同一套校验（内部端口写错同样要早失败）', { skip: needRepo }, () => {
  const home = tmpHome()
  const r = spawnSync(process.execPath, [LAUNCHER, '--bridge-port', 'abc'], {
    env: launcherEnv(home),
    encoding: 'utf8',
    timeout: 20000
  })
  assert.equal(r.status, 1)
  assert.match(r.stderr, new RegExp(`bridge 基准端口配置有误`))
})

test('默认端口常量与文档/脚本里的一致', { skip: needRepo }, () => {
  // 这三个字面量在 service/*.vbs、service-unix/*.sh、README 里各出现一次，
  // 任何一处改了这里就会先红，避免「文档说 4173、脚本写 4200」这种漂移。
  assert.equal(DEFAULT_LAUNCHER_PORT, 4173)
  assert.equal(DEFAULT_BRIDGE_PORT, 10531)
  const vbs = fs.readFileSync(path.join(REPO, 'gateway/service/start-gateway.vbs'), 'latin1')
  assert.match(vbs, /ResolvePort = 4173/, '启动脚本的默认端口必须与常量一致')
  const shStop = fs.readFileSync(path.join(REPO, 'gateway/service-unix/stop-gateway.sh'), 'utf8')
  assert.match(shStop, /PORT=4173/, 'unix 停止脚本的默认端口必须与常量一致')
})
