// /health 的判定口径 —— 单一真源
//
// 为什么需要这个文件：v1.3.0 把「没有运行中的 bridge 实例」时 /health 的
// 状态码从 502 改成 503（这是对的：分得清「还没起来」和「刚崩了」），
// 但判定逻辑当时散落在四处，改一处漏三处，于是同一个语义问题以四种完全
// 不同的面貌冒出来：
//   · run.sh     —— 沙盒永远等不到就绪，整个测试套件起不来
//   · mutate.mjs —— 19 个变异体全部「执行异常」，汇总还把它算成「17 个测试盲区」
//   · pentest.mjs 的 waitReady —— 报「沙盒网关未启动」
//   · pentest.mjs 的 VULN-16    —— 报「超大请求打挂了服务」，其实是判定过时
// 这些故障看起来毫不相关，根因却是同一行判断。
//
// 现在 JS 侧统一从这里取。run.sh 是 bash，共享不了常量，改这里时务必同步
// 那个文件里的就绪轮询（它也有互指注释）。

// 网关进程活着 = 能拿到这三者之一
//   200 有实例且健康 · 502 早期语义下的「无实例」 · 503 当前语义下的「无实例」
export const HEALTH_ALIVE_STATUSES = [200, 502, 503]

export function isAlive(status) {
  return HEALTH_ALIVE_STATUSES.includes(status)
}

// 就绪 = 拿到了**任意** HTTP 响应（哪怕 503）。
// 站在测试框架的角度，503 只说明「网关在跑，但还没有账号登录」——这正是
// 干净沙盒的常态，不能当成启动失败。
export function isReady(status) {
  return typeof status === 'number' && status > 0
}
