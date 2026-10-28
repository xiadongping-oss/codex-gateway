// 端口解析与占用诊断（纯函数，无 I/O，便于单测）
//
// ---- 为什么需要这个模块 ----
// 4173 不是随手挑的数字：它就是 vite preview 的默认端口。开发机上同时开着
// 前端预览、或者机器上装过另一份网关，撞端口的概率并不低。撞上之后 Node 的
// 默认行为是抛一个未捕获的 EADDRINUSE 把进程掀掉——双击快捷方式启动的用户
// 只看到「8 秒内健康检查未通过，请查日志」，完全不知道发生了什么。
//
// 所以这里只做两件事：
//   1) 把用户/脚本给的端口字符串校验成合法端口（非法就明确说错在哪）；
//   2) 生成一段**能照着做**的诊断文本（谁占着、怎么查、怎么换、换了要付什么代价）。
//
// 刻意不做：自动找空闲端口。端口是对外契约（客户端 baseURL、MCP 配置、防火墙
// 规则、反向代理上游全锚在它上面），静默漂移会让"配置明明没动却连不上"变成
// 无法解释的现象。宁可启动失败并说清原因，也不替用户改契约。

export const DEFAULT_LAUNCHER_PORT = 4173
export const DEFAULT_BRIDGE_PORT = 10531

// 端口合法区间。0 在 Node 里表示"让系统随机分配"，这里**明确拒绝**：
// 随机端口拿不到稳定契约，控制台地址和客户端配置都无法预先确定。
const MIN_PORT = 1
const MAX_PORT = 65535

/**
 * 解析端口。
 * @param {unknown} raw 命令行值或环境变量值（空 / undefined / null 都算"没给"）
 * @param {number} fallback 没给时用的默认端口
 * @returns {{ port: number, error: string }} error 非空表示校验失败，此时 port 回落默认值
 */
export function parsePort(raw, fallback = DEFAULT_LAUNCHER_PORT) {
  if (raw === undefined || raw === null) return { port: fallback, error: '' }
  const s = String(raw).trim()
  if (s === '') return { port: fallback, error: '' }
  // 只认纯十进制数字：拒绝 '4174.0'、'0x1051'、'+4174'、' 41 74'、'4174abc'
  if (!/^\d+$/.test(s)) {
    return { port: fallback, error: `端口必须是纯数字（收到 "${s}"）` }
  }
  const n = Number(s)
  if (!Number.isInteger(n) || n < MIN_PORT || n > MAX_PORT) {
    return { port: fallback, error: `端口 ${s} 超出范围 ${MIN_PORT}-${MAX_PORT}` }
  }
  return { port: n, error: '' }
}

/**
 * 建议的替代端口：默认 +1，到顶了回落到 4000 附近（避开 <1024 的特权端口）。
 * 只作为提示文案里的举例，不会真的自动切换。
 */
export function alternativePort(port) {
  const n = Number(port)
  if (!Number.isInteger(n) || n < MIN_PORT) return DEFAULT_LAUNCHER_PORT + 1
  return n + 1 > MAX_PORT ? 4000 : n + 1
}

// 各平台"查出谁占着这个端口"的命令。Windows 的 netstat 不给进程名，
// 必须再 tasklist 一次，两步都得写出来才真的能用。
function inspectCommand(port, platform) {
  if (platform === 'win32') {
    return [
      `netstat -ano | findstr :${port}`,
      'tasklist /FI "PID eq <上一步最后一列的 PID>"'
    ]
  }
  return [`lsof -nP -iTCP:${port} -sTCP:LISTEN`]
}

/**
 * 生成端口被占用的诊断文本（多行字符串，直接打到 stderr / 日志）。
 * @param {object} opts
 * @param {number} opts.port 冲突的端口
 * @param {string} [opts.platform] 用于选排查命令，默认当前平台（可注入以便测试）
 * @param {'windows'|'unix'} [opts.launcherKind] 启动方式，决定"换端口"那一段怎么写
 * @param {boolean} [opts.lanEnabled] 是否开了局域网模式（影响代价描述）
 */
export function portInUseAdvice({
  port,
  platform = process.platform,
  launcherKind = platform === 'win32' ? 'windows' : 'unix',
  lanEnabled = false
} = {}) {
  const alt = alternativePort(port)
  const cmds = inspectCommand(port, platform)
  const howToChange =
    launcherKind === 'windows'
      ? [
          `· 快捷方式：右键「Codex 网关」→ 属性 → 目标末尾加  --port ${alt}`,
          `· 命令行  ：gateway\\service\\run-gateway.cmd ${alt}`
        ]
      : [
          `· 前台启动：./start-gateway.sh --port ${alt}`,
          `· 开机自启：./install-autostart.sh --port ${alt}（需重新注册一次）`
        ]

  // 原因 2 的举例要跟着端口走：4173 是 vite preview 的默认端口，这是最常撞的一个；
  // 换成别的端口还硬说 vite 就成了误导。
  const likely =
    platform === 'win32'
      ? port === DEFAULT_LAUNCHER_PORT
        ? '4173 正是 vite preview 的默认端口，开着前端预览常会撞上'
        : '常见是 vite preview、另一份网关实例或其它 Web 服务'
      : '常见是 vite preview 或另一份网关实例'

  const lines = [
    `✗ 启动器端口 ${port} 已被占用，本次启动中止。`,
    '',
    '可能的原因：',
    `  1) 网关已经在运行 —— 先试试直接打开 http://127.0.0.1:${port} ，能进控制台就说明不必再启动。`,
    `  2) 别的程序占着这个端口 —— ${likely}。`,
    '',
    '查处占用者：'
  ]
  for (const c of cmds) lines.push('  ' + c)
  lines.push('')
  lines.push(`改用其它端口（以 ${alt} 为例）：`)
  for (const h of howToChange) lines.push('  ' + h)
  lines.push('')
  lines.push('⚠ 换端口前请确认：端口是对外契约。已发给同事的模型配置、MCP 配置、')
  lines.push(`  防火墙规则、反向代理上游都写死了 ${port}，改完需要重新下发一遍。`)
  if (lanEnabled) {
    lines.push('  局域网模式下例外——局域网接入地址也要跟着改，控制台「模型接入」页会同步显示新地址。')
  }
  return lines.join('\n')
}

/**
 * 端口没有权限绑定的诊断（EACCES）。1024 以下在多数系统需要 root/管理员。
 */
export function portPermissionAdvice({ port = DEFAULT_LAUNCHER_PORT } = {}) {
  return [
    `✗ 没有权限监听端口 ${port}。`,
    '',
    '低于 1024 的端口属于特权端口，普通用户无法绑定。请改用高位端口：',
    `  node launcher.mjs --port ${DEFAULT_LAUNCHER_PORT}`,
    '',
    '确实要用 80/443，请在前面挂 Caddy / nginx 反向代理，不要直接改网关端口。'
  ].join('\n')
}
