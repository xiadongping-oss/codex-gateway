// 参考图（reference_images / reference_paths）的落盘范围约束。
//
// 为什么要这一层：
// vendored bridge 内部其实已经有一道 allowedRoot 校验，但它取的是
// `limits.allowedRoot ?? process.cwd()`，而调用方传的是空 limits —— 于是
// allowedRoot 等于 **bridge 子进程的当前工作目录**。我们 spawn 时若不指定 cwd，
// 它继承的是「用户从哪里启动了网关」：从桌面启动就整个桌面可读，从盘符根目录
// 启动范围更大。这个范围不该由启动姿势决定。
//
// 这里把它收敛成**一个明确的目录**，并让三处达成一致：
//   1) 网关侧（imagesGenProxy / MCP）在转发前按根目录校验 —— 越界一律 400，
//      且错误信息不透露文件是否存在（否则就成了文件存在性探测的 oracle）
//   2) bridge 子进程的 cwd 钉到同一个根目录 —— 它自带的 allowedRoot 跟着确定，
//      即便有人直接打 /v1 绕过网关侧校验，也仍然落在同一个笼子里
//   3) 相对路径统一以根目录为基准解析 —— 两边解析结果才不会分叉
import path from 'node:path'

export const REFERENCES_DIRNAME = 'references'

export function defaultReferenceRoot(gatewayDir) {
  return path.join(gatewayDir, REFERENCES_DIRNAME)
}

// URL / data-URL 不经过本机磁盘，直接放过。
// 这条不能漏：否则把一个 https 链接拿去 path.resolve 会得到荒谬结果并误拒。
export function isRemoteRef(raw) {
  const s = String(raw ?? '').trim()
  return /^https?:\/\//i.test(s) || /^data:/i.test(s)
}

// Windows 文件系统大小写不敏感，比较必须一起降格；
// 前缀比较必须带上分隔符，否则 /refs 会把 /refs-other 也认成自己人。
export function isInsideRoot(resolved, root) {
  const a = path.resolve(String(resolved || ''))
  const b = path.resolve(String(root || ''))
  if (!a || !b) return false
  const eq = (x, y) => (process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y)
  if (eq(a, b)) return true
  const sep = path.sep
  const prefix = b.endsWith(sep) ? b : b + sep
  return process.platform === 'win32'
    ? a.toLowerCase().startsWith(prefix.toLowerCase())
    : a.startsWith(prefix)
}

/**
 * @param {unknown} raw 调用方给的原始条目（字符串或 { path } 对象）
 * @param {string} root 允许的根目录
 * @returns {{ok:true, path?:string, raw?:string, remote?:boolean} | {ok:false, reason:string}}
 */
export function resolveReferencePath(raw, root) {
  const spec = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.path : raw
  const s = String(spec ?? '')
  if (!s.trim()) return { ok: false, reason: 'empty' }
  // NUL 在 Node 的 fs 层会抛异常，但消息里会带上完整路径；在这里挡掉，
  // 顺带避免它被塞进错误信息里回显。
  if (s.includes('\0')) return { ok: false, reason: 'nul' }
  if (isRemoteRef(s)) return { ok: true, raw: s, remote: true }
  const resolved = path.isAbsolute(s) ? path.resolve(s) : path.resolve(root, s)
  if (!isInsideRoot(resolved, root)) return { ok: false, reason: 'outside' }
  return { ok: true, path: resolved }
}

// 一批一起校验。返回首个越界项即可——逐条回显等于替攻击者确认哪些文件存在。
export function checkReferencePaths(list, root) {
  if (!Array.isArray(list) || !list.length) return { ok: true, paths: [] }
  const out = []
  for (const item of list) {
    const r = resolveReferencePath(item, root)
    if (!r.ok) return { ok: false, reason: r.reason }
    out.push(r)
  }
  return { ok: true, paths: out }
}
