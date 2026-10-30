// 凭据文件的落盘权限收紧。
//
// 背景：`fs.writeFileSync(p, data, { mode: 0o600 })` 在 Windows 上**基本无效** ——
// Node 只处理只读属性，ACL 完全不动。实测：
//   请求 mode 0o600 → 实际 mode = 666
// 而这个项目的发布包只有 win64，等于「已收紧到 0600」这条在主平台上从来没生效过。
//
// Windows 上真正有效的是 icacls：去掉继承、只授予当前用户。
// 计划任务是 `schtasks /sc onlogon /rl limited` —— 以登录用户身份运行，
// 所以只授予当前用户不会让开机自启读不到。
//
// 边界说清楚：这防的是「同机其它账户 / 权限从父目录继承下来」，
// 防不住以同一用户身份运行的恶意程序。要做到后者得上 DPAPI（绑用户账户的加密），
// 那是另一档改动，且会牵连 accounts/*.json 里的 OAuth token 一起做才有意义。
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

// 只拼参数、不做 IO —— 便于单元测试与变异测试直接断言形状。
export function icaclsArgsFor(file, user) {
  if (!file || !user) return null
  // /inheritance:r 去掉继承（否则父目录的 Everyone/Users 会继续生效）
  // /grant:r 替换而非追加，只留当前用户
  return [file, '/inheritance:r', '/grant:r', `${user}:F`]
}

export function currentUserForAcl() {
  return process.env.USERNAME || process.env.USER || ''
}

/**
 * 收紧单个文件。同步但只在写盘后调用一次（约 30ms），调用方是低频的配置/凭据写入。
 * 失败一律返回 false，**绝不能因为收紧失败就让写入失败**。
 */
export function hardenSecretFile(file) {
  if (!file) return false
  try {
    if (process.platform === 'win32') {
      const args = icaclsArgsFor(file, currentUserForAcl())
      if (!args) return false
      // 必须带 timeout：icacls 在文件被占用/网络驱动器/ACL 损坏时可能卡住，
      // 而 spawnSync 是同步的 —— 一旦卡住会冻结整个事件循环，网关对外无响应。
      const r = spawnSync('icacls', args, { windowsHide: true, timeout: 5000, killSignal: 'SIGKILL' })
      return r.status === 0
    }
    fs.chmodSync(file, 0o600)
    return true
  } catch {
    return false
  }
}
