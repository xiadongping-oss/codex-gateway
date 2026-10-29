// 原子落盘：本仓库此前存在五套写盘风格，其中三套是裸 `writeFileSync` 覆盖写。
//
// 对 accounts.json 这类「整个注册表的唯一副本」来说，覆盖写是一场赌博：
// 进程在写到一半时被杀（关机、强杀、磁盘满、杀毒软件扫描），文件会留在半截状态。
// 以 accounts.json 为例，后果特别恶劣 —— loadAccounts() 的 catch 会把
// 「JSON 解析失败」静默翻译成「返回空注册表 {activeId:null, accounts:[]}」，
// 于是用户在控制台上看到**所有账号凭空消失**，而界面没有任何报错，
// 又因为 migrateLegacyAuth 只看 reg.accounts.length，重启也不会自动恢复。
//
// tmp + rename 的保证：目标文件要么是一整份旧内容，要么是一整份新内容，
// 绝不存在「写了一半」的中间态。同一分区上的 rename 是原子的。
//
// 另外两处刻意的设计：
//   · tmp 文件名带 pid + 随机串 —— 固定 tmp 名会让并发写互相踩踏；
//   · 失败时 throw —— 旧代码普遍 `catch {}` 吞掉写盘失败，
//     于是「磁盘只读/被占用」时接口照样返回 200 {ok:true}，重启后改动全没了。
//     这里把错误抛回调用方，由它决定是记日志还是让请求失败。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { hardenSecretFile } from './secret-perms.mjs'

// 0o600：这些文件里有 openaiApiKey 之类的明文凭据。
// 旧的 .gw-config.json 用的是默认权限（Windows 上继承目录 ACL，Linux 上 0644）。
//
// 但要清楚这条在 Windows 上**不够**：Node 只处理只读属性，ACL 完全不动
// （实测请求 0600 → 实际 666）。所以落盘之后还要再调 hardenSecretFile()，
// 在 Windows 上用 icacls 真正去掉继承、只留当前用户。
const WRITE_OPTS = { encoding: 'utf-8', mode: 0o600 }

function tmpPathFor(target) {
  const dir = path.dirname(target)
  const base = path.basename(target)
  // 前缀加 '.' 让它看起来像隐藏文件，免得被误当成散落的垃圾文件清掉前夕绊住人
  return path.join(dir, `.${base}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`)
}

/**
 * 原子地把文本写进 target。成功返回 true，失败抛出原始错误。
 */
export function writeTextAtomic(target, text) {
  const dir = path.dirname(target)
  if (dir) fs.mkdirSync(dir, { recursive: true })
  const tmp = tmpPathFor(target)
  try {
    fs.writeFileSync(tmp, text, WRITE_OPTS)
    fs.renameSync(tmp, target)
    // 必须放在 rename 之后：rename 保留的是 tmp 文件的 ACL，
    // 而 tmp 是新建的、继承的是父目录的宽松权限 —— 先收紧再改名的结果会被丢掉。
    // 收紧失败不影响写入结果，所以不接返回值。
    hardenSecretFile(target)
    return true
  } catch (e) {
    // 别把半截的临时文件留在外面，否则下一次重试会撞上脏数据
    try { fs.unlinkSync(tmp) } catch {}
    throw e
  }
}

/**
 * 原子地写入 JSON。默认 2 空格缩进，与项目里其它手写配置的风格保持一致
 * （这些文件是给人看的，用户会直接打开 accounts.json 排查问题）。
 */
export function writeJsonAtomic(target, value, { pretty = true, indent = 2 } = {}) {
  const text = pretty ? JSON.stringify(value, null, indent) : JSON.stringify(value)
  return writeTextAtomic(target, text)
}

/**
 * 带失效判据的文本读取器。
 *
 * 请求路径上的同步磁盘 IO 是本地网关最实在的性能债：一次 GET /__gw/status
 * 会顺带读好几遍 accounts.json（primaryAccountId、bridgeLabel、accountLabel 各自
 * 都调 loadAccounts），前端还 3 秒轮询一次。
 *
 * 这里缓存的是**磁盘那一次 readFileSync**，而不是解析结果 ——
 * parse 仍然每次都做，所以调用方拿到的还是彼此独立的全新对象，
 * 「load 出来的东西随便改不会影响别人」这个既有语义一点没动。
 * 对几百字节的 JSON 来说，parse 的成本远低于一次磁盘读。
 *
 * 失效依据是 size + mtimeMs：用户在外部手工改了文件也能立刻被感知，
 * 不需要等重启。写路径另配 invalidate()，避免同毫秒同长度的极端巧合下用到旧内容。
 */
export function createCachedTextReader(file) {
  let key = null
  let txt = null
  return {
    read() {
      let now
      try {
        const st = fs.statSync(file)
        now = `${st.size}:${st.mtimeMs}`
      } catch {
        now = 'missing'
      }
      if (key !== now) {
        try {
          txt = fs.readFileSync(file, 'utf-8')
        } catch {
          txt = null
        }
        key = now
      }
      return txt
    },
    invalidate() {
      key = null
      txt = null
    }
  }
}

/**
 * 陈旧临时文件清理。上一次被强杀、或者某个工具中断了写流程时，
 * 数据目录里会留下 .xxx.tmp。它们不会被任何逻辑读到，但会随时间累积，
 * 在排障时混进 `ls` 结果里干扰判断。启动时扫一次，清掉超过一天的。
 *
 * 注意只删我们自己写出来的：文件名必须是 `.<目标名>.<pid>.<hex>.tmp` 这个形状。
 *
 * 递归扫描：安装布局下数据根里还有 data/、accounts/ 子目录，tmp 与目标文件
 * 同目录（tmpPathFor 的设计），只扫顶层会漏掉子目录里的残留。
 * 深度上限是防御手段：数据根里不该出现很深的嵌套，真出现了（比如用户把
 * 别的目录挂进来）也不至于整棵遍历拖慢启动。
 */
export function sweepStaleTmpFiles(dir, maxAgeMs = 24 * 60 * 60 * 1000, maxDepth = 3) {
  let removed = 0
  walk(dir, maxDepth)
  return removed

  function walk(current, depth) {
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const full = path.join(current, ent.name)
      if (ent.isDirectory()) {
        if (depth > 1) walk(full, depth - 1)
        continue
      }
      // 形状：.xxx.json.1234.abcdef123456.tmp —— 只认我们自己写出来的那一种。
      // 判据是倒数第三段必须为纯数字 pid、倒数第二段必须为 12 位十六进制，
      // 用户的任何其它 .tmp 文件都通不过，不会仅因为后缀是 .tmp 就被牵连。
      if (!ent.isFile()) continue
      const name = ent.name
      if (!name.startsWith('.') || !name.endsWith('.tmp')) continue
      const parts = name.split('.')
      const pidSeg = parts[parts.length - 3]
      const hexSeg = parts[parts.length - 2]
      if (!/^\d+$/.test(pidSeg) || !/^[0-9a-f]{12}$/.test(hexSeg)) continue
      let st
      try { st = fs.statSync(full) } catch { continue }
      if (!st.isFile() || Date.now() - st.mtimeMs < maxAgeMs) continue
      try { fs.unlinkSync(full); removed += 1 } catch {}
    }
  }
}
