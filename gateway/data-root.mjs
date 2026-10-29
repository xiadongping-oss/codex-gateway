// 数据目录解析 —— 「程序与数据分离」的唯一决策点。
//
// 为什么需要这一层：
//   绿色版的布局是「数据长在程序目录里」（gateway/accounts.json、gateway/data/…），
//   这对解压即用的场景完全够用。但做成正规安装（install-app.vbs 装到
//   %LOCALAPPDATA%\Programs\CodexGateway）后，程序目录变成了「可以整个删掉的
//   软件本体」，账号凭据、API Key、调用日志这些用户数据必须住到别处，
//   否则卸载升级就等于删库。
//
// 设计：
//   1) 唯一入口环境变量 CGW_DATA_DIR，由 run-gateway.cmd 从 service/installed.env
//      读入（install-app.vbs 安装时写入）。所有数据模块统一从 resolveDataRoot 取根。
//   2) 不认相对路径：相对路径会随「用户从哪里启动」漂移，与参考图根目录
//      「不由启动姿势决定」（ref-roots.mjs）是同一条原则。安装器写的必然是
//      绝对路径；收到相对路径说明有人在手工乱设环境变量，按未设置处理最稳。
//   3) 未设置时回退到程序目录 —— 绿色版行为一字不变，已有的测试、
//      开发机源码直跑全部不受影响。
//
// 数据根内的布局与旧 gateway/ 目录保持一致（accounts.json、accounts/、
// data/、api-keys.json、auth.json…），绿色版升级到安装版时迁移数据
// 就是「原样拷贝」，不需要任何格式转换。
import path from 'node:path'
// isInsideRoot 本是参考图的白名单判定，但它做的事就是通用的
// 「解析 + 大小写不敏感（win32）+ 带分隔符前缀」路径归属判断，
// 这里复用它来判断 authFilePath 是否落在程序目录内，避免两套实现将来分叉。
import { isInsideRoot } from './ref-roots.mjs'

export const DATA_DIR_ENV = 'CGW_DATA_DIR'

/**
 * 解析数据根目录。
 * @param {NodeJS.ProcessEnv|string|undefined} env 环境变量对象（测试可注入）
 * @param {string} modDir 程序目录（gateway/），未设置环境变量时的回退值
 */
export function resolveDataRoot(env = process.env, modDir = path.resolve('.')) {
  const raw = String(env?.[DATA_DIR_ENV] ?? '').trim()
  if (!raw) return modDir
  if (!path.isAbsolute(raw)) return modDir
  return path.resolve(raw)
}

/**
 * 是否运行在「安装布局」下（数据与程序已分离）。
 * install-app.vbs 与文档据此区分两种形态。
 */
export function isInstalledLayout(env = process.env) {
  const raw = String(env?.[DATA_DIR_ENV] ?? '').trim()
  return Boolean(raw) && path.isAbsolute(raw)
}

/**
 * 归一化配置里可能过期的 authFilePath（供 auth-core.loadConfig 使用）。
 *
 * .gw-config.json 存的是**写盘那一刻**的绝对路径。绿色版升级成安装版
 * （或日后换数据目录）后，旧值还指着老程序目录 —— 文件本身已经搬进
 * 数据根了，照着旧值读只会「登录态凭空消失」。
 *
 * 规则：authFilePath 若落在**程序目录内**，视为「就是默认值」，
 * 重定向到数据根下的 auth.json；用户显式指到程序目录之外的路径不受影响。
 * 纯函数：programDir / fallback 都显式传入，便于测试与变异验证。
 */
export function normalizeAuthFilePath(p, programDir, fallback) {
  const s = String(p ?? '').trim()
  if (!s) return fallback
  if (isInsideRoot(s, programDir)) return fallback
  return s
}
